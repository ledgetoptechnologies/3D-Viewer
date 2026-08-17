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

test('production Compose publishes only the gated Viewer API on the approved TrueNAS layout', () => {
  const compose = fs.readFileSync(path.join(repositoryRoot, 'docker-compose.yml'), 'utf8');
  const environmentTemplate = fs.readFileSync(path.join(repositoryRoot, '.env.example'), 'utf8');
  const externalNginx = fs.readFileSync(path.join(repositoryRoot, 'deploy', 'nginx-viewer.conf.example'), 'utf8');
  const updateScript = fs.readFileSync(path.join(repositoryRoot, 'scripts', 'update-truenas.sh'), 'utf8');

  assert.match(compose, /\$\{VIEWER_BIND_ADDRESS:-192\.168\.50\.80\}:\$\{VIEWER_PORT:-8088\}:8088/);
  assert.match(compose, /PORT:\s*8088/);
  assert.match(compose, /WEBODM_ENABLED:\s*"false"/);
  assert.match(compose, /env_file:[\s\S]*VIEWER_ENV_FILE:-\/mnt\/Plugins\/App_Data\/Model-Viewer\/Config\/viewer\.env/);
  assert.match(compose, /X_ACCEL_REDIRECT_PREFIX:\s*""/);
  assert.doesNotMatch(compose, /^\s+build:/m);
  assert.match(compose, /pull_policy:\s*always/);
  assert.match(compose, /read_only:\s*true/);
  assert.match(compose, /cap_drop:\s*\[ALL\]/);
  assert.match(compose, /cap_add:\s*\[CHOWN, DAC_OVERRIDE, FOWNER, SETUID, SETGID, SETPCAP\]/);
  assert.doesNotMatch(compose, /^\s+user:/m);
  assert.match(compose, /VIEWER_RUNTIME_UID:\s*\$\{VIEWER_RUNTIME_UID:-1000\}/);
  assert.match(compose, /VIEWER_RUNTIME_GID:\s*\$\{VIEWER_RUNTIME_GID:-1000\}/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /pids_limit:\s*256/);
  assert.match(compose, /\/tmp:rw,noexec,nosuid,nodev,size=256m/);
  assert.match(compose, /max-size:\s*10m/);
  assert.match(compose, /max-file:\s*"3"/);
  assert.match(compose, /\/mnt\/Plugins\/App_Data\/WebODM\/Media:\/imports\/webodm:ro/);
  assert.match(compose, /\/mnt\/Plugins\/App_Data\/Model-Viewer\/Derivatives:\/imports\/legacy-derivatives:ro/);
  assert.match(compose, /\/mnt\/Plugins\/App_Data\/Model-Viewer\/Data:\/app\/data/);
  assert.match(compose, /EMERGENCY_ADMIN_ENABLED:\s+"false"/);
  assert.match(compose, /LOCAL_DERIVATIVES_ENABLED:\s+"false"/);
  assert.match(compose, /viewer-worker:[\s\S]*processing_worker_heartbeat/);
  assert.doesNotMatch(compose, /viewer-worker:[\s\S]*healthcheck:\s*\{disable:\s*true\}/);
  assert.doesNotMatch(compose, /^\s{2}gateway:/m);
  assert.match(compose, /viewer-api:[\s\S]*?ports:\s*\["\$\{VIEWER_BIND_ADDRESS:-192\.168\.50\.80\}:\$\{VIEWER_PORT:-8088\}:8088"\]/);
  assert.match(compose, /setpriv[\s\S]*node scripts\/container-healthcheck\.js/);
  assert.doesNotMatch(compose, /ADMIN_PASSWORD:/);
  assert.doesNotMatch(compose, /SERVICE_AUTH_SECRET:|SESSION_SECRET:|VIEWER_EVENT_SECRET:|PROXY_SHARED_SECRET:/);
  assert.match(environmentTemplate, /^PROXY_SHARED_SECRET=\s*$/m);
  assert.match(environmentTemplate, /TRUST_PROXY_HOPS=1/);
  assert.match(environmentTemplate, /^VIEWER_RUNTIME_UID=1000$/m);
  assert.match(environmentTemplate, /^VIEWER_RUNTIME_GID=1000$/m);
  assert.match(externalNginx, /# proxy_set_header X-Viewer-Proxy-Secret \$viewer_proxy_secret/);
  assert.doesNotMatch(externalNginx.slice(externalNginx.indexOf('    location ')), /proxy_set_header/);
  assert.match(externalNginx, /proxy_set_header X-Forwarded-For \$remote_addr/);
  assert.match(externalNginx, /proxy_set_header X-Real-IP \$remote_addr/);
  assert.match(externalNginx, /proxy_force_ranges on/);
  assert.match(externalNginx, /proxy_cache off/);
  assert.match(externalNginx, /limit_req zone=viewer_share/);
  assert.match(updateScript, /--env-file "\$viewer_config"/);
  assert.match(updateScript, /--profile processing/);
});

test('container entrypoint prepares only managed roots and drops privileges before exec', () => {
  const entrypoint = fs.readFileSync(path.join(repositoryRoot, 'scripts', 'container-entrypoint.sh'), 'utf8');
  const dockerfile = fs.readFileSync(path.join(repositoryRoot, 'Dockerfile'), 'utf8');

  assert.match(dockerfile, /USER root/);
  assert.match(dockerfile, /ENTRYPOINT \["\/app\/scripts\/container-entrypoint\.sh"\]/);
  assert.match(entrypoint, /VIEWER_RUNTIME_UID:-1000/);
  assert.match(entrypoint, /VIEWER_RUNTIME_GID:-1000/);
  assert.match(entrypoint, /\/app\/data/);
  assert.match(entrypoint, /\/imports\/terra/);
  assert.doesNotMatch(entrypoint, /\/imports\/webodm|\/imports\/legacy-derivatives/);
  assert.match(entrypoint, /-L "\$managed_root"/);
  assert.match(entrypoint, /find \/app\/data -xdev -mindepth 1 -maxdepth 1/);
  assert.match(entrypoint, /exec setpriv/);
  assert.match(entrypoint, /--reuid="\$runtime_uid"/);
  assert.match(entrypoint, /--bounding-set=-all/);
  assert.match(entrypoint, /-- "\$@"/);
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

async function waitFor(url, child, init = {}) {
  let lastStatus = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`viewer exited with ${child.exitCode}`);
    try {
      const response = await httpRequest(url, init.headers || {});
      lastStatus = response.status;
      if (response.ok) return response;
    } catch {
      // The listener may not be bound yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`viewer did not become ready (last HTTP ${lastStatus})`);
}

function httpRequest(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({
          ok: response.statusCode >= 200 && response.statusCode < 300,
          status: response.statusCode,
          headers: new Headers(response.headers),
          async json() { return JSON.parse(body); },
          async text() { return body; },
        });
      });
    });
    request.once('error', reject);
  });
}

function requestWithHost(port, host, requestPath = '/', proxySecret = null) {
  return new Promise((resolve, reject) => {
    const headers = { Host: host };
    if (proxySecret) headers['X-Viewer-Proxy-Secret'] = proxySecret;
    const request = http.get({ hostname: '127.0.0.1', port, path: requestPath, headers }, (response) => {
      response.resume();
      response.once('end', () => resolve({ status: response.statusCode, location: response.headers.location || null }));
    });
    request.once('error', reject);
  });
}

test('production gates health/readiness and all routes behind exact proxy host and secret', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-viewer-production-'));
  const distDir = path.join(root, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html>Viewer');
  fs.writeFileSync(path.join(distDir, 'admin-login.html'), '<!doctype html>Login');

  const port = await unusedPort();
  const proxySecret = 'test-proxy-secret-0000000000000000000000000';
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
      PROXY_SHARED_SECRET: proxySecret,
      TRUSTED_PROXY_ADDRESSES: '127.0.0.1/32',
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
  const proxyHeaders = { Host: 'viewer.example.test', 'X-Viewer-Proxy-Secret': proxySecret };
  assert.deepEqual(await (await waitFor(`${baseUrl}/api/v1/ready`, child, { headers: proxyHeaders })).json(), { ok: true, missing: [] });
  assert.equal((await httpRequest(`${baseUrl}/api/v1/health`)).status, 421);
  assert.equal((await httpRequest(`${baseUrl}/api/v1/health`, { Host: 'viewer.example.test' })).status, 403);
  const rejected = await httpRequest(`${baseUrl}/api/v1/health`, { Host: 'viewer.example.test', 'X-Viewer-Proxy-Secret': `${proxySecret}x` });
  assert.equal(rejected.status, 403);
  assert.doesNotMatch(await rejected.text(), /test-proxy-secret/);
  const health = await httpRequest(`${baseUrl}/api/v1/health`, proxyHeaders);
  assert.deepEqual(await health.json(), { ok: true });
  assert.match(
    health.headers.get('content-security-policy') || '',
    /frame-ancestors 'self' https:\/\/ops\.example\.test https:\/\/client\.example\.test/,
  );
  assert.equal(health.headers.get('referrer-policy'), 'no-referrer');

  assert.equal((await requestWithHost(port, 'attacker.example.test', '/', proxySecret)).status, 421);
  assert.deepEqual(await requestWithHost(port, 'viewer.example.test', '/', proxySecret), {
    status: 302,
    location: 'https://ops.example.test',
  });
  assert.deepEqual(await requestWithHost(port, 'viewer.example.test', '/admin-login.html', proxySecret), {
    status: 302,
    location: 'https://ops.example.test',
  });
  assert.equal((await requestWithHost(port, 'viewer.example.test', '/api/admin/session', proxySecret)).status, 404);
});
