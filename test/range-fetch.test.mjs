import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchAssetArrayBufferByRange, parseContentRange } from '../range-fetch.mjs';

test('content-range parser accepts canonical ranges and rejects inconsistent values', () => {
  assert.deepEqual(parseContentRange('bytes 0-3/10'), { start: 0, end: 3, total: 10 });
  for (const value of ['', 'bytes */10', 'bytes 4-3/10', 'bytes 0-10/10', 'items 0-3/10']) assert.equal(parseContentRange(value), null);
});

test('large asset fetch reconstructs exact bytes from bounded authenticated ranges', async () => {
  const source = Buffer.from('abcdefghijklmnopqrstuvwxyz');
  const requests = [], progress = [];
  const fetchImpl = async (_url, init) => {
    assert.equal(init.credentials, 'same-origin');
    assert.equal(init.cache, 'no-store');
    const match = /^bytes=(\d+)-(\d+)$/.exec(init.headers.Range);
    const start = Number(match[1]), requestedEnd = Number(match[2]), end = Math.min(requestedEnd, source.length - 1);
    requests.push([start, requestedEnd]);
    return new Response(source.subarray(start, end + 1), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${source.length}` } });
  };
  const result = await fetchAssetArrayBufferByRange('/session-assets/token/model/datasets/model.glb', {
    fetchImpl, chunkSize: 7, onProgress: (loaded, total) => progress.push([loaded, total]),
  });
  assert.deepEqual(Buffer.from(result), source);
  assert.deepEqual(requests, [[0, 6], [7, 13], [14, 20], [21, 25]]);
  assert.deepEqual(progress, [[7, 26], [14, 26], [21, 26], [26, 26]]);
});

test('asset fetch supports servers that return the whole file to the initial range', async () => {
  const source = Buffer.from('small glb');
  const result = await fetchAssetArrayBufferByRange('/asset.glb', {
    fetchImpl: async () => new Response(source, { status: 200 }), chunkSize: 4,
  });
  assert.deepEqual(Buffer.from(result), source);
});

test('asset fetch fails closed on a missing or inconsistent response range', async () => {
  await assert.rejects(fetchAssetArrayBufferByRange('/asset.glb', {
    fetchImpl: async () => new Response(Buffer.from('abcd'), { status: 206 }), chunkSize: 4,
  }), { code: 'asset_range_failed' });

  let call = 0;
  await assert.rejects(fetchAssetArrayBufferByRange('/asset.glb', {
    chunkSize: 4,
    fetchImpl: async () => {
      call += 1;
      return call === 1
        ? new Response(Buffer.from('abcd'), { status: 206, headers: { 'Content-Range': 'bytes 0-3/8' } })
        : new Response(Buffer.from('efgh'), { status: 206, headers: { 'Content-Range': 'bytes 5-7/8' } });
    },
  }), { code: 'asset_range_failed' });
});
