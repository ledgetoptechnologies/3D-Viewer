import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import identityModule from '../server/eptConverterIdentity.js';
import { sealConverterFixture } from './lib/sealed-converter-fixture.mjs';

export const ENTWINE_LOCK_SHA256 = Object.freeze({
  amd64: '506dfc2612b98abb14e9e6c960d41e0c0a6ba14d3a3cf6675a45db5ea39aa938',
  arm64: '9ed422195426d090a0125ebdf040a08cdb7fef363f5b02da536bbd34b72ba566',
});

export function makeEntwineLasFixture() {
  // LAS 1.2 / format 3, with GeoTIFF EPSG:32616 metre coordinates and RGB.
  const count = 27, offset = 227 + 54 + 40;
  const bytes = Buffer.alloc(offset + count * 34);
  bytes.write('LASF'); bytes[24] = 1; bytes[25] = 2;
  bytes.write('LTDS native EPT smoke', 26); bytes.write('LTDS fixture', 58);
  bytes.writeUInt16LE(227, 94); bytes.writeUInt32LE(offset, 96);
  bytes.writeUInt32LE(1, 100); bytes[104] = 3;
  bytes.writeUInt16LE(34, 105); bytes.writeUInt32LE(count, 107); bytes.writeUInt32LE(count, 111);
  for (let axis = 0; axis < 3; axis++) bytes.writeDoubleLE(0.01, 131 + axis * 8);
  [500000, 4800000, 100].forEach((v, i) => bytes.writeDoubleLE(v, 155 + i * 8));
  [500002, 500000, 4800002, 4800000, 102, 100].forEach((v, i) => bytes.writeDoubleLE(v, 179 + i * 8));
  bytes.write('LASF_Projection', 229); bytes.writeUInt16LE(34735, 245); bytes.writeUInt16LE(40, 247);
  [1, 1, 0, 4, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 32616, 3076, 0, 1, 9001]
    .forEach((v, i) => bytes.writeUInt16LE(v, 281 + i * 2));
  let index = 0;
  for (let x = 0; x < 3; x++) for (let y = 0; y < 3; y++) for (let z = 0; z < 3; z++) {
    const start = offset + index++ * 34;
    [x, y, z].forEach((v, i) => bytes.writeInt32LE(v * 100, start + i * 4));
    bytes[start + 14] = 9; bytes[start + 15] = 2;
    [10000 + x * 1000, 20000 + y * 1000, 30000 + z * 1000]
      .forEach((v, i) => bytes.writeUInt16LE(v, start + 28 + i * 2));
  }
  return bytes;
}

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function run(bin, args, options = {}) {
  const child = spawnSync(bin, args, { encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024,
    env: { ...process.env, PROJ_NETWORK: 'OFF' }, ...options });
  assert.ifError(child.error);
  assert.equal(child.status, 0, `${path.basename(bin)} failed: ${child.stderr || child.stdout}`);
  return child.stdout;
}

export async function verifyEntwineRuntime() {
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 568); assert.equal(process.getgid(), 568);
  assert.ok(['x64', 'arm64'].includes(process.arch));
  const bin = process.env.ENTWINE_BIN || '/opt/entwine/bin/entwine';
  const info = JSON.parse(fs.readFileSync('/opt/entwine/build-info.json', 'utf8'));
  assert.equal(info.version, '3.2.1'); assert.equal(info.architecture, process.arch === 'x64' ? 'amd64' : 'arm64');
  assert.equal(info.schemaVersion, 1);
  assert.equal(info.lockSha256, ENTWINE_LOCK_SHA256[info.architecture]);
  assert.equal(info.binarySha256, digest(fs.readFileSync(bin)));
  const notices = '/opt/entwine/third-party-notices';
  const packages = fs.readdirSync(notices);
  assert.equal(packages.length, 67);
  const entwineNotice = packages.find(name => name.startsWith('entwine-3.2.1-'));
  assert.ok(entwineNotice);
  assert.ok(fs.readdirSync(path.join(notices, entwineNotice, 'licenses')).length > 0);
  const identity = await identityModule.captureEptConverterIdentity(bin);
  assert.equal(identity.version, 'Entwine 3.2.1');
  assert.doesNotMatch(run('ldd', [bin]), /not found/);
  const pdal = '/opt/entwine/bin/pdal';
  assert.doesNotMatch(run('ldd', [pdal]), /not found/);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-entwine-runtime-'));
  try {
    const las = path.join(scratch, 'source.las'), laz = path.join(scratch, 'source.laz');
    fs.writeFileSync(las, makeEntwineLasFixture());
    run(pdal, ['translate', las, laz, '--writers.las.compression=true']);
    const unchanged = sealConverterFixture([las, laz]);
    const outputs = [];
    for (const source of [las, laz]) {
      const out = path.join(scratch, path.extname(source).slice(1));
      // Exactly the worker's supported conversion contract; no reprojection.
      run(bin, ['build', '-i', source, '-o', out]);
      const ept = JSON.parse(fs.readFileSync(path.join(out, 'ept.json'), 'utf8'));
      assert.equal(ept.points, 27); assert.equal(ept.dataType, 'laszip');
      assert.equal(Number(ept.srs.horizontal), 32616);
      const csv = path.join(scratch, `${path.basename(out)}.csv`);
      run(pdal, ['pipeline', '--stdin'], { input: JSON.stringify({ pipeline: [
        { type: 'readers.ept', filename: path.join(out, 'ept.json') },
        { type: 'writers.text', filename: csv, format: 'csv', order: 'X,Y,Z,Red,Green,Blue,Classification',
          keep_unspecified: false, precision: 6 },
      ] }) });
      const actual = fs.readFileSync(csv, 'utf8').trim().split(/\r?\n/).slice(1).map(line => line.split(',').map(Number));
      assert.equal(actual.length, 27);
      const expected = [];
      for (let x = 0; x < 3; x++) for (let y = 0; y < 3; y++) for (let z = 0; z < 3; z++)
        expected.push([500000 + x, 4800000 + y, 100 + z, 10000 + x * 1000, 20000 + y * 1000, 30000 + z * 1000, 2]);
      assert.deepEqual(actual.map(JSON.stringify).sort(), expected.map(JSON.stringify).sort());
      assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'ept-hierarchy', '0-0-0-0.json'), 'utf8'))['0-0-0-0'], 27);
      outputs.push({ sourceType: path.extname(source).slice(1), points: ept.points,
        sourceSha256: digest(fs.readFileSync(source)), horizontalCrs: ept.srs.horizontal });
      unchanged();
      await identityModule.assertEptConverterIdentity(identity);
    }
    return { ok: true, architecture: info.architecture, version: identity.version,
      binarySha256: info.binarySha256, lockSha256: info.lockSha256, sealedInputs: unchanged(), outputs };
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await verifyEntwineRuntime()));
}
