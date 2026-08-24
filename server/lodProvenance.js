'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const digestCache = new Map();
const AUDIT_ALGORITHM = 'ltds-glb-leaf-equivalence-v2';
const CONTROLLED_AUDIT_ALGORITHM = 'ltds-obj2tiles-surface-equivalence-v3';
const CONTROLLED_CONVERTER = Object.freeze({
  name: 'OpenDroneMap/Obj2Tiles',
  version: '1.6.2',
  arguments: ['--octree', '--lods', '3', '--divisions', '2', '--lod-texture-scale', '0.5', '--local', '<source.obj>', '<output>'],
});
const CONTROLLED_CONVERTER_BINARY_SHA256 = new Set([
  '40adc90db9f019d1d976badc1733a5acc69d43cd1db34bf0ebc823f554188274',
  'c54dbcbe953640f2aa0e7c2568709108a97063dac492781c9560a5042e46d9b1',
]);
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_AUDIT_ARTIFACTS = 100_000;

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

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
  const exactV2 = provenance.schemaVersion === 2 && provenance.audit?.algorithm === AUDIT_ALGORITHM;
  const controlledV3 = provenance.schemaVersion === 3 && provenance.audit?.algorithm === CONTROLLED_AUDIT_ALGORITHM;
  if (!exactV2 && !controlledV3) errors.push('provenance must use exact v2 or controlled Obj2Tiles v3 audit evidence');
  if (!/^[a-f0-9]{64}$/i.test(String(provenance.sourceSha256 || ''))) {
    errors.push('sourceSha256 must be a SHA-256 digest');
  }
  if (provenance.sourceAsset !== path.basename(fullMeshPath || '')) {
    errors.push('sourceAsset must name the selected full-resolution mesh');
  }
  if (!/\.glb$/i.test(String(provenance.sourceAsset || ''))) {
    errors.push('audited sourceAsset must be a GLB');
  }
  const expectedGeometry = controlledV3 ? 'controlled-bidirectional-surface-equivalence' : 'bounded-triangle-equivalence';
  const expectedTextures = controlledV3 ? 'controlled-atlas-material-equivalence' : 'byte-identical-material-equivalence';
  if (provenance.geometry !== expectedGeometry) errors.push(`geometry must be ${expectedGeometry}`);
  if (provenance.textures !== expectedTextures) errors.push(`textures must be ${expectedTextures}`);
  if (provenance.leafGeometricError !== 0) errors.push('leafGeometricError must be 0');

  const audit = provenance.audit;
  if (!audit || typeof audit !== 'object' || Array.isArray(audit)) {
    errors.push('audit evidence is required');
  } else {
    if (exactV2) {
      if (!Number.isFinite(audit.coordinateTolerance) || audit.coordinateTolerance < 0 || audit.coordinateTolerance > 1e-3) errors.push('audit.coordinateTolerance must be between 0 and 0.001');
      if (!Number.isFinite(audit.maxNumericDelta) || audit.maxNumericDelta < 0 || audit.maxNumericDelta > audit.coordinateTolerance) errors.push('audit.maxNumericDelta must not exceed coordinateTolerance');
      if (!Number.isInteger(audit.triangleCount) || audit.triangleCount < 1) errors.push('audit.triangleCount must be a positive integer');
      const hasLeafCounts = audit.leafTriangleCount !== undefined || audit.duplicateLeafTriangleCount !== undefined;
      if (hasLeafCounts && (!Number.isInteger(audit.leafTriangleCount) || audit.leafTriangleCount < audit.triangleCount)) errors.push('audit.leafTriangleCount must be an integer no smaller than triangleCount');
      if (hasLeafCounts && (!Number.isInteger(audit.duplicateLeafTriangleCount) || audit.duplicateLeafTriangleCount < 0 || audit.duplicateLeafTriangleCount !== audit.leafTriangleCount - audit.triangleCount)) errors.push('audit.duplicateLeafTriangleCount must match the bounded leaf overlap');
    } else if (controlledV3) {
      const converter = provenance.converter;
      const expectedCommandSha256 = sha256(stable(CONTROLLED_CONVERTER));
      if (!converter || converter.name !== CONTROLLED_CONVERTER.name || converter.version !== CONTROLLED_CONVERTER.version
        || stable(converter.arguments) !== stable(CONTROLLED_CONVERTER.arguments)
        || converter.commandSha256 !== expectedCommandSha256) errors.push('converter must match the pinned Obj2Tiles command contract');
      for (const [key, value] of [['converter.inputSha256', converter?.inputSha256], ['converter.binarySha256', converter?.binarySha256]]) {
        if (!/^[a-f0-9]{64}$/i.test(String(value || ''))) errors.push(`${key} must be a SHA-256 digest`);
      }
      if (!CONTROLLED_CONVERTER_BINARY_SHA256.has(String(converter?.binarySha256 || '').toLowerCase())) errors.push('converter.binarySha256 must match an approved Obj2Tiles 1.6.2 executable');
      if (!/\.obj$/i.test(String(converter?.inputAsset || '')) || path.basename(converter?.inputAsset || '') !== converter?.inputAsset) errors.push('converter.inputAsset must name the exact OBJ input');
      if (!Number.isInteger(audit.sourceTriangleCount) || audit.sourceTriangleCount < 1 || !Number.isInteger(audit.leafTriangleCount) || audit.leafTriangleCount < 1) errors.push('controlled audit triangle counts must be positive integers');
      if (!Number.isFinite(audit.surfaceTolerance) || audit.surfaceTolerance <= 0 || !Number.isFinite(audit.diagonal) || audit.diagonal <= 0 || audit.surfaceTolerance > audit.diagonal * 1e-3) errors.push('controlled audit surface tolerance is invalid');
      for (const key of ['boundsDelta', 'areaRelativeDelta', 'centroidDelta', 'normalizedSecondMomentDelta']) if (!Number.isFinite(audit[key]) || audit[key] < 0) errors.push(`controlled audit ${key} is invalid`);
      if (audit.boundsDelta > audit.surfaceTolerance || audit.centroidDelta > audit.surfaceTolerance || audit.areaRelativeDelta > 1e-5 || audit.normalizedSecondMomentDelta > 2e-5) errors.push('controlled audit aggregate surface evidence exceeds policy');
      for (const key of ['sourceToLeaves', 'leavesToSource']) {
        const direction = audit[key];
        if (!Number.isInteger(direction?.sampleCount) || direction.sampleCount < 4 || !Number.isFinite(direction.maximumDistance) || direction.maximumDistance < 0 || direction.maximumDistance > audit.surfaceTolerance || !Number.isFinite(direction.minimumNormalDot) || !Number.isInteger(direction.reversedNormalSampleCount) || direction.reversedNormalSampleCount < 0 || direction.reversedNormalSampleCount > direction.sampleCount || !Number.isFinite(direction.reversedNormalFraction) || direction.reversedNormalFraction < 0 || direction.reversedNormalFraction > 0.01 || Math.abs(direction.reversedNormalFraction - direction.reversedNormalSampleCount / direction.sampleCount) > 1e-12) errors.push(`controlled audit ${key} evidence is invalid`);
      }
      for (const key of ['sourceRender', 'leafRender']) {
        const render = audit[key];
        if (!Number.isInteger(render?.triangleCount) || render.triangleCount < 1 || render.texturedTriangleCount !== render.triangleCount || render.uvTriangleCount !== render.triangleCount || !Number.isInteger(render.normalTriangleCount) || render.normalTriangleCount < 0 || render.normalTriangleCount > render.triangleCount) errors.push(`controlled audit ${key} coverage is invalid`);
      }
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
    schemaVersion: provenance.schemaVersion,
    sourceAsset: provenance.sourceAsset,
    sourceSha256: provenance.sourceSha256.toLowerCase(),
    geometry: expectedGeometry,
    textures: expectedTextures,
    leafGeometricError: 0,
    audit: {
      algorithm: audit.algorithm,
      ...(exactV2 ? {
        coordinateTolerance: audit.coordinateTolerance,
        maxNumericDelta: audit.maxNumericDelta,
        triangleCount: audit.triangleCount,
        leafTriangleCount: audit.leafTriangleCount ?? audit.triangleCount,
        duplicateLeafTriangleCount: audit.duplicateLeafTriangleCount ?? 0,
      } : {
        sourceTriangleCount: audit.sourceTriangleCount,
        leafTriangleCount: audit.leafTriangleCount,
        surfaceTolerance: audit.surfaceTolerance,
        maximumSurfaceDistance: Math.max(audit.sourceToLeaves.maximumDistance, audit.leavesToSource.maximumDistance),
        minimumNormalDot: Math.min(audit.sourceToLeaves.minimumNormalDot, audit.leavesToSource.minimumNormalDot),
        maximumReversedNormalFraction: Math.max(audit.sourceToLeaves.reversedNormalFraction, audit.leavesToSource.reversedNormalFraction),
      }),
      equivalenceSha256: audit.equivalenceSha256.toLowerCase(),
      artifactCount: audit.artifacts.length,
    },
    ...(controlledV3 ? { converter: {
      name: provenance.converter.name,
      version: provenance.converter.version,
      commandSha256: provenance.converter.commandSha256,
      inputAsset: provenance.converter.inputAsset,
      inputSha256: provenance.converter.inputSha256.toLowerCase(),
      binarySha256: provenance.converter.binarySha256.toLowerCase(),
    } } : {}),
  } : null;
  const artifacts = errors.length === 0 ? audit.artifacts.map((artifact) => ({
    uri: artifact.uri,
    sha256: artifact.sha256.toLowerCase(),
    byteLength: artifact.byteLength,
  })) : null;
  return { verified: errors.length === 0, errors, provenance: sanitized, artifacts };
}

module.exports = { sha256File, verifyLodProvenance };
