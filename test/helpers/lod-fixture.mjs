import fs from 'node:fs';
import path from 'node:path';

function align4(value) {
  return (value + 3) & ~3;
}

function append(parts, bytes) {
  const offset = parts.reduce((total, part) => total + part.length, 0);
  const padded = Buffer.alloc(align4(bytes.length));
  bytes.copy(padded);
  parts.push(padded);
  return { byteOffset: offset, byteLength: bytes.length };
}

function floatBytes(values) {
  const buffer = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
  return buffer;
}

export function makeGlb(triangles, textureBytes = Buffer.from('fixture-texture'), {
  texcoordTransform = (x, y) => [x, y],
  imageUri = null,
} = {}) {
  const positions = [];
  const normals = [];
  const texcoords = [];
  for (const triangle of triangles) {
    for (const [x, y, z] of triangle) {
      positions.push(x, y, z);
      normals.push(0, 0, 1);
      texcoords.push(...texcoordTransform(x, y));
    }
  }
  const parts = [];
  const positionView = append(parts, floatBytes(positions));
  const normalView = append(parts, floatBytes(normals));
  const texcoordView = append(parts, floatBytes(texcoords));
  const imageView = imageUri ? null : append(parts, textureBytes);
  const bin = Buffer.concat(parts);
  const json = {
    asset: { version: '2.0', generator: 'LTDS deterministic test fixture' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    textures: [{ source: 0 }],
    images: [imageUri ? { uri: imageUri, mimeType: 'image/png' } : { bufferView: 3, mimeType: 'image/png' }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5126, count: normals.length / 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: texcoords.length / 2, type: 'VEC2' },
    ],
    bufferViews: [positionView, normalView, texcoordView, ...(imageView ? [imageView] : [])],
    buffers: [{ byteLength: bin.length }],
  };
  let jsonBytes = Buffer.from(JSON.stringify(json));
  const paddedJson = Buffer.alloc(align4(jsonBytes.length), 0x20);
  jsonBytes.copy(paddedJson);
  const output = Buffer.alloc(12 + 8 + paddedJson.length + 8 + bin.length);
  output.writeUInt32LE(0x46546c67, 0);
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(paddedJson.length, 12);
  output.writeUInt32LE(0x4e4f534a, 16);
  paddedJson.copy(output, 20);
  const binHeader = 20 + paddedJson.length;
  output.writeUInt32LE(bin.length, binHeader);
  output.writeUInt32LE(0x004e4942, binHeader + 4);
  bin.copy(output, binHeader + 8);
  return output;
}

export function makeB3dm(glb, featureTable = null) {
  const rawFeature = featureTable ? Buffer.from(JSON.stringify(featureTable)) : Buffer.alloc(0);
  const feature = Buffer.alloc(align4(rawFeature.length), 0x20);
  rawFeature.copy(feature);
  const output = Buffer.alloc(28 + feature.length + glb.length);
  output.write('b3dm', 0, 'ascii');
  output.writeUInt32LE(1, 4);
  output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(feature.length, 12);
  feature.copy(output, 28);
  glb.copy(output, 28 + feature.length);
  return output;
}

export const TRIANGLE_A = [[0, 0, 0], [1, 0, 0], [0, 1, 0]];
export const TRIANGLE_B = [[1, 0, 0], [1, 1, 0], [0, 1, 0]];

export function writeAuditableFixture(directory, {
  leafATriangles = [TRIANGLE_A],
  leafARtc,
  leafATexcoordTransform,
  leafBTriangles = [TRIANGLE_B],
  leafBTexture = Buffer.from('fixture-texture'),
  leafBTransform,
  leafBTexcoordTransform,
  leafABytes,
  externalTexture = false,
} = {}) {
  fs.mkdirSync(directory, { recursive: true });
  const imageOptions = externalTexture ? { imageUri: 'texture.png' } : {};
  if (externalTexture) fs.writeFileSync(path.join(directory, 'texture.png'), Buffer.from('fixture-texture'));
  const source = path.join(directory, 'model.glb');
  fs.writeFileSync(source, makeGlb([TRIANGLE_A, TRIANGLE_B], Buffer.from('fixture-texture'), imageOptions));
  fs.writeFileSync(path.join(directory, 'leaf-a.b3dm'), leafABytes || makeB3dm(makeGlb(leafATriangles, Buffer.from('fixture-texture'), {
    ...imageOptions,
    ...(leafATexcoordTransform ? { texcoordTransform: leafATexcoordTransform } : {}),
  }), leafARtc ? { RTC_CENTER: leafARtc } : null));
  fs.writeFileSync(path.join(directory, 'leaf-b.glb'), makeGlb(leafBTriangles, leafBTexture, {
    ...imageOptions,
    ...(leafBTexcoordTransform ? { texcoordTransform: leafBTexcoordTransform } : {}),
  }));
  fs.writeFileSync(path.join(directory, 'tileset.json'), JSON.stringify({
    asset: { version: '1.1' },
    root: {
      refine: 'REPLACE',
      geometricError: 8,
      boundingVolume: { sphere: [0.5, 0.5, 0, 2] },
      children: [
        {
          geometricError: 0,
          boundingVolume: { sphere: [0.25, 0.25, 0, 1] },
          content: { uri: 'leaf-a.b3dm' },
        },
        {
          geometricError: 0,
          boundingVolume: { sphere: [0.75, 0.75, 0, 1] },
          content: { uri: 'leaf-b.glb' },
          ...(leafBTransform ? { transform: leafBTransform } : {}),
        },
      ],
    },
  }));
  return source;
}
