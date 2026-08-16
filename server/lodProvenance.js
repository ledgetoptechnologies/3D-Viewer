'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const digestCache = new Map();
const AUDIT_ALGORITHM = 'ltds-glb-leaf-equivalence-v1';
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_AUDIT_ARTIFACTS = 100_000;

async function sha256File(filePath) {
  const stat = await fs.promises.stat(filePath);
  const cacheKey = `${path.resolve(filePath)}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
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
    if (stat.size > MAX_MANIFEST_BYTES) throw new Error('manifest exceeds 16 MiB');
    provenance = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
  } catch (error) {
    return { verified: false, errors: [`cannot read provenance: ${error.message}`], provenance: null };
  }

  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) {
    return { verified: false, errors: ['provenance must be an object'], provenance: null };
  }
  if (provenance.schemaVersion !== 2) errors.push('schemaVersion must be 2 (audited leaf equivalence)');
  if (!/^[a-f0-9]{64}$/i.test(String(provenance.sourceSha256 || ''))) {
    errors.push('sourceSha256 must be a SHA-256 digest');
  }
  if (provenance.sourceAsset !== path.basename(fullMeshPath || '')) {
    errors.push('sourceAsset must name the selected full-resolution mesh');
  }
  if (!/\.glb$/i.test(String(provenance.sourceAsset || ''))) {
    errors.push('audited sourceAsset must be a GLB');
  }
  if (provenance.geometry !== 'bounded-triangle-equivalence') {
    errors.push('geometry must be bounded-triangle-equivalence');
  }
  if (provenance.textures !== 'byte-identical-material-equivalence') {
    errors.push('textures must be byte-identical-material-equivalence');
  }
  if (provenance.leafGeometricError !== 0) errors.push('leafGeometricError must be 0');

  const audit = provenance.audit;
  if (!audit || typeof audit !== 'object' || Array.isArray(audit)) {
    errors.push('audit evidence is required');
  } else {
    if (audit.algorithm !== AUDIT_ALGORITHM) errors.push(`audit.algorithm must be ${AUDIT_ALGORITHM}`);
    if (!Number.isFinite(audit.coordinateTolerance) || audit.coordinateTolerance < 0 || audit.coordinateTolerance > 1e-3) {
      errors.push('audit.coordinateTolerance must be between 0 and 0.001');
    }
    if (!Number.isFinite(audit.maxNumericDelta) || audit.maxNumericDelta < 0
      || audit.maxNumericDelta > audit.coordinateTolerance) {
      errors.push('audit.maxNumericDelta must not exceed coordinateTolerance');
    }
    if (!Number.isInteger(audit.triangleCount) || audit.triangleCount < 1) {
      errors.push('audit.triangleCount must be a positive integer');
    }
    if (!/^[a-f0-9]{64}$/i.test(String(audit.equivalenceSha256 || ''))) {
      errors.push('audit.equivalenceSha256 must be a SHA-256 digest');
    }
    if (!Array.isArray(audit.artifacts) || audit.artifacts.length < 2
      || audit.artifacts.length > MAX_AUDIT_ARTIFACTS) {
      errors.push(`audit.artifacts must bind the tileset and between 1 and ${MAX_AUDIT_ARTIFACTS} leaf/dependency files`);
    }
  }

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

  if (errors.length === 0) {
    const derivativeDir = path.resolve(path.dirname(manifestPath));
    const seen = new Set();
    for (const artifact of audit.artifacts) {
      const uri = typeof artifact?.uri === 'string' ? artifact.uri : '';
      const artifactPath = path.resolve(derivativeDir, uri);
      const relative = path.relative(derivativeDir, artifactPath);
      const canonicalUri = relative.split(path.sep).join('/');
      if (!uri || path.isAbsolute(uri) || relative.startsWith('..') || path.isAbsolute(relative)
        || uri.includes('\\') || uri !== canonicalUri) {
        errors.push(`audit artifact path is invalid (${uri || '<empty>'})`);
        continue;
      }
      if (seen.has(uri)) {
        errors.push(`audit artifact is duplicated (${uri})`);
        continue;
      }
      seen.add(uri);
      if (!/^[a-f0-9]{64}$/i.test(String(artifact.sha256 || ''))) {
        errors.push(`audit artifact digest is invalid (${uri})`);
        continue;
      }
      if (!Number.isInteger(artifact.byteLength) || artifact.byteLength < 1) {
        errors.push(`audit artifact byteLength is invalid (${uri})`);
        continue;
      }
      try {
        const stat = await fs.promises.stat(artifactPath);
        if (!stat.isFile() || stat.size !== artifact.byteLength) {
          errors.push(`audit artifact size changed (${uri})`);
          continue;
        }
        const actualDigest = await sha256File(artifactPath);
        if (actualDigest !== artifact.sha256.toLowerCase()) errors.push(`audit artifact digest changed (${uri})`);
      } catch (error) {
        errors.push(`cannot verify audit artifact ${uri}: ${error.message}`);
      }
    }
    if (!seen.has('tileset.json')) errors.push('audit.artifacts must bind tileset.json');
  }

  const sanitized = errors.length === 0 ? {
    schemaVersion: 2,
    sourceAsset: provenance.sourceAsset,
    sourceSha256: provenance.sourceSha256.toLowerCase(),
    geometry: 'bounded-triangle-equivalence',
    textures: 'byte-identical-material-equivalence',
    leafGeometricError: 0,
    audit: {
      algorithm: AUDIT_ALGORITHM,
      coordinateTolerance: audit.coordinateTolerance,
      maxNumericDelta: audit.maxNumericDelta,
      triangleCount: audit.triangleCount,
      equivalenceSha256: audit.equivalenceSha256.toLowerCase(),
      artifactCount: audit.artifacts.length,
    },
  } : null;
  return { verified: errors.length === 0, errors, provenance: sanitized };
}

module.exports = { sha256File, verifyLodProvenance };
