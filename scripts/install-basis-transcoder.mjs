import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'node_modules', 'three', 'examples', 'jsm', 'libs', 'basis');
const destination = path.join(root, 'public', 'basis');
const files = ['basis_transcoder.js', 'basis_transcoder.wasm'];

fs.mkdirSync(destination, { recursive: true });
for (const name of files) {
  const from = path.join(source, name);
  if (!fs.existsSync(from)) throw new Error(`Pinned Three.js Basis asset is missing: ${from}`);
  fs.copyFileSync(from, path.join(destination, name));
}
