import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyTileLoadFailure, tileLoadFailureStatus } from '../lod-load-recovery.mjs';

test('tile loader status is recovered from upstream error shapes and messages', () => {
  assert.equal(tileLoadFailureStatus({ error: { status: 403 } }), 403);
  assert.equal(tileLoadFailureStatus({ error: { response: { status: 429 } } }), 429);
  assert.equal(tileLoadFailureStatus({ error: new Error('Failed to fetch tile with HTTP status 503') }), 503);
  assert.equal(tileLoadFailureStatus({ error: new Error('decoder rejected bytes') }), null);
});

test('authorization and transient failures recover while permanent content failures fail closed', () => {
  assert.deepEqual(classifyTileLoadFailure({ error: new Error('Request failed with status 403') }), { kind: 'authorization', status: 403 });
  assert.deepEqual(classifyTileLoadFailure({ error: new Error('HTTP 503 Service Unavailable') }), { kind: 'transient', status: 503 });
  assert.deepEqual(classifyTileLoadFailure({ error: new TypeError('Failed to fetch') }), { kind: 'transient', status: null });
  assert.deepEqual(classifyTileLoadFailure({ error: new Error('Unexpected end of B3DM payload') }), { kind: 'permanent', status: null });
  assert.deepEqual(classifyTileLoadFailure({ error: new Error('HTTP status 404') }), { kind: 'permanent', status: 404 });
});
