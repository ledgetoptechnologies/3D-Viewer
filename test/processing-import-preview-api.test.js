'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const auth = require('../server/auth');
const { openDatabase } = require('../server/database');
const { ViewerRepository } = require('../server/repository');
const { ProcessingRepository } = require('../server/processingRepository');
const { createProcessingApi } = require('../server/processingApi');

test('import preview API normalizes internal statfs fields to the canonical public DTO', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-import-preview-api-'));
  const database = openDatabase(path.join(root, 'viewer.sqlite'));
  const repository = new ViewerRepository(database);
  const processing = new ProcessingRepository(database);
  const token = 'preview-api-test-token-0000000000000000';
  processing.createAdminSession({
    tokenHash: auth.hashToken(token), subject: 'ops:staff-one',
    permissions: ['viewer.datasets.import'], displayUnits: 'imperial',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const internalSpace = { available: 5368709120, total: 10737418240, reserve: 1073741824, required: 1048576, ok: true };
  const storage = {
    previewImport() {
      return {
        rootKey: 'dataset_import', relativePath: 'north-site/flight-2', fileCount: 1, byteSize: 1048576,
        treeFingerprint: 'c'.repeat(64), files: [], truncated: false, sameFilesystem: true,
        destinationSpace: internalSpace,
      };
    },
  };
  const app = express();
  app.use(express.json());
  app.use(createProcessingApi({ repository, processing, storage }));
  const server = await new Promise((resolve) => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/dataset-imports/preview`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': 'preview-request-0001' },
    body: JSON.stringify({ rootKey: 'dataset_import', relativePath: 'north-site/flight-2' }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.preview.destinationSpace, {
    availableBytes: 5368709120, totalBytes: 10737418240, reserveBytes: 1073741824,
    requiredBytes: 1048576, sufficient: true,
  });
  for (const legacy of ['available', 'total', 'reserve', 'required', 'ok'])
    assert.equal(Object.hasOwn(payload.preview.destinationSpace, legacy), false);
  assert.equal(typeof payload.previewToken, 'string');
  assert.equal(Object.hasOwn(payload, 'token'), false);
});
