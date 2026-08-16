'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const repositoryRoot = path.resolve(__dirname, '..');

test('production Compose pins the approved TrueNAS storage layout', () => {
  const compose = fs.readFileSync(path.join(repositoryRoot, 'docker-compose.yml'), 'utf8');

  assert.match(compose, /\/mnt\/Plugins\/App_Data\/WebODM\/Media:\/mnt\/webodm:ro/);
  assert.match(compose, /\/mnt\/Plugins\/App_Data\/Model-Viewer\/Derivatives:\/mnt\/derivatives:ro/);
  assert.match(compose, /\/mnt\/Plugins\/App_Data\/Model-Viewer\/Data:\/app\/data/);
  assert.match(compose, /EMERGENCY_ADMIN_ENABLED:\s+"false"/);
  assert.doesNotMatch(compose, /ADMIN_PASSWORD:/);
});

async function unusedPort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return port;
}

async function waitFor(url, child) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`viewer exited with ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      // The listener may not be bound yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('viewer did not become ready');
}

function requestWithHost(port, host, requestPath = '/') {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: requestPath, headers: { Host: host } }, (response) => {
      response.resume();
      response.once('end', () => resolve({ status: response.statusCode, location: response.headers.location || null }));
    });
    request.once('error', reject);
  });
}

test('production exposes health/readiness and rejects an unexpected host', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-viewer-production-'));
  const distDir = path.join(root, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html>Viewer');
  fs.writeFileSync(path.join(distDir, 'admin-login.html'), '<!doctype html>Login');

  const port = await unusedPort();
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      DATA_DIR: root,
      DIST_DIR: distDir,
      PUBLIC_BASE_URL: 'https://viewer.example.test',
      EXPECTED_HOST: 'viewer.example.test',
      ALLOWED_EMBED_ORIGINS: 'https://ops.example.test,https://client.example.test',
      OPS_BASE_URL: 'https://ops.example.test',
      WEBODM_ENABLED: 'false',
      SYNC_ON_STARTUP: 'false',
      EMERGENCY_ADMIN_ENABLED: 'false',
      SESSION_SECRET: 'test-session-secret-that-is-at-least-32-characters',
      SERVICE_AUTH_SECRET: 'test-service-secret-that-is-at-least-32-characters',
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
  assert.deepEqual(await (await waitFor(`${baseUrl}/api/v1/ready`, child)).json(), { ok: true, missing: [] });
  const health = await fetch(`${baseUrl}/api/v1/health`);
  assert.deepEqual(await health.json(), { ok: true });
  assert.match(
    health.headers.get('content-security-policy') || '',
    /frame-ancestors 'self' https:\/\/ops\.example\.test https:\/\/client\.example\.test/,
  );
  assert.equal(health.headers.get('referrer-policy'), 'no-referrer');

  assert.equal((await requestWithHost(port, 'attacker.example.test')).status, 421);
  assert.deepEqual(await requestWithHost(port, 'viewer.example.test'), {
    status: 302,
    location: 'https://ops.example.test',
  });
  assert.deepEqual(await requestWithHost(port, 'viewer.example.test', '/admin-login.html'), {
    status: 302,
    location: 'https://ops.example.test',
  });
  assert.equal((await requestWithHost(port, 'viewer.example.test', '/api/admin/session')).status, 404);
});
