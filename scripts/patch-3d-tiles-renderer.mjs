import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const packageRoot = path.join(root, 'node_modules', '3d-tiles-renderer');
const metadataPath = path.join(packageRoot, 'package.json');
const expectedVersion = '0.5.1';

if (!fs.existsSync(metadataPath)) {
  throw new Error('3d-tiles-renderer is not installed; cannot apply the LTDS traversal patch');
}

const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
if (metadata.version !== expectedVersion) {
  throw new Error(`LTDS traversal patch requires 3d-tiles-renderer ${expectedVersion}; found ${metadata.version}`);
}

function patchExact(file, upstream, patched, label) {
  const source = fs.readFileSync(file, 'utf8');
  if (source.includes(patched)) return false;
  const occurrences = source.split(upstream).length - 1;
  if (occurrences !== 1) {
    throw new Error(`${label}: expected one upstream traversal condition, found ${occurrences}`);
  }
  fs.writeFileSync(file, source.replace(upstream, patched));
  return true;
}

const sourceFile = path.join(packageRoot, 'src', 'core', 'renderer', 'tiles', 'traverseFunctions.js');
patchExact(
  sourceFile,
  '( renderer.loadSiblings || renderer.loadAncestors )',
  '( renderer.loadSiblings || ( renderer.loadAncestors && renderer.loadAncestorSiblings !== false ) )',
  '3d-tiles-renderer source',
);

const buildDirectory = path.join(packageRoot, 'build');
const chunks = fs.readdirSync(buildDirectory)
  .filter((name) => /^renderer-[A-Za-z0-9_-]+\.js$/.test(name));
let matchingChunks = 0;
for (const name of chunks) {
  const file = path.join(buildDirectory, name);
  const source = fs.readFileSync(file, 'utf8');
  const upstream = /\(([A-Za-z_$][\w$]*)\.loadSiblings \|\| \1\.loadAncestors\)/g;
  const patched = /\(([A-Za-z_$][\w$]*)\.loadSiblings \|\| \(\1\.loadAncestors && \1\.loadAncestorSiblings !== false\)\)/g;
  const upstreamMatches = [...source.matchAll(upstream)];
  const patchedMatches = [...source.matchAll(patched)];
  if (patchedMatches.length === 1 && upstreamMatches.length === 0) {
    matchingChunks += 1;
    continue;
  }
  if (upstreamMatches.length !== 1 || patchedMatches.length !== 0) {
    if (upstreamMatches.length || patchedMatches.length) {
      throw new Error(`${name}: ambiguous ancestor/sibling traversal condition`);
    }
    continue;
  }
  const variable = upstreamMatches[0][1];
  fs.writeFileSync(file, source.replace(
    upstream,
    `(${variable}.loadSiblings || (${variable}.loadAncestors && ${variable}.loadAncestorSiblings !== false))`,
  ));
  matchingChunks += 1;
}

if (matchingChunks !== 1) {
  throw new Error(`expected one built renderer traversal chunk, patched ${matchingChunks}`);
}
