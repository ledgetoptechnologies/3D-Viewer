'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const unzipper = require('unzipper');
const { safeRelativePath } = require('./processingSecurity');

async function extractZipStream(readable, destination, { maxEntries = 100000, maxBytes = 500 * 1024 * 1024 * 1024, workId = crypto.randomUUID(), signal = null } = {}) {
  const incomplete = `${destination}.${String(workId).replace(/[^A-Za-z0-9._-]/g, '_')}.incomplete`;
  fs.rmSync(incomplete, { recursive: true, force: true });
  fs.mkdirSync(incomplete, { recursive: true });
  let entries = 0, bytes = 0;
  try {
    const parser = readable.pipe(unzipper.Parse({ forceStream: true }));
    for await (const entry of parser) {
      if (signal?.aborted) throw Object.assign(new Error('archive extraction cancelled'), { code: 'lease_lost' });
      entries += 1;
      if (entries > maxEntries) throw new Error('archive entry limit exceeded');
      const rel = safeRelativePath(String(entry.path || '').replace(/\/$/, ''));
      if (!rel) throw new Error('archive contains an invalid path');
      const mode = (entry.vars?.externalFileAttributes >>> 16) & 0xffff;
      if ((mode & 0o170000) === 0o120000) throw new Error('archive contains a symbolic link');
      const target = path.join(incomplete, ...rel.split('/'));
      if (entry.type === 'Directory') { fs.mkdirSync(target, { recursive: true }); entry.autodrain(); continue; }
      if (entry.type !== 'File') throw new Error('archive contains an unsupported entry');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      let fileBytes = 0;
      const limiter = new Transform({ transform(chunk, _enc, cb) { fileBytes += chunk.length; bytes += chunk.length; if (bytes > maxBytes) return cb(new Error('archive expansion limit exceeded')); cb(null, chunk); } });
      const streams = [entry, limiter, fs.createWriteStream(target, { flags: 'wx', mode: 0o600 })];
      if (signal) await pipeline(...streams, { signal });
      else await pipeline(...streams);
      if (Number(entry.vars?.uncompressedSize || fileBytes) !== fileBytes) throw new Error('archive entry size mismatch');
    }
    if (signal?.aborted) throw Object.assign(new Error('archive extraction cancelled'), { code: 'lease_lost' });
    if (fs.existsSync(destination)) throw new Error('ingestion destination already exists');
    fs.renameSync(incomplete, destination);
    return { entries, bytes };
  } catch (error) {
    fs.rmSync(incomplete, { recursive: true, force: true });
    throw error;
  }
}

async function extractZipFile(filePath, destination, {
  maxEntries = 100000,
  maxBytes = 500 * 1024 * 1024 * 1024,
  workId = crypto.randomUUID(),
  signal = null,
  onProgress = async () => {},
} = {}) {
  const incomplete = `${destination}.${String(workId).replace(/[^A-Za-z0-9._-]/g, '_')}.incomplete`;
  fs.rmSync(incomplete, { recursive: true, force: true });
  fs.mkdirSync(incomplete, { recursive: true });
  let bytes = 0, completedEntries = 0;
  try {
    const directory = await unzipper.Open.file(filePath), entries = directory.files;
    if (entries.length > maxEntries) throw new Error('archive entry limit exceeded');
    const declared = entries.reduce((sum, entry) => sum + Number(entry.uncompressedSize || 0), 0);
    if (!Number.isSafeInteger(declared) || declared > maxBytes) throw new Error('archive expansion limit exceeded');
    const progress = typeof onProgress === 'function' ? onProgress : async () => {};
    let lastFraction = -1, lastReportedAt = 0;
    const report = async (force = false) => {
      const raw = declared > 0 ? bytes / declared : completedEntries / Math.max(1, entries.length);
      const fraction = force && completedEntries === entries.length ? 1 : Math.max(0, Math.min(0.999, raw));
      const timestamp = Date.now();
      // Keep progress useful without turning every decompression chunk into a
      // database heartbeat. Long extractions still update at most four times
      // per second, and faster ones report in half-percent increments.
      if (!force && lastFraction >= 0 && fraction - lastFraction < 0.005 && timestamp - lastReportedAt < 250) return;
      lastFraction = fraction;
      lastReportedAt = timestamp;
      await progress(fraction, { extractedBytes: bytes, declaredBytes: declared, extractedEntries: completedEntries, totalEntries: entries.length });
    };
    await report();
    const seen = new Set();
    for (const entry of entries) {
      if (signal?.aborted) throw Object.assign(new Error('archive extraction cancelled'), { code: 'lease_lost' });
      const rel = safeRelativePath(String(entry.path || '').replace(/\/$/, ''));
      if (!rel || seen.has(rel.toLowerCase())) throw new Error('archive contains an invalid or duplicate path');
      seen.add(rel.toLowerCase());
      const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
      if ((mode & 0o170000) === 0o120000) throw new Error('archive contains a symbolic link');
      const target = path.join(incomplete, ...rel.split('/'));
      if (entry.type === 'Directory') {
        fs.mkdirSync(target, { recursive: true });
        completedEntries += 1;
        await report();
        continue;
      }
      if (entry.type !== 'File') throw new Error('archive contains an unsupported entry');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      let fileBytes = 0;
      const limiter = new Transform({
        transform(chunk, _enc, callback) {
          fileBytes += chunk.length;
          bytes += chunk.length;
          if (bytes > maxBytes) return callback(new Error('archive expansion limit exceeded'));
          Promise.resolve(report()).then(() => callback(null, chunk), callback);
        },
      });
      const streams = [entry.stream(), limiter, fs.createWriteStream(target, { flags: 'wx', mode: 0o600 })];
      if (signal) await pipeline(...streams, { signal });
      else await pipeline(...streams);
      if (Number(entry.uncompressedSize) !== fileBytes) throw new Error('archive entry size mismatch');
      completedEntries += 1;
      await report();
    }
    if (signal?.aborted) throw Object.assign(new Error('archive extraction cancelled'), { code: 'lease_lost' });
    await report(true);
    if (fs.existsSync(destination)) throw new Error('ingestion destination already exists');
    fs.renameSync(incomplete, destination);
    return { entries: entries.length, bytes };
  } catch (error) {
    fs.rmSync(incomplete, { recursive: true, force: true });
    throw error;
  }
}

module.exports = { extractZipFile, extractZipStream };
