'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { openDatabase } = require('../server/database');
const { ViewerRepository } = require('../server/repository');

const SERVICE_SECRET = 'api-v1-test-service-secret-that-is-at-least-32-characters';

async function unusedPort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return port;
}

async function waitFor(baseUrl, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`viewer exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/v1/ready`);
      if (response.ok) return;
    } catch { /* listener is not ready yet */ }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('viewer did not become ready');
}

function signedHeaders(method, requestPath, body = '') {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(24).toString('base64url');
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
  const canonical = ['ltds-viewer-service-v1', method, requestPath, timestamp, nonce, bodyHash].join('\n');
  const signature = crypto.createHmac('sha256', SERVICE_SECRET).update(canonical).digest('base64url');
  return {
    'X-LTDS-Key-Id': 'ops-v1',
    'X-LTDS-Timestamp': String(timestamp),
    'X-LTDS-Nonce': nonce,
    'X-LTDS-Content-SHA256': bodyHash,
    'X-LTDS-Signature': signature,
    ...(body ? { 'Content-Type': 'application/json' } : {}),
  };
}

async function signedFetch(baseUrl, requestPath, { method = 'GET', body = '', headers = {} } = {}) {
  return fetch(`${baseUrl}${requestPath}`, {
    method,
    headers: { ...signedHeaders(method, requestPath, body), ...headers },
    ...(body ? { body } : {}),
  });
}

test('v1 service API redeems a stable cookie-independent scoped browser capability', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-viewer-v1-'));
  const dataDir = path.join(root, 'data');
  const distDir = path.join(root, 'dist');
  const assetRoot = path.join(root, 'assets');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(distDir, { recursive: true });
  fs.mkdirSync(path.join(assetRoot, 'ept', 'ept-data'), { recursive: true });
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html>Viewer session');
  fs.writeFileSync(path.join(distDir, 'admin-login.html'), '<!doctype html>Login');
  fs.writeFileSync(path.join(assetRoot, 'model.glb'), Buffer.from('abcdefghij'));
  fs.writeFileSync(path.join(assetRoot, 'point-cloud.laz'), Buffer.from('raw-laz-points'));
  fs.writeFileSync(path.join(assetRoot, 'ept', 'ept.json'), JSON.stringify({ schema: [], dataType: 'laszip' }));
  fs.writeFileSync(path.join(assetRoot, 'ept', 'ept-data', '0-0-0-0.laz'), Buffer.from('ept-node-points'));
  fs.writeFileSync(path.join(dataDir, 'viewer-projects.json'), JSON.stringify({
    'webodm-4-9': {
      id: 'webodm-4-9',
      webodmProjectId: 4,
      webodmTaskId: 9,
      title: 'API model',
      projectName: 'API project',
      status: 40,
      available: true,
      georef: { rtc: { e: 1, n: 2, z: 3 } },
      assetRoots: { derivatives: assetRoot },
      relAssets: {
        glb: { root: 'derivatives', rel: 'model.glb', format: 'glb' },
        ept: { root: 'derivatives', rel: 'ept/ept.json', format: 'ept' },
        pointCloud: { root: 'derivatives', rel: 'point-cloud.laz', format: 'laz' },
      },
    },
  }));

  const port = await unusedPort();
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(port),
      DATA_DIR: dataDir,
      DIST_DIR: distDir,
      WEBODM_ENABLED: 'false',
      SYNC_ON_STARTUP: 'false',
      ADMIN_PASSWORD: 'api-v1-emergency-admin-password',
      SESSION_SECRET: 'api-v1-test-session-secret-that-is-at-least-32-characters',
      SERVICE_AUTH_KEY_ID: 'ops-v1',
      SERVICE_AUTH_SECRET: SERVICE_SECRET,
      ALLOWED_EMBED_ORIGINS: 'https://ops.example.test,https://client.example.test',
    },
    stdio: 'ignore',
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit');
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitFor(baseUrl, child);

  assert.equal((await fetch(`${baseUrl}/api/v1/models`)).status, 401);
  const catalogResponse = await signedFetch(baseUrl, '/api/v1/models');
  assert.equal(catalogResponse.status, 200);
  const catalog = await catalogResponse.json();
  assert.equal(catalog.models.length, 1);
  const model = catalog.models[0];
  assert.match(model.id, /^[0-9a-f-]{36}$/);

  const disabledRevocationBody = JSON.stringify({
    sourceAuthorization: { type: 'model_association', id: 'association-disabled', version: 1 },
  });
  const disabledRevocation = await signedFetch(baseUrl, '/api/v1/published-sessions/source-authorization', {
    method: 'DELETE', body: disabledRevocationBody, headers: { 'Idempotency-Key': 'source-revoke-disabled-0001' },
  });
  assert.equal(disabledRevocation.status, 503);
  assert.equal(disabledRevocation.headers.get('cache-control'), 'no-store');
  const disabledDatabase = openDatabase(path.join(dataDir, 'viewer.sqlite'));
  assert.equal(disabledDatabase.prepare(
    'SELECT COUNT(*) count FROM service_idempotency WHERE idempotency_key=?',
  ).get('source-revoke-disabled-0001').count, 0, 'disabled route does not reserve an idempotency key');
  disabledDatabase.close();

  const sessionPath = `/api/v1/models/${model.id}/sessions`;
  const incompleteSession = JSON.stringify({ subject: 'client-user-7', audience: 'client' });
  assert.equal((await signedFetch(baseUrl, sessionPath, {
    method: 'POST', body: incompleteSession, headers: { 'Idempotency-Key': 'session-incomplete-0001' },
  })).status, 400);
  const sessionRequest = JSON.stringify({
    subject: 'client-user-7',
    audience: 'client',
    modelVersionId: model.activeVersion.id,
    authorizationExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    permissions: { view: true, measure: false },
  });
  const idempotencyKey = 'session-client-user-7-0001';
  const grantResponse = await signedFetch(baseUrl, sessionPath, {
    method: 'POST', body: sessionRequest, headers: { 'Idempotency-Key': idempotencyKey },
  });
  assert.equal(grantResponse.status, 201);
  assert.equal(grantResponse.headers.get('cache-control'), 'no-store');
  const grant = await grantResponse.json();
  assert.equal(grant.modelVersionId, model.activeVersion.id);
  assert.match(grant.embedUrl, new RegExp(`/session/${grant.grant}$`));
  assert.equal((await fetch(`${baseUrl}/session/${grant.grant}`)).status, 200);
  const replayResponse = await signedFetch(baseUrl, sessionPath, {
    method: 'POST', body: sessionRequest, headers: { 'Idempotency-Key': idempotencyKey },
  });
  assert.equal(replayResponse.status, 201);
  assert.equal(replayResponse.headers.get('idempotency-replayed'), 'true');
  assert.deepEqual(await replayResponse.json(), grant);
  const idempotencyDatabase = openDatabase(path.join(dataDir, 'viewer.sqlite'));
  const storedReplay = idempotencyDatabase.prepare(
    'SELECT response_ciphertext FROM service_idempotency WHERE idempotency_key=?',
  ).get(idempotencyKey);
  idempotencyDatabase.close();
  assert.ok(storedReplay.response_ciphertext);
  assert.ok(!storedReplay.response_ciphertext.includes(grant.grant));
  const conflictingRequest = JSON.stringify({ ...JSON.parse(sessionRequest), subject: 'different-user' });
  assert.equal((await signedFetch(baseUrl, sessionPath, {
    method: 'POST', body: conflictingRequest, headers: { 'Idempotency-Key': idempotencyKey },
  })).status, 409);

  const redemption = await fetch(`${baseUrl}/api/v1/sessions/redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant: grant.grant }),
  });
  assert.equal(redemption.status, 200);
  assert.equal(redemption.headers.get('cache-control'), 'no-store');
  const browserSession = await redemption.json();
  assert.equal(browserSession.model.id, model.id);
  assert.equal(browserSession.permissions.measure, false);
  assert.deepEqual(browserSession.allowedEmbedOrigins, ['https://ops.example.test', 'https://client.example.test']);
  assert.ok(!JSON.stringify(browserSession).includes(SERVICE_SECRET));
  assert.match(browserSession.accessToken, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(browserSession.model.assets.glb.includes(`/session-assets/${browserSession.accessToken}/`));
  assert.equal(browserSession.model.assetByteSizes.glb, null, 'legacy registrations without declared size remain range-loader compatible');
  assert.ok(browserSession.model.assets.ept.includes(`/session-assets/${browserSession.accessToken}/`));
  assert.equal(browserSession.model.assets.pointCloudFormat, 'laz');

  assert.equal((await fetch(`${baseUrl}/api/v1/sessions/redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant: grant.grant }),
  })).status, 410);

  const current = await fetch(`${baseUrl}/api/v1/sessions/current`, {
    headers: { Authorization: `Bearer ${browserSession.accessToken}` },
  });
  assert.equal(current.status, 200);

  const rangedAsset = await fetch(`${baseUrl}${browserSession.model.assets.glb}`, {
    headers: { Range: 'bytes=2-5' },
  });
  assert.equal(rangedAsset.status, 206);
  assert.equal(rangedAsset.headers.get('cache-control'), 'private, no-store');
  assert.equal(await rangedAsset.text(), 'cdef');
  assert.equal((await fetch(`${baseUrl}${browserSession.model.assets.glb.replace(model.id, 'unknown-model')}`)).status, 403);

  // Potree resolves EPT children relative to ept.json. Prove that the stable
  // v1 capability remains in that nested URL and that large point-cloud nodes
  // retain byte-range delivery without relying on a third-party cookie.
  const eptNodeUrl = new URL('ept-data/0-0-0-0.laz', `${baseUrl}${browserSession.model.assets.ept}`).toString();
  const eptNode = await fetch(eptNodeUrl, { headers: { Range: 'bytes=4-7' } });
  assert.equal(eptNode.status, 206);
  assert.equal(eptNode.headers.get('cache-control'), 'private, no-store');
  assert.equal(await eptNode.text(), 'node');

  const directPointCloud = await fetch(`${baseUrl}${browserSession.model.assets.pointCloud}`, {
    headers: { Range: 'bytes=4-6' },
  });
  assert.equal(directPointCloud.status, 206);
  assert.equal(await directPointCloud.text(), 'laz');

  const renewalRequest = JSON.stringify({
    subject: 'client-user-7', audience: 'client', modelVersionId: model.activeVersion.id,
    authorizationExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    permissions: { view: true, measure: true },
  });
  assert.equal((await signedFetch(baseUrl, sessionPath, { method: 'POST', body: renewalRequest })).status, 428);
  const renewalGrantResponse = await signedFetch(baseUrl, sessionPath, {
    method: 'POST', body: renewalRequest, headers: { 'Idempotency-Key': 'session-client-user-7-renewal' },
  });
  const renewalGrant = await renewalGrantResponse.json();
  const renewal = await fetch(`${baseUrl}/api/v1/sessions/redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${browserSession.accessToken}` },
    body: JSON.stringify({ grant: renewalGrant.grant }),
  });
  assert.equal(renewal.status, 200);
  const renewed = await renewal.json();
  assert.equal(renewed.accessToken, browserSession.accessToken);
  assert.equal(renewed.model.assets.glb, browserSession.model.assets.glb);

  const pinnedBody = JSON.stringify({ versionPolicy: 'pinned' });
  const pinned = await signedFetch(baseUrl, `/api/v1/models/${model.id}/shares`, {
    method: 'POST', body: pinnedBody, headers: { 'Idempotency-Key': 'share-pinned-rejected-0001' },
  });
  assert.equal(pinned.status, 422);

  const shareBody = JSON.stringify({ permissions: { view: true, measure: true }, label: 'Client review' });
  const shareResponse = await signedFetch(baseUrl, `/api/v1/models/${model.id}/shares`, {
    method: 'POST', body: shareBody, headers: { 'Idempotency-Key': 'share-client-review-0001' },
  });
  assert.equal(shareResponse.status, 201);
  assert.equal(shareResponse.headers.get('cache-control'), 'no-store');
  const createdShare = await shareResponse.json();
  const publicExchange = await fetch(`${baseUrl}/api/share/${createdShare.token}`);
  assert.equal(publicExchange.status, 200);
  assert.equal(publicExchange.headers.get('cache-control'), 'no-store');
  const publicConfig = await publicExchange.json();
  assert.match(publicConfig.assets.glb, /^\/session-assets\//);
  assert.match(publicConfig.assets.ept, /^\/session-assets\//);
  assert.equal((await fetch(`${baseUrl}${publicConfig.assets.glb}`)).status, 200);
  const publicEptNodeUrl = new URL('ept-data/0-0-0-0.laz', `${baseUrl}${publicConfig.assets.ept}`).toString();
  assert.equal((await fetch(publicEptNodeUrl)).status, 200);

  const revokePath = `/api/v1/shares/${createdShare.share.id}`;
  const revoke = await signedFetch(baseUrl, revokePath, {
    method: 'DELETE', headers: { 'Idempotency-Key': 'share-client-review-revoke-0001' },
  });
  assert.equal(revoke.status, 200);
  assert.equal((await fetch(`${baseUrl}${publicConfig.assets.glb}`)).status, 403);
  assert.equal((await fetch(publicEptNodeUrl)).status, 403);

  const secondShareResponse = await signedFetch(baseUrl, `/api/v1/models/${model.id}/shares`, {
    method: 'POST', body: shareBody, headers: { 'Idempotency-Key': 'share-client-review-0002' },
  });
  const secondShare = await secondShareResponse.json();
  const secondExchange = await fetch(`${baseUrl}/api/share/${secondShare.token}`);
  const secondConfig = await secondExchange.json();
  assert.equal((await fetch(`${baseUrl}${secondConfig.assets.glb}`)).status, 200);
  const externalDatabase = openDatabase(path.join(dataDir, 'viewer.sqlite'));
  new ViewerRepository(externalDatabase).unregisterModel(model.id);
  externalDatabase.close();
  assert.equal((await fetch(`${baseUrl}${secondConfig.assets.glb}`)).status, 403);
});
