'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const valid = Object.freeze({
  revision: 'a'.repeat(40),
  schema: '18',
  cache: 'no-store',
});
const headers = ({ revision = valid.revision, schema = valid.schema, cache = valid.cache } = {}) => new Headers({
  'X-LTDS-Viewer-Revision': revision,
  'X-LTDS-Viewer-Schema-Version': schema,
  'Cache-Control': cache,
});

test('accepts matching no-store probes at the exact source-derived schema', async () => {
  const { validateRuntimeProbeHeaders } = await import('../scripts/runtime-probe-identity.mjs');
  assert.equal(validateRuntimeProbeHeaders({ healthHeaders: headers(), readyHeaders: headers(), expectedSchemaVersion: 18, bakedRevision: valid.revision }), null);
});

for (const [name, mutate, expected] of [
  ['health cache policy', () => ({ healthHeaders: headers({ cache: 'public, max-age=60' }), readyHeaders: headers() }), /Cache-Control: no-store/],
  ['readiness cache policy', () => ({ healthHeaders: headers(), readyHeaders: headers({ cache: 'private, no-store' }) }), /Cache-Control: no-store/],
  ['older schema', () => ({ healthHeaders: headers({ schema: '17' }), readyHeaders: headers({ schema: '17' }) }), /does not match expected schema version 18/],
  ['newer schema', () => ({ healthHeaders: headers({ schema: '19' }), readyHeaders: headers({ schema: '19' }) }), /does not match expected schema version 18/],
  ['probe disagreement', () => ({ healthHeaders: headers(), readyHeaders: headers({ revision: 'b'.repeat(40) }) }), /do not agree on a valid Viewer revision/],
  ['baked revision mismatch', () => ({ healthHeaders: headers(), readyHeaders: headers(), bakedRevision: 'b'.repeat(40) }), /immutable runtime source identity/],
]) test(`rejects ${name}`, async () => {
  const { validateRuntimeProbeHeaders } = await import('../scripts/runtime-probe-identity.mjs');
  const input = mutate();
  assert.match(validateRuntimeProbeHeaders({ ...input, expectedSchemaVersion: 18, bakedRevision: input.bakedRevision ?? valid.revision }), expected);
});
