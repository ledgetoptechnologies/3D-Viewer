import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Matrix3, Matrix4, Quaternion, Vector3 } from 'three';
import { inspectLodTileset } from '../../lod-policy.mjs';

export const AUDIT_ALGORITHM = 'ltds-glb-leaf-equivalence-v1';
export const DEFAULT_TOLERANCE = 1e-6;

export function auditFailureExitCode(error) {
  return typeof error?.code === 'string' && error.code ? 4 : 3;
}

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const IDENTITY = new Matrix4();
// 3D Tiles is Z-up while embedded glTF is Y-up. Compare in the source GLB's
// Y-up frame by conjugating the accumulated tile/RTC transform.
const GLTF_TO_TILE = new Matrix4().makeRotationX(Math.PI / 2);
const TILE_TO_GLTF = GLTF_TO_TILE.clone().invert();

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function localPath(root, base, uri) {
  if (typeof uri !== 'string' || !uri || /^(?:[a-z]+:)?\/\//i.test(uri)) {
    throw new Error(`remote or empty asset URI is not auditable (${uri || '<empty>'})`);
  }
  if (uri.startsWith('data:')) return null;
  const resolved = path.resolve(base, decodeURIComponent(uri.split(/[?#]/, 1)[0]));
  if (!inside(root, resolved)) throw new Error(`asset URI escapes the audit root (${uri})`);
  return resolved;
}

function dataUri(uri) {
  const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(uri);
  if (!match) throw new Error('malformed data URI');
  return Buffer.from(match[3], match[2] ? 'base64' : 'utf8');
}

function parseGlb(buffer, label) {
  if (buffer.length < 20 || buffer.readUInt32LE(0) !== 0x46546c67) throw new Error(`${label}: GLB magic is missing`);
  if (buffer.readUInt32LE(4) !== 2) throw new Error(`${label}: only GLB 2.0 is supported`);
  if (buffer.readUInt32LE(8) !== buffer.length) throw new Error(`${label}: GLB byteLength does not match the file`);
  let offset = 12;
  let json = null;
  let bin = null;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    offset += 8;
    if (offset + length > buffer.length) throw new Error(`${label}: GLB chunk exceeds byteLength`);
    if (type === 0x4e4f534a && !json) json = JSON.parse(buffer.subarray(offset, offset + length).toString('utf8').trim());
    if (type === 0x004e4942 && !bin) bin = buffer.subarray(offset, offset + length);
    offset += length;
  }
  if (!json) throw new Error(`${label}: GLB JSON chunk is missing`);
  return { json, bin: bin || Buffer.alloc(0) };
}

function parseB3dm(buffer, label) {
  if (buffer.length < 28 || buffer.toString('ascii', 0, 4) !== 'b3dm') throw new Error(`${label}: B3DM header is missing`);
  if (buffer.readUInt32LE(4) !== 1) throw new Error(`${label}: only B3DM version 1 is supported`);
  if (buffer.readUInt32LE(8) !== buffer.length) throw new Error(`${label}: B3DM byteLength does not match the file`);
  const ftJsonLength = buffer.readUInt32LE(12);
  const ftBinLength = buffer.readUInt32LE(16);
  const btJsonLength = buffer.readUInt32LE(20);
  const btBinLength = buffer.readUInt32LE(24);
  const glbOffset = 28 + ftJsonLength + ftBinLength + btJsonLength + btBinLength;
  if (glbOffset >= buffer.length) throw new Error(`${label}: embedded GLB is missing`);
  let rtc = null;
  if (ftJsonLength) {
    const feature = JSON.parse(buffer.subarray(28, 28 + ftJsonLength).toString('utf8').trim());
    if (feature.RTC_CENTER !== undefined) {
      if (!Array.isArray(feature.RTC_CENTER) || feature.RTC_CENTER.length !== 3
        || feature.RTC_CENTER.some((value) => !Number.isFinite(value))) {
        throw new Error(`${label}: binary or malformed RTC_CENTER is not supported by v1`);
      }
      rtc = feature.RTC_CENTER;
    }
  }
  return { glb: buffer.subarray(glbOffset), rtc };
}

function nodeMatrix(node) {
  if (Array.isArray(node.matrix)) {
    if (node.matrix.length !== 16 || node.matrix.some((value) => !Number.isFinite(value))) throw new Error('invalid node matrix');
    return new Matrix4().fromArray(node.matrix);
  }
  const translation = Array.isArray(node.translation) ? node.translation : [0, 0, 0];
  const rotation = Array.isArray(node.rotation) ? node.rotation : [0, 0, 0, 1];
  const scale = Array.isArray(node.scale) ? node.scale : [1, 1, 1];
  return new Matrix4().compose(
    new Vector3(...translation),
    new Quaternion(...rotation),
    new Vector3(...scale),
  );
}

function readComponent(buffer, offset, type, normalized) {
  let value;
  if (type === 5120) value = buffer.readInt8(offset);
  else if (type === 5121) value = buffer.readUInt8(offset);
  else if (type === 5122) value = buffer.readInt16LE(offset);
  else if (type === 5123) value = buffer.readUInt16LE(offset);
  else if (type === 5125) value = buffer.readUInt32LE(offset);
  else if (type === 5126) value = buffer.readFloatLE(offset);
  else throw new Error(`unsupported accessor componentType ${type}`);
  if (!normalized || type === 5126 || type === 5125) return value;
  if (type === 5120) return Math.max(value / 127, -1);
  if (type === 5121) return value / 255;
  if (type === 5122) return Math.max(value / 32767, -1);
  return value / 65535;
}

function accessorValues(asset, index, label) {
  const accessor = asset.json.accessors?.[index];
  if (!accessor) throw new Error(`${label}: accessor ${index} is missing`);
  if (accessor.sparse) throw new Error(`${label}: sparse accessors are not supported by the exact audit`);
  const componentCount = COMPONENTS[accessor.type];
  const componentBytes = COMPONENT_BYTES[accessor.componentType];
  if (!componentCount || !componentBytes || !Number.isInteger(accessor.count) || accessor.count < 0) {
    throw new Error(`${label}: accessor ${index} has an unsupported layout`);
  }
  const view = asset.json.bufferViews?.[accessor.bufferView];
  if (!view) throw new Error(`${label}: accessor ${index} has no bufferView`);
  if (view.extensions?.EXT_meshopt_compression) throw new Error(`${label}: meshopt-compressed accessors are not supported`);
  if ((view.buffer ?? 0) !== 0) throw new Error(`${label}: only an embedded GLB buffer is supported`);
  const packed = componentCount * componentBytes;
  const stride = view.byteStride || packed;
  if (stride < packed) throw new Error(`${label}: accessor ${index} has an invalid byteStride`);
  const start = (view.byteOffset || 0) + (accessor.byteOffset || 0);
  const end = accessor.count ? start + (accessor.count - 1) * stride + packed : start;
  if (start < 0 || end > asset.bin.length) throw new Error(`${label}: accessor ${index} exceeds the GLB buffer`);
  const values = [];
  for (let row = 0; row < accessor.count; row += 1) {
    const item = [];
    for (let component = 0; component < componentCount; component += 1) {
      item.push(readComponent(asset.bin, start + row * stride + component * componentBytes, accessor.componentType, accessor.normalized));
    }
    values.push(item);
  }
  return values;
}

function resolveImage(asset, imageIndex, label) {
  const image = asset.json.images?.[imageIndex];
  if (!image) throw new Error(`${label}: image ${imageIndex} is missing`);
  let bytes;
  if (Number.isInteger(image.bufferView)) {
    const view = asset.json.bufferViews?.[image.bufferView];
    if (!view || (view.buffer ?? 0) !== 0) throw new Error(`${label}: image bufferView is invalid or external`);
    bytes = asset.bin.subarray(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength);
  } else if (typeof image.uri === 'string') {
    const imagePath = localPath(asset.root, asset.baseDir, image.uri);
    if (imagePath) {
      bytes = fs.readFileSync(imagePath);
      asset.bindExternal?.(imagePath, bytes);
    } else {
      bytes = dataUri(image.uri);
    }
  } else {
    throw new Error(`${label}: image ${imageIndex} has no auditable payload`);
  }
  return { sha256: sha256(bytes), byteLength: bytes.length, mimeType: image.mimeType || null };
}

function textureDescriptor(asset, index, label) {
  const texture = asset.json.textures?.[index];
  if (!texture) throw new Error(`${label}: texture ${index} is missing`);
  if (texture.extensions?.KHR_texture_basisu || texture.extensions?.EXT_texture_webp) {
    throw new Error(`${label}: alternate compressed texture sources are not supported by v1`);
  }
  const sampler = asset.json.samplers?.[texture.sampler] || {};
  return {
    image: resolveImage(asset, texture.source, label),
    sampler: {
      magFilter: sampler.magFilter ?? 9729,
      minFilter: sampler.minFilter ?? 9987,
      wrapS: sampler.wrapS ?? 10497,
      wrapT: sampler.wrapT ?? 10497,
    },
  };
}

function resolveTextureInfos(value, asset, label, key = '') {
  if (Array.isArray(value)) return value.map((entry) => resolveTextureInfos(entry, asset, label, key));
  if (!value || typeof value !== 'object') return value;
  if (/texture$/i.test(key) && Number.isInteger(value.index)) {
    const { index, ...properties } = value;
    return { ...resolveTextureInfos(properties, asset, label), texture: textureDescriptor(asset, index, label) };
  }
  return Object.fromEntries(Object.entries(value)
    .filter(([name]) => name !== 'name' && name !== 'extras')
    .map(([name, child]) => [name, resolveTextureInfos(child, asset, label, name)]));
}

function materialSignature(asset, index, label) {
  const material = Number.isInteger(index) ? asset.json.materials?.[index] : null;
  if (Number.isInteger(index) && !material) throw new Error(`${label}: material ${index} is missing`);
  const pbr = material?.pbrMetallicRoughness || {};
  const semantic = {
    pbrMetallicRoughness: {
      baseColorFactor: pbr.baseColorFactor || [1, 1, 1, 1],
      baseColorTexture: pbr.baseColorTexture || null,
      metallicFactor: pbr.metallicFactor ?? 1,
      roughnessFactor: pbr.roughnessFactor ?? 1,
      metallicRoughnessTexture: pbr.metallicRoughnessTexture || null,
    },
    normalTexture: material?.normalTexture || null,
    occlusionTexture: material?.occlusionTexture || null,
    emissiveTexture: material?.emissiveTexture || null,
    emissiveFactor: material?.emissiveFactor || [0, 0, 0],
    alphaMode: material?.alphaMode || 'OPAQUE',
    alphaCutoff: material?.alphaCutoff ?? 0.5,
    doubleSided: material?.doubleSided || false,
    extensions: material?.extensions || null,
  };
  return stable(resolveTextureInfos(semantic, asset, label));
}

function transformAttribute(name, value, world, normalMatrix) {
  if (name === 'POSITION') {
    const vector = new Vector3(value[0], value[1], value[2]).applyMatrix4(world);
    return [vector.x, vector.y, vector.z];
  }
  if (name === 'NORMAL') {
    const vector = new Vector3(value[0], value[1], value[2]).applyMatrix3(normalMatrix).normalize();
    return [vector.x, vector.y, vector.z];
  }
  if (name === 'TANGENT') {
    const vector = new Vector3(value[0], value[1], value[2]).applyMatrix3(normalMatrix).normalize();
    return [vector.x, vector.y, vector.z, value[3]];
  }
  return value;
}

function orderedNumber(value, tolerance) {
  return tolerance > 0 ? Math.round(value / tolerance) : value;
}

function compareVectors(a, b, tolerance = 0) {
  const length = Math.min(a.values.length, b.values.length);
  for (let index = 0; index < length; index += 1) {
    const left = orderedNumber(a.values[index], tolerance);
    const right = orderedNumber(b.values[index], tolerance);
    if (left !== right) return left - right;
  }
  return a.values.length - b.values.length || a.keys.localeCompare(b.keys);
}

function rotateCanonical(vertices, tolerance = 0) {
  const rotations = [vertices, [vertices[1], vertices[2], vertices[0]], [vertices[2], vertices[0], vertices[1]]];
  rotations.sort((a, b) => {
    for (let index = 0; index < 3; index += 1) {
      const compared = compareVectors(a[index], b[index], tolerance);
      if (compared) return compared;
    }
    return 0;
  });
  return rotations[0];
}

function triangleCompare(a, b, tolerance = 0) {
  const material = a.material.localeCompare(b.material);
  if (material) return material;
  for (let index = 0; index < 3; index += 1) {
    const compared = compareVectors(a.vertices[index], b.vertices[index], tolerance);
    if (compared) return compared;
  }
  return 0;
}

function extractTriangles(asset, rootTransform, label) {
  const triangles = [];
  const nodes = asset.json.nodes || [];
  const childNodes = new Set(nodes.flatMap((node) => node.children || []));
  const scene = asset.json.scenes?.[asset.json.scene ?? 0];
  const roots = scene?.nodes || nodes.map((_, index) => index).filter((index) => !childNodes.has(index));
  const active = new Set();

  function visit(nodeIndex, parent) {
    if (active.has(nodeIndex)) throw new Error(`${label}: node hierarchy contains a cycle`);
    const node = nodes[nodeIndex];
    if (!node) throw new Error(`${label}: node ${nodeIndex} is missing`);
    if (node.skin !== undefined || node.weights || node.extensions?.EXT_mesh_gpu_instancing) {
      throw new Error(`${label}: skinned, morphed, or instanced geometry is not supported by v1`);
    }
    active.add(nodeIndex);
    const world = parent.clone().multiply(nodeMatrix(node));
    if (Number.isInteger(node.mesh)) {
      const mesh = asset.json.meshes?.[node.mesh];
      if (!mesh) throw new Error(`${label}: mesh ${node.mesh} is missing`);
      for (const primitive of mesh.primitives || []) {
        if ((primitive.mode ?? 4) !== 4) throw new Error(`${label}: only TRIANGLES primitives are auditable`);
        if (primitive.targets?.length || primitive.extensions?.KHR_draco_mesh_compression) {
          throw new Error(`${label}: morph targets and Draco-compressed primitives are not supported by v1`);
        }
        if (!Number.isInteger(primitive.attributes?.POSITION)) throw new Error(`${label}: primitive has no POSITION accessor`);
        const suppliedAttributeNames = Object.keys(primitive.attributes).sort();
        if (suppliedAttributeNames.some((name) => name.startsWith('JOINTS_') || name.startsWith('WEIGHTS_'))) {
          throw new Error(`${label}: skinned attributes are not supported by v1`);
        }
        const attributeNames = suppliedAttributeNames.filter((name) => (
          name === 'POSITION' || name === 'NORMAL' || name === 'TANGENT'
          || /^TEXCOORD_\d+$/.test(name) || /^COLOR_\d+$/.test(name)
        ));
        const unsupported = suppliedAttributeNames.filter((name) => !attributeNames.includes(name) && !name.startsWith('_'));
        if (unsupported.length) throw new Error(`${label}: unsupported render attribute ${unsupported[0]}`);
        const attributes = Object.fromEntries(attributeNames.map((name) => [name, accessorValues(asset, primitive.attributes[name], label)]));
        const vertexCount = attributes.POSITION.length;
        if (Object.values(attributes).some((values) => values.length !== vertexCount)) throw new Error(`${label}: primitive attributes have different counts`);
        const indices = Number.isInteger(primitive.indices)
          ? accessorValues(asset, primitive.indices, label).map((value) => value[0])
          : Array.from({ length: vertexCount }, (_, index) => index);
        if (indices.length % 3) throw new Error(`${label}: triangle index count is not divisible by three`);
        const determinant = world.determinant();
        if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-15) throw new Error(`${label}: singular or invalid geometry transform`);
        const normalMatrix = new Matrix3().getNormalMatrix(world);
        const material = materialSignature(asset, primitive.material, label);
        for (let offset = 0; offset < indices.length; offset += 3) {
          const vertices = [];
          for (const index of indices.slice(offset, offset + 3)) {
            if (!Number.isInteger(index) || index < 0 || index >= vertexCount) throw new Error(`${label}: primitive index is out of bounds`);
            const values = [];
            for (const name of attributeNames) values.push(...transformAttribute(name, attributes[name][index], world, normalMatrix));
            vertices.push({ keys: attributeNames.join('|'), values });
          }
          if (determinant < 0) [vertices[1], vertices[2]] = [vertices[2], vertices[1]];
          triangles.push({ material, vertices: rotateCanonical(vertices) });
        }
      }
    }
    for (const child of node.children || []) visit(child, world);
    active.delete(nodeIndex);
  }

  let assetTransform = rootTransform;
  const cesiumRtc = asset.json.extensions?.CESIUM_RTC?.center;
  if (cesiumRtc !== undefined) {
    if (!Array.isArray(cesiumRtc) || cesiumRtc.length !== 3 || cesiumRtc.some((value) => !Number.isFinite(value))) {
      throw new Error(`${label}: malformed CESIUM_RTC center`);
    }
    assetTransform = rootTransform.clone().multiply(new Matrix4().makeTranslation(...cesiumRtc));
  }
  for (const root of roots) visit(root, assetTransform);
  return triangles;
}

function loadGlbAsset(filePath, root, embeddedBuffer = null, bindExternal = null) {
  const label = path.relative(root, filePath) || path.basename(filePath);
  const parsed = parseGlb(embeddedBuffer || fs.readFileSync(filePath), label);
  if ((parsed.json.buffers || []).length > 1 || (parsed.json.buffers?.[0]?.uri)) {
    throw new Error(`${label}: only a single embedded GLB buffer is supported`);
  }
  const supportedExtension = (name) => name === 'CESIUM_RTC' || name === 'KHR_mesh_quantization'
    || name === 'KHR_texture_transform' || (/^KHR_materials_/.test(name) && name !== 'KHR_materials_variants');
  const unsupportedRequired = (parsed.json.extensionsRequired || []).find((name) => !supportedExtension(name));
  if (unsupportedRequired) throw new Error(`${label}: required extension ${unsupportedRequired} is not supported by v1`);
  return { ...parsed, root, baseDir: path.dirname(filePath), bindExternal };
}

async function collectLeafTriangles(derivativeDir, artifacts) {
  const triangles = [];
  const visitedTilesets = new Set();

  function bindArtifact(filePath, knownBytes = null) {
    const relative = path.relative(derivativeDir, filePath).split(path.sep).join('/');
    let bytes = knownBytes;
    if (!bytes) {
      try {
        bytes = fs.readFileSync(filePath);
      } catch (error) {
        if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error?.code)) {
          throw new Error(`required tile artifact is missing or invalid (${relative})`);
        }
        throw error;
      }
    }
    artifacts.set(relative, { uri: relative, sha256: sha256(bytes), byteLength: bytes.length });
    return bytes;
  }

  function walkTileset(filePath, inheritedTransform = IDENTITY) {
    const absolute = path.resolve(filePath);
    if (!inside(derivativeDir, absolute)) throw new Error(`external tileset escapes the derivative directory (${filePath})`);
    const visitKey = `${absolute}:${inheritedTransform.elements.join(',')}`;
    if (visitedTilesets.has(visitKey)) throw new Error(`tileset cycle detected at ${path.relative(derivativeDir, absolute)}`);
    visitedTilesets.add(visitKey);
    const bytes = bindArtifact(absolute);
    const tileset = JSON.parse(bytes.toString('utf8'));
    const report = inspectLodTileset(tileset);
    if (!report.valid) throw new Error(`${path.basename(absolute)}: ${report.errors[0]}`);

    function walkTile(tile, parentTransform) {
      if (tile.transform !== undefined && (!Array.isArray(tile.transform) || tile.transform.length !== 16
        || tile.transform.some((value) => !Number.isFinite(value)))) {
        throw new Error('tile transform must contain 16 finite numbers');
      }
      const local = Array.isArray(tile.transform) ? new Matrix4().fromArray(tile.transform) : IDENTITY;
      const world = parentTransform.clone().multiply(local);
      const children = Array.isArray(tile.children) ? tile.children : [];
      if (children.length) {
        for (const child of children) walkTile(child, world);
        return;
      }
      const uri = tile?.content?.uri || tile?.content?.url;
      if (!uri) throw new Error('zero-error terminal tile has no content');
      const contentPath = localPath(derivativeDir, path.dirname(absolute), uri);
      if (!contentPath) throw new Error(`data URI tile content is unsupported (${uri})`);
      if (/\.json$/i.test(contentPath)) {
        walkTileset(contentPath, world);
        return;
      }
      const content = bindArtifact(contentPath);
      let glb = content;
      let rtc = null;
      if (/\.b3dm$/i.test(contentPath)) ({ glb, rtc } = parseB3dm(content, path.relative(derivativeDir, contentPath)));
      else if (!/\.glb$/i.test(contentPath)) throw new Error(`unsupported leaf content type (${uri})`);
      const tileContentTransform = rtc ? world.clone().multiply(new Matrix4().makeTranslation(...rtc)) : world;
      const contentTransform = TILE_TO_GLTF.clone().multiply(tileContentTransform).multiply(GLTF_TO_TILE);
      triangles.push(...extractTriangles(
        loadGlbAsset(contentPath, derivativeDir, glb, bindArtifact),
        contentTransform,
        uri,
      ));
    }

    walkTile(tileset.root, inheritedTransform);
    visitedTilesets.delete(visitKey);
  }

  walkTileset(path.join(derivativeDir, 'tileset.json'));
  return { triangles, artifacts: [...artifacts.values()].sort((a, b) => a.uri.localeCompare(b.uri)) };
}

function compareAudits(source, leaves, tolerance) {
  for (const triangle of source) triangle.vertices = rotateCanonical(triangle.vertices, tolerance);
  for (const triangle of leaves) triangle.vertices = rotateCanonical(triangle.vertices, tolerance);
  source.sort((a, b) => triangleCompare(a, b, tolerance));
  leaves.sort((a, b) => triangleCompare(a, b, tolerance));
  if (source.length !== leaves.length) throw new Error(`triangle count differs: source=${source.length}, leaves=${leaves.length}`);
  let maxNumericDelta = 0;
  for (let triangleIndex = 0; triangleIndex < source.length; triangleIndex += 1) {
    const a = source[triangleIndex];
    const b = leaves[triangleIndex];
    if (a.material !== b.material) throw new Error(`material/texture evidence differs at canonical triangle ${triangleIndex}`);
    for (let vertexIndex = 0; vertexIndex < 3; vertexIndex += 1) {
      if (a.vertices[vertexIndex].keys !== b.vertices[vertexIndex].keys) {
        throw new Error(`vertex attribute set differs at canonical triangle ${triangleIndex}`);
      }
      const av = a.vertices[vertexIndex].values;
      const bv = b.vertices[vertexIndex].values;
      if (av.length !== bv.length) throw new Error(`vertex attribute width differs at canonical triangle ${triangleIndex}`);
      for (let component = 0; component < av.length; component += 1) {
        const delta = Math.abs(av[component] - bv[component]);
        if (!Number.isFinite(delta) || delta > tolerance) {
          throw new Error(`geometry/attribute delta ${delta} exceeds tolerance ${tolerance} at canonical triangle ${triangleIndex}`);
        }
        maxNumericDelta = Math.max(maxNumericDelta, delta);
      }
    }
  }
  const canonical = source.map((triangle) => ({ material: triangle.material, vertices: triangle.vertices }));
  return { maxNumericDelta, equivalenceSha256: sha256(stable(canonical)) };
}

export async function auditLodEquivalence({ derivativeDir, sourceGlb, tolerance = DEFAULT_TOLERANCE, allowExternalSource = false }) {
  derivativeDir = path.resolve(derivativeDir);
  sourceGlb = path.resolve(sourceGlb);
  if (!allowExternalSource && !inside(derivativeDir, sourceGlb)) {
    throw new Error('source GLB must be inside the derivative directory so the runtime can bind it to the audit');
  }
  if (!/\.glb$/i.test(sourceGlb)) throw new Error('v1 equivalence auditing supports a GLB source only');
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 1e-3) throw new Error('tolerance must be between 0 and 0.001 model units');
  const sourceBytes = fs.readFileSync(sourceGlb);
  const artifactMap = new Map();
  const bindExternal = (filePath, knownBytes = null) => {
    const relative = path.relative(derivativeDir, filePath).split(path.sep).join('/');
    const bytes = knownBytes || fs.readFileSync(filePath);
    artifactMap.set(relative, { uri: relative, sha256: sha256(bytes), byteLength: bytes.length });
    return bytes;
  };
  const source = extractTriangles(
    loadGlbAsset(sourceGlb, derivativeDir, sourceBytes, bindExternal),
    IDENTITY,
    path.basename(sourceGlb),
  );
  const { triangles: leaves } = await collectLeafTriangles(derivativeDir, artifactMap);
  const artifacts = [...artifactMap.values()].sort((a, b) => a.uri.localeCompare(b.uri));
  const comparison = compareAudits(source, leaves, tolerance);
  return {
    schemaVersion: 2,
    sourceAsset: path.basename(sourceGlb),
    sourceSha256: sha256(sourceBytes),
    geometry: 'bounded-triangle-equivalence',
    textures: 'byte-identical-material-equivalence',
    leafGeometricError: 0,
    audit: {
      algorithm: AUDIT_ALGORITHM,
      coordinateTolerance: tolerance,
      maxNumericDelta: comparison.maxNumericDelta,
      triangleCount: source.length,
      equivalenceSha256: comparison.equivalenceSha256,
      artifacts,
    },
  };
}

export async function writeLodProvenance({ derivativeDir, sourceGlb, tolerance = DEFAULT_TOLERANCE, output, allowExternalSource = false }) {
  const provenance = await auditLodEquivalence({ derivativeDir, sourceGlb, tolerance, allowExternalSource });
  const outputPath = path.resolve(output || path.join(derivativeDir, 'lod-provenance.json'));
  if (!inside(path.resolve(derivativeDir), outputPath)) throw new Error('provenance output must stay inside the derivative directory');
  const temporary = `${outputPath}.${process.pid}.tmp`;
  await fs.promises.writeFile(temporary, `${JSON.stringify(provenance, null, 2)}\n`, { flag: 'wx' });
  try {
    await fs.promises.rename(temporary, outputPath);
  } catch (error) {
    await fs.promises.rm(temporary, { force: true });
    throw error;
  }
  return { provenance, outputPath };
}
