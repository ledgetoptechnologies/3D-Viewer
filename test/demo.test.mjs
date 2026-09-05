import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FIXTURE_SHA256, fixturePath, syntheticCloud } from '../fixture-policy.mjs';
import { verifyFixtures } from '../scripts/verify-fixtures.mjs';
import { localRequestAllowed, DEMO_CSP } from '../vite.config.mjs';
import { Vector3, Matrix4 } from 'three';

test('only exact bundled synthetic fixture bytes are allowed', async () => {
  assert.equal(await verifyFixtures(), 3);
  for (const name of Object.keys(FIXTURE_SHA256)) assert.equal(fixturePath(name, 'http://localhost:8080'), name);
  for (const name of ['https://example.com/model.json', '/fixtures/mesh/other.b3dm', '/api/models', '/fixtures/mesh/root.b3dm?token=x']) {
    assert.throws(() => fixturePath(name, 'http://localhost:8080'));
  }
});
test('loopback bind also enforces loopback Host and remote peer', () => {
  const request = (host, remoteAddress) => ({ headers: { host }, socket: { remoteAddress } });
  assert.equal(localRequestAllowed(request('localhost:8080', '127.0.0.1')), true);
  assert.equal(localRequestAllowed(request('evil.example:8080', '127.0.0.1')), false);
  assert.equal(localRequestAllowed(request('localhost:8080', '192.0.2.1')), false);
});
test('embedded KTX2 blob fetch and workers are allowed without dynamic code or remote services', () => {
  const directives = new Map(DEMO_CSP.split(';').map(value => value.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));
  assert.deepEqual(directives.get('connect-src'), ["'self'", 'blob:', 'ws://127.0.0.1:*', 'ws://localhost:*']);
  assert.deepEqual(directives.get('worker-src'), ["'self'", 'blob:']);
  assert.deepEqual(directives.get('script-src'), ["'self'", "'wasm-unsafe-eval'"]);
  assert.equal(DEMO_CSP.includes("'unsafe-eval'"), false);
  assert.equal(DEMO_CSP.includes("'unsafe-inline'"), false);
});
test('synthetic point fixture is deterministic and finite', () => {
  const a = syntheticCloud(), b = syntheticCloud();
  assert.equal(a.positions.length, 10201 * 3);
  assert.deepEqual(a.positions, b.positions);
  assert.equal(a.colors.length, a.positions.length);
  assert.equal([...a.positions, ...a.colors].every(Number.isFinite), true);
});
test('the fixture front faces the camera after B3DM and demo coordinate transforms', async () => {
  const b = await readFile(new URL('../public/fixtures/mesh/LOD-0/Mesh.b3dm', import.meta.url));
  const glb = 28 + b.readUInt32LE(12) + b.readUInt32LE(16) + b.readUInt32LE(20) + b.readUInt32LE(24);
  const jsonLength = b.readUInt32LE(glb + 12);
  const json = JSON.parse(b.subarray(glb + 20, glb + 20 + jsonLength).toString());
  const bin = glb + 28 + jsonLength;
  const primitive = json.meshes[0].primitives[0];
  const positions = json.accessors[primitive.attributes.POSITION];
  const indices = json.accessors[primitive.indices];
  const indexStart = bin + (json.bufferViews[indices.bufferView].byteOffset || 0) + (indices.byteOffset || 0);
  const positionStart = bin + (json.bufferViews[positions.bufferView].byteOffset || 0) + (positions.byteOffset || 0);
  const vertices = [0, 1, 2].map(n => {
    const i = b.readUInt16LE(indexStart + n * 2), p = positionStart + i * 12;
    return new Vector3(b.readFloatLE(p), b.readFloatLE(p + 4), b.readFloatLE(p + 8));
  });
  const normal = vertices[1].clone().sub(vertices[0]).cross(vertices[2].clone().sub(vertices[0])).normalize();
  const b3dmUp = new Matrix4().makeRotationX(Math.PI / 2);
  const demoFrame = new Matrix4().makeRotationX(Math.PI / 2);
  normal.transformDirection(b3dmUp).transformDirection(demoFrame);
  assert.ok(normal.y > 0.99999);
  assert.ok(normal.dot(new Vector3(2.8, 3.2, 3.8)) > 0);
  const bootstrap = await readFile(new URL('../demo.mjs', import.meta.url), 'utf8');
  assert.match(bootstrap, /tiles\.group\.rotation\.x = Math\.PI \/ 2/);
});
test('demo bootstrap has no production service or arbitrary URL input', async () => {
  const main = await readFile(new URL('../demo.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(main, /\/api\/|\/session\/|\/operations\/|location\.search|URLSearchParams|localStorage/);
  assert.match(main, /tiles\.fetchData = verifiedFetch/);
  assert.match(main, /installLodResourceLifecycle/);
});
