import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sealConverterFixture } from '../scripts/lib/sealed-converter-fixture.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-sealed-fixture-'));
  const source = path.join(root, 'source.obj');
  fs.writeFileSync(source, 'synthetic source');
  t.after(() => { if (fs.existsSync(source)) fs.chmodSync(source, 0o600); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, source };
}

test('sealed runtime fixture preserves source identity during read-only consumption', (t) => {
  const { source } = fixture(t);
  const verify = sealConverterFixture([source]);
  assert.equal(fs.readFileSync(source, 'utf8'), 'synthetic source');
  if (process.platform !== 'win32') assert.equal(fs.statSync(source).mode & 0o777, 0o440);
  assert.equal(verify(), 1);
});

test('sealed runtime fixture detects changed content even when length is unchanged', (t) => {
  const { source } = fixture(t);
  const verify = sealConverterFixture([source]);
  fs.chmodSync(source, 0o600);
  fs.writeFileSync(source, 'different source');
  fs.chmodSync(source, 0o440);
  assert.throws(verify, /changed a sealed source/);
});

test('sealed runtime fixture rejects empty input and directory input', (t) => {
  const { root } = fixture(t);
  assert.throws(() => sealConverterFixture([]), /empty/);
  assert.throws(() => sealConverterFixture([root]), /regular file/);
});

test('sealed runtime fixture detects source removal', (t) => {
  const { source } = fixture(t);
  const verify = sealConverterFixture([source]);
  fs.chmodSync(source, 0o600);
  fs.unlinkSync(source);
  assert.throws(verify, { code: 'ENOENT' });
});

test('sealed runtime fixture detects removed read-only protection', (t) => {
  const { source } = fixture(t);
  const verify = sealConverterFixture([source]);
  fs.chmodSync(source, 0o600);
  assert.throws(verify, /changed a sealed source/);
});
