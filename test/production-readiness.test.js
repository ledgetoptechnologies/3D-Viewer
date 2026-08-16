'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');

const repositoryRoot = path.resolve(__dirname, '..');

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
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`viewer exited with ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* listener not ready */ }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('viewer did not become ready');
}

test('production readiness verifies the live policy and signed catalog without exposing secrets', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-viewer-readiness-'));
  const dataDir = path.join(root, 'data');
  const distDir = path.join(root, 'dist');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html>Viewer');
  fs.writeFileSync(path.join(distDir, 'admin-login.html'), '<!doctype html>Login');
  const port = await unusedPort();
  const sessionSecret = 'readiness-session-secret-that-is-at-least-32-characters';
  const serviceSecret = 'readiness-service-secret-that-is-at-least-32-characters';
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(port),
    DATA_DIR: dataDir,
    DIST_DIR: distDir,
    PUBLIC_BASE_URL: 'https://viewer.example.test',
    EXPECTED_HOST: 'viewer.example.test',
    ALLOWED_EMBED_ORIGINS: 'https://ops.example.test,https://client.example.test',
    OPS_BASE_URL: 'https://ops.example.test',
    WEBODM_ENABLED: 'false',
    SYNC_ON_STARTUP: 'false',
    EMERGENCY_ADMIN_ENABLED: 'false',
    SESSION_SECRET: sessionSecret,
    SERVICE_AUTH_SECRET: serviceSecret,
    VIEWER_READINESS_BASE_URL: `http://127.0.0.1:${port}`,
  };
  const child = spawn(process.execPath, ['server/index.js'], { cwd: repositoryRoot, env, stdio: 'ignore' });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit');
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  await waitFor(`http://127.0.0.1:${port}/api/v1/ready`, child);

  const result = spawnSync(process.execPath, ['scripts/production-readiness.mjs'], {
    cwd: repositoryRoot,
    env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output, {
    ok: true,
    host: 'viewer.example.test',
    webodmMount: '',
    derivativesMount: null,
    models: 0,
    ready: 0,
    pointCloud: 0,
    lod: 0,
    verifiedLod: 0,
    fullMesh: 0,
  });
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(`${sessionSecret}|${serviceSecret}`));
  const required = spawnSync(process.execPath, ['scripts/production-readiness.mjs', '--require-models'], {
    cwd: repositoryRoot,
    env,
    encoding: 'utf8',
  });
  assert.notEqual(required.status, 0);
  assert.match(required.stderr, /no ready Viewer models were discovered/);
});
