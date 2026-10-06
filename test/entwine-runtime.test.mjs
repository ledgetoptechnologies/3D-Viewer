import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { makeEntwineLasFixture, ENTWINE_LOCK_SHA256 } from '../scripts/verify-entwine-runtime.mjs';

test('tiny native Entwine LAS fixture has valid bounded point layout and CRS VLR', () => {
  const b = makeEntwineLasFixture();
  assert.equal(b.subarray(0, 4).toString(), 'LASF');
  assert.equal(b[24], 1); assert.equal(b[25], 2); assert.equal(b[104], 3);
  assert.equal(b.readUInt16LE(94), 227); assert.equal(b.readUInt16LE(105), 34);
  assert.equal(b.readUInt32LE(107), 27); assert.equal(b.readUInt32LE(100), 1);
  const offset = b.readUInt32LE(96);
  assert.equal(b.length, offset + 27 * 34);
  assert.equal(b.readUInt16LE(245), 34735); assert.equal(b.readUInt16LE(311), 32616);
  assert.equal(b.readUInt16LE(319), 9001);
  assert.equal(crypto.createHash('sha256').update(b).digest('hex'),
    'a510603464bbd65f9f9c4fd7c821f7149147f5a8fa7474b5357eaf754d21254f');
});

test('explicit metre height variant adds only VerticalUnitsGeoKey and preserves point bytes', () => {
  const plain = makeEntwineLasFixture(), tagged = makeEntwineLasFixture({ explicitVerticalMetres: true });
  const offset = tagged.readUInt32LE(96);
  assert.equal(tagged.readUInt16LE(247), 48);
  assert.equal(tagged.readUInt16LE(287), 5);
  assert.equal(offset, plain.readUInt32LE(96) + 8);
  assert.equal(tagged.length, offset + 27 * 34);
  const keys = [];
  for (let i = 0; i < tagged.readUInt16LE(287); i++) {
    const start = 289 + i * 8;
    keys.push([0, 2, 4, 6].map(delta => tagged.readUInt16LE(start + delta)));
  }
  assert.deepEqual(keys, [[1024, 0, 1, 1], [1025, 0, 1, 1], [3072, 0, 1, 32616],
    [3076, 0, 1, 9001], [4099, 0, 1, 9001]]);
  assert.equal(keys.some(([key]) => [4096, 4097, 4098].includes(key)), false);
  assert.deepEqual(tagged.subarray(offset), plain.subarray(plain.readUInt32LE(96)));
});

for (const arch of ['amd64', 'arm64']) test(`Entwine ${arch} closure is exact SHA256 locked without foreign binaries`, () => {
  const lock = fs.readFileSync(new URL(`../third_party/entwine/${arch}.lock`, import.meta.url));
  assert.equal(crypto.createHash('sha256').update(lock).digest('hex'), ENTWINE_LOCK_SHA256[arch]);
  const urls = lock.toString().split('\n').filter(line => line.startsWith('https:'));
  assert.equal(urls.length, 67);
  const platform = arch === 'amd64' ? 'linux-64' : 'linux-aarch64';
  for (const line of urls) assert.match(line, new RegExp(`^https://conda\\.anaconda\\.org/conda-forge/(?:${platform}|noarch)/[^/]+\\.conda#[a-f0-9]{64}$`));
  assert.equal(urls.filter(line => line.includes('/entwine-3.2.1-')).length, 1);
  assert.equal(urls.filter(line => line.includes('/libpdal-core-')).length, 1);
  assert.equal(urls.some(line => /\/(python|pdal)-/.test(line)), false);
});

test('image bundles a native converter and exact-image offline sealed smoke gate', () => {
  const docker = fs.readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.match(docker, /mambaorg\/micromamba:2\.3\.3@sha256:800e7ade3ffe29c9a9ac2026163131495f8197c3852e572c5835beb4e8a33cd6/);
  assert.match(docker, /COPY --from=entwine \/opt\/entwine \/opt\/entwine/);
  assert.match(docker, /ENV ENTWINE_BIN=\/opt\/entwine\/bin\/entwine/);
  assert.doesNotMatch(docker, /ENV LD_LIBRARY_PATH/);
  const ci = fs.readFileSync(new URL('../.github/workflows/viewer-image.yml', import.meta.url), 'utf8');
  assert.match(ci, /--network none --read-only --cap-drop ALL --security-opt no-new-privileges[\s\S]{0,180}verify-entwine-runtime\.mjs/);
});
