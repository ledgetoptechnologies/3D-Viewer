'use strict';

// Capture tags are observations from untrusted source bytes, not declarations
// about the reconstructed output's CRS, vertical datum or surveyed accuracy.
// Preserve originals separately; this bounded summary never changes a photo.
const MAX_HEADER_BYTES = 256 * 1024;
const XMP_PREFIX = 'http://ns.adobe.com/xap/1.0/\0';
const DJI_NAMESPACE = 'http://www.dji.com/drone-dji/1.0/';
const NUMERIC_TAGS = Object.freeze([
  'AbsoluteAltitude', 'RelativeAltitude', 'GpsLatitude', 'GpsLongitude',
  'RtkFlag', 'RtkStdLat', 'RtkStdLon', 'RtkStdHgt',
]);

function parsePhotoCaptureMetadata(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4 || buffer.length > MAX_HEADER_BYTES
    || buffer.readUInt16BE(0) !== 0xffd8) return null;
  const camera = {}, djiTags = {}, conflicts = new Set(), warnings = new Set();
  const record = (target, key, value) => {
    if (conflicts.has(key)) return;
    if (Object.hasOwn(target, key) && target[key] !== value) {
      delete target[key]; conflicts.add(key);
    } else target[key] = value;
  };
  let offset = 2;
  while (offset + 2 <= buffer.length) {
    if (buffer[offset++] !== 0xff) break;
    while (offset < buffer.length && buffer[offset] === 0xff) offset++;
    if (offset >= buffer.length) break;
    const marker = buffer[offset++];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 1 || marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;
    const payload = buffer.subarray(offset + 2, offset + length);
    offset += length;
    if (marker !== 0xe1) continue;
    if (payload.subarray(0, 6).toString('ascii') === 'Exif\0\0') {
      try { readCamera(payload.subarray(6), (key, value) => record(camera, key, value)); }
      catch { warnings.add('malformed-exif'); }
    } else if (payload.subarray(0, XMP_PREFIX.length).toString('ascii') === XMP_PREFIX) {
      const xml = payload.subarray(XMP_PREFIX.length).toString('utf8');
      // No XML execution, entity resolution, extended-XMP reconstruction or
      // arbitrary namespace assumptions. Unsupported forms remain in originals.
      if (/<!DOCTYPE|<!ENTITY/i.test(xml)) { warnings.add('unsupported-xmp-entities'); continue; }
      const namespaces = [...xml.matchAll(/xmlns:([A-Za-z_][\w.-]*)\s*=\s*["']([^"']+)["']/g)]
        .filter(match => match[2] === DJI_NAMESPACE).map(match => match[1]);
      for (const prefix of new Set(namespaces)) {
        const safePrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        for (const tag of NUMERIC_TAGS) {
          const qualified = `${safePrefix}:${tag}`;
          const attributes = new RegExp(`(?:\\s)${qualified}\\s*=\\s*["']([^"']{0,128})["']`, 'g');
          const elements = new RegExp(`<${qualified}\\s*>\\s*([^<]{0,128})\\s*</${qualified}\\s*>`, 'g');
          for (const match of [...xml.matchAll(attributes), ...xml.matchAll(elements)]) {
            const value = match[1].trim();
            if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)
              || !Number.isFinite(Number(value))) { warnings.add(`invalid-${tag}`); continue; }
            // Retain exact spelling/precision. Tag names do not establish the
            // final model's height reference or the meaning of a fix code.
            record(djiTags, tag, value);
          }
        }
      }
    }
  }
  if (!Object.keys(camera).length && !Object.keys(djiTags).length && !conflicts.size && !warnings.size) return null;
  return {
    schemaVersion: 1, basis: 'source-photo-tags', verification: 'unverified',
    verticalDatum: 'unknown', accuracy: 'not-established',
    ...(Object.keys(camera).length ? { camera } : {}),
    ...(Object.keys(djiTags).length ? { djiTags } : {}),
    ...(conflicts.size ? { conflictingTags: [...conflicts].sort() } : {}),
    ...(warnings.size ? { warnings: [...warnings].sort() } : {}),
  };
}

function readCamera(tiff, record) {
  const little = tiff.subarray(0, 2).toString('ascii') === 'II';
  if (!little && tiff.subarray(0, 2).toString('ascii') !== 'MM') throw new Error('byte order');
  const bounds = (at, size) => { if (!Number.isSafeInteger(at) || at < 0 || at + size > tiff.length) throw new Error('bounds'); };
  const u16 = at => { bounds(at, 2); return little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at); };
  const u32 = at => { bounds(at, 4); return little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at); };
  if (u16(2) !== 42) throw new Error('TIFF');
  const at = u32(4), count = u16(at);
  if (count > 256) throw new Error('IFD count');
  bounds(at + 2, count * 12 + 4);
  for (let index = 0; index < count; index++) {
    const entry = at + 2 + index * 12, tag = u16(entry);
    if (![0x010f, 0x0110].includes(tag) || u16(entry + 2) !== 2) continue;
    const size = u32(entry + 4);
    if (size < 1 || size > 256) continue;
    const data = size <= 4 ? entry + 8 : u32(entry + 8);
    bounds(data, size);
    const text = tiff.subarray(data, data + size).toString('utf8').replace(/\0+$/, '').trim();
    if (text && !/[\x00-\x1f\x7f]/.test(text)) record(tag === 0x010f ? 'make' : 'model', text);
  }
}

module.exports = { parsePhotoCaptureMetadata, MAX_HEADER_BYTES };
