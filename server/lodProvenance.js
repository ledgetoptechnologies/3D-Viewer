'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const digestCache = new Map();

async function sha256File(filePath) {
  const stat = await fs.promises.stat(filePath);
  const cacheKey = `${path.resolve(filePath)}:${stat.size}:${stat.mtimeMs}`;
  if (digestCache.has(cacheKey)) return digestCache.get(cacheKey);

  const digest = await new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
  digestCache.set(cacheKey, digest);
  return digest;
}

async function verifyLodProvenance(manifestPath, fullMeshPath) {
  const errors = [];
  let provenance;
  try {
    const stat = await fs.promises.stat(manifestPath);
    if (stat.size > 64 * 1024) throw new Error('manifest exceeds 64 KiB');
    provenance = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
  } catch (error) {
    return { verified: false, errors: [`cannot read provenance: ${error.message}`], provenance: null };
  }

  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) {
    return { verified: false, errors: ['provenance must be an object'], provenance: null };
  }
  if (provenance.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (!/^[a-f0-9]{64}$/i.test(String(provenance.sourceSha256 || ''))) {
    errors.push('sourceSha256 must be a SHA-256 digest');
  }
  if (provenance.sourceAsset !== path.basename(fullMeshPath || '')) {
    errors.push('sourceAsset must name the selected full-resolution mesh');
  }
  if (provenance.geometry !== 'preserved') errors.push('geometry must be preserved');
  if (provenance.textures !== 'preserved') errors.push('textures must be preserved');
  if (provenance.leafGeometricError !== 0) errors.push('leafGeometricError must be 0');

  if (errors.length === 0) {
    try {
      const actualDigest = await sha256File(fullMeshPath);
      if (actualDigest !== provenance.sourceSha256.toLowerCase()) {
        errors.push('sourceSha256 does not match the selected full-resolution mesh');
      }
    } catch (error) {
      errors.push(`cannot hash full-resolution mesh: ${error.message}`);
    }
  }

  const sanitized = errors.length === 0 ? {
    schemaVersion: 1,
    sourceAsset: provenance.sourceAsset,
    sourceSha256: provenance.sourceSha256.toLowerCase(),
    geometry: 'preserved',
    textures: 'preserved',
    leafGeometricError: 0,
  } : null;
  return { verified: errors.length === 0, errors, provenance: sanitized };
}

module.exports = { sha256File, verifyLodProvenance };
