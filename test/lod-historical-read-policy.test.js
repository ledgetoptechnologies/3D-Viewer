'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const policy = require('../lod-converter-policy.cjs');

test('historical bounded contracts preserve their exact accepted fingerprints', () => {
  for (const contract of policy.HISTORICAL_READ_CONVERTER_CONTRACTS) {
    assert.equal(crypto.createHash('sha256').update(policy.stable(contract.converter)).digest('hex'), contract.commandSha256);
    const converter = {...contract.converter, commandSha256: contract.commandSha256,
      binarySha256: policy.HISTORICAL_BOUNDED_BINARY_SHA256};
    assert.equal(policy.acceptedReadConverterContract(converter), true);
    assert.equal(policy.acceptedReadConverterIdentity(converter), true);
    assert.equal(policy.acceptedReadConverterContract({...converter, arguments: []}), false);
    assert.equal(policy.acceptedReadConverterContract({...converter, fork: {...converter.fork, patchSha256: 'a'.repeat(64)}}), false);
    assert.equal(policy.acceptedReadConverterIdentity({...converter, binarySha256: 'a'.repeat(64)}), false);
    assert.equal(policy.acceptedReadConverterIdentity({...converter, commandSha256: 'a'.repeat(64)}), false);
  }
});

test('historical binary trust does not authorize unrelated legacy or current generation identities', () => {
  const oldBinary = policy.HISTORICAL_BOUNDED_BINARY_SHA256;
  const runtime = policy.runtimeForkBuildInfo();
  assert.equal(policy.CONTROLLED_CONVERTER_BINARY_SHA256.includes(oldBinary), runtime?.binarySha256 === oldBinary);
  assert.equal(policy.acceptedReadConverterIdentity({...policy.LEGACY_KTX2_CONVERTER,
    commandSha256: policy.LEGACY_KTX2_CONVERTER_COMMAND_SHA256, binarySha256: oldBinary}), false);
  if (policy.OBJ2TILES_PATCH_SHA256 !== policy.HISTORICAL_READ_CONVERTER_CONTRACTS[0].converter.fork.patchSha256) {
    assert.equal(policy.acceptedReadConverterIdentity({...policy.CONTROLLED_CONVERTER,
      commandSha256: policy.CONTROLLED_CONVERTER_COMMAND_SHA256, binarySha256: oldBinary}), false);
    for (const contract of policy.HISTORICAL_READ_CONVERTER_CONTRACTS) {
      assert.equal(policy.ACCEPTED_CONTROLLED_CONVERTER_COMMAND_SHA256.includes(contract.commandSha256), false);
      for (const binary of policy.CONTROLLED_CONVERTER_BINARY_SHA256) {
        assert.equal(policy.acceptedReadConverterIdentity({...contract.converter,
          commandSha256: contract.commandSha256, binarySha256: binary}), false);
      }
    }
  }
  const worker = fs.readFileSync(path.join(__dirname, '../server/derivativeWorker.js'), 'utf8');
  assert.match(worker, /\[CONTROLLED_CONVERTER_COMMAND_SHA256, SERIAL_RETRY_CONVERTER_COMMAND_SHA256\]\s*\.includes\(existing\.provenance\?\.converter\?\.commandSha256\)/);
  assert.doesNotMatch(worker, /HISTORICAL_READ_CONVERTER_CONTRACTS|acceptedReadConverterIdentity/);
});
