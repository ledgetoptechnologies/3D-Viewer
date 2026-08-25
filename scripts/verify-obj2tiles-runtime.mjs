import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { auditControlledObj2Tiles } from './lib/lod-equivalence.mjs';

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

function makeReferenceGlb(textureBytes) {
  const positions = [
    0, 0, 0, 1, 0, 0, 0, 1, 0,
    1, 0, 0, 1, 1, 0, 0, 1, 0,
  ];
  const normals = Array.from({ length: 6 }, () => [0, 0, 1]).flat();
  const texcoords = [0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1];
  const parts = [];
  const positionView = append(parts, floatBytes(positions));
  const normalView = append(parts, floatBytes(normals));
  const texcoordView = append(parts, floatBytes(texcoords));
  const imageView = append(parts, textureBytes);
  const bin = Buffer.concat(parts);
  const json = {
    asset: { version: '2.0', generator: 'LTDS Obj2Tiles runtime smoke' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    textures: [{ source: 0 }],
    images: [{ bufferView: 3, mimeType: 'image/png' }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 6, type: 'VEC3' },
      { bufferView: 1, componentType: 5126, count: 6, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: 6, type: 'VEC2' },
    ],
    bufferViews: [positionView, normalView, texcoordView, imageView],
    buffers: [{ byteLength: bin.length }],
  };
  const jsonBytes = Buffer.from(JSON.stringify(json));
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

const obj2Tiles = process.env.OBJ2TILES_BIN || '/opt/obj2tiles/Obj2Tiles';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-obj2tiles-smoke-'));
const sourceObj = path.join(root, 'model.obj');
const sourceGlb = path.join(root, 'model.glb');
const output = path.join(root, 'tiles');

try {
  const texture = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4DwQNDgwODSAGAEJWCXkXUrf5AAAAAElFTkSuQmCC', 'base64');
  fs.writeFileSync(path.join(root, 'texture.png'), texture);
  fs.writeFileSync(path.join(root, 'model.mtl'), [
    'newmtl material0',
    'Ka 1.0 1.0 1.0',
    'Kd 1.0 1.0 1.0',
    'Ks 0.0 0.0 0.0',
    'd 1.0',
    'illum 1',
    'map_Kd texture.png',
    '',
  ].join('\n'));
  fs.writeFileSync(sourceObj, [
    'mtllib model.mtl',
    'o square',
    'v 0 0 0', 'v 1 0 0', 'v 1 1 0', 'v 0 1 0',
    'vt 0 0', 'vt 1 0', 'vt 1 1', 'vt 0 1',
    'vn 0 0 1',
    'usemtl material0',
    'f 1/1/1 2/2/1 3/3/1',
    'f 1/1/1 3/3/1 4/4/1',
    '',
  ].join('\n'));
  fs.writeFileSync(sourceGlb, makeReferenceGlb(texture));

  const conversion = spawnSync(obj2Tiles, [
    '--octree', '--lods', '3', '--divisions', '2',
    '--lod-texture-scale', '0.5', '--local', sourceObj, output,
  ], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 60_000, windowsHide: true });
  if (conversion.error || conversion.status !== 0) {
    throw new Error(`Obj2Tiles smoke conversion failed (${conversion.error?.code || conversion.status || 'unknown'})`);
  }
  if (!fs.statSync(path.join(output, 'tileset.json')).isFile()) throw new Error('Obj2Tiles smoke produced no tileset');

  const provenance = await auditControlledObj2Tiles({
    derivativeDir: output,
    sourceGlb,
    converterInput: sourceObj,
    converterBinary: obj2Tiles,
    allowExternalSource: true,
  });
  fs.writeFileSync(path.join(output, 'lod-provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);
  if (provenance.schemaVersion !== 3 || provenance.audit?.sourceTriangleCount !== 2
    || !Array.isArray(provenance.audit?.artifacts) || provenance.audit.artifacts.length < 2) {
    throw new Error('Obj2Tiles smoke provenance was incomplete');
  }
  console.log(JSON.stringify({ ok: true, schemaVersion: provenance.schemaVersion, artifacts: provenance.audit.artifacts.length }));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
