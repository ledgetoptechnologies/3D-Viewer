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
  const upstreamOccurrences = source.split(upstream).length - 1;
  const patchedOccurrences = source.split(patched).length - 1;
  if (patchedOccurrences === 1 && upstreamOccurrences === 0) return false;
  if (upstreamOccurrences !== 1 || patchedOccurrences !== 0) {
    throw new Error(`${label}: expected upstream=1/patched=0 or upstream=0/patched=1; found upstream=${upstreamOccurrences}/patched=${patchedOccurrences}`);
  }
  const result = source.replace(upstream, patched);
  if ((result.split(upstream).length - 1) !== 0 || (result.split(patched).length - 1) !== 1) {
    throw new Error(`${label}: replacement did not produce one exact patched block`);
  }
  fs.writeFileSync(file, result);
  return true;
}

function restoreExact(file, desired, legacy, label) {
  const source = fs.readFileSync(file, 'utf8');
  const desiredOccurrences = source.split(desired).length - 1;
  const legacyOccurrences = source.split(legacy).length - 1;
  if (desiredOccurrences === 1 && legacyOccurrences === 0) return false;
  if (desiredOccurrences !== 0 || legacyOccurrences !== 1) {
    throw new Error(`${label}: expected desired=1/legacy=0 or desired=0/legacy=1; found desired=${desiredOccurrences}/legacy=${legacyOccurrences}`);
  }
  const result = source.replace(legacy, desired);
  if ((result.split(desired).length - 1) !== 1 || (result.split(legacy).length - 1) !== 0) {
    throw new Error(`${label}: restoration did not produce one exact desired block`);
  }
  fs.writeFileSync(file, result);
  return true;
}

const sourceFile = path.join(packageRoot, 'src', 'core', 'renderer', 'tiles', 'traverseFunctions.js');
patchExact(
  sourceFile,
  '( renderer.loadSiblings || renderer.loadAncestors )',
  '( renderer.loadSiblings || ( renderer.loadAncestors && renderer.loadAncestorSiblings !== false ) )',
  '3d-tiles-renderer source',
);

restoreExact(
  sourceFile,
  `\t\tif ( renderer.loadAncestors && tile.internal.hasContent ) {

\t\t\trenderer.markTileUsed( tile );
\t\t\trenderer.queueTileForDownload( tile );

\t\t}`,
  `\t\tif ( renderer.loadAncestors && tile.internal.hasContent && ! isDownloadFinished( tile.internal.loadingState ) ) {

\t\t\trenderer.markTileUsed( tile );
\t\t\trenderer.queueTileForDownload( tile );

\t\t}`,
  '3d-tiles-renderer source loaded replacement retention',
);

patchExact(
  sourceFile,
  `\t\t\t\tconst childCanDisplay = ! canUnconditionallyRefine( c );
\t\t\t\tconst childContentReady = ! c.internal.hasContent || isDownloadFinished( c.internal.loadingState );
\t\t\t\tconst childIsReady = ( childCanDisplay && childContentReady ) || c.traversal.allChildrenLoaded;`,
  `\t\t\t\tconst childIsReady = c.internal.hasRenderableContent
\t\t\t\t\t? c.internal.loadingState === LOADED
\t\t\t\t\t: c.traversal.allChildrenLoaded;`,
  '3d-tiles-renderer source branch-local readiness',
);

patchExact(
  sourceFile,
  `\tif ( tile.refine === 'REPLACE' && ! allChildrenReady && tile.traversal.wasSetActive && isChildReady( tile ) ) {`,
  `\tif ( tile.refine === 'REPLACE' && ! allChildrenReady && ( tile.traversal.wasSetActive || renderer.lodFallbackTiles?.has( tile ) ) && isChildReady( tile ) ) {`,
  '3d-tiles-renderer source scoped overview fallback',
);

const rendererSourceFile = path.join(packageRoot, 'src', 'core', 'renderer', 'tiles', 'TilesRendererBase.js');
patchExact(
  rendererSourceFile,
  `\t\t\t\tif ( lruCache.getMemoryUsage( tile ) === 0 && bytesUsed > 0 && lruCache.isFull() ) {

\t\t\t\t\t// And if the cache is full due to newly loaded memory then lets discard this tile - it will
\t\t\t\t\t// be loaded again later from the disk cache if needed.
\t\t\t\t\tlruCache.remove( tile );
\t\t\t\t\treturn;

\t\t\t\t}`,
  `\t\t\t\tif ( lruCache.getMemoryUsage( tile ) === 0 && bytesUsed > 0 && lruCache.isFull() ) {

\t\t\t\t\t// Give applications one synchronous chance to evict stale content before
\t\t\t\t\t// discarding an expensive foreground parse. The cache is checked again so
\t\t\t\t\t// handlers cannot bypass the configured hard admission ceiling.
\t\t\t\t\tthis.dispatchEvent( { type: 'tile-memory-pressure', tile, bytesUsed } );
\t\t\t\t\tif ( lruCache.isFull() ) {

\t\t\t\t\t\tlruCache.remove( tile );
\t\t\t\t\t\treturn;

\t\t\t\t\t}

\t\t\t\t}`,
  '3d-tiles-renderer source pre-discard recovery',
);

const buildDirectory = path.join(packageRoot, 'build');
const chunks = fs.readdirSync(buildDirectory)
  .filter((name) => /^renderer-[A-Za-z0-9_-]+\.js$/.test(name));
let matchingChunks = 0;
let ancestorRetentionChunks = 0;
let branchLocalReadinessChunks = 0;
let scopedOverviewFallbackChunks = 0;
let preDiscardRecoveryChunks = 0;
for (const name of chunks) {
  const file = path.join(buildDirectory, name);
  let source = fs.readFileSync(file, 'utf8');
  const originalSource = source;
  const upstream = /\(([A-Za-z_$][\w$]*)\.loadSiblings \|\| \1\.loadAncestors\)/g;
  const patched = /\(([A-Za-z_$][\w$]*)\.loadSiblings \|\| \(\1\.loadAncestors && \1\.loadAncestorSiblings !== false\)\)/g;
  const upstreamMatches = [...source.matchAll(upstream)];
  const patchedMatches = [...source.matchAll(patched)];
  if (patchedMatches.length === 1 && upstreamMatches.length === 0) {
    matchingChunks += 1;
  } else if (upstreamMatches.length !== 1 || patchedMatches.length !== 0) {
    if (upstreamMatches.length || patchedMatches.length) {
      throw new Error(`${name}: ambiguous ancestor/sibling traversal condition`);
    }
  } else {
    const variable = upstreamMatches[0][1];
    source = source.replace(
      upstream,
      `(${variable}.loadSiblings || (${variable}.loadAncestors && ${variable}.loadAncestorSiblings !== false))`,
    );
    matchingChunks += 1;
  }

  const ancestorUpstream = /([A-Za-z_$][\w$]*)\.loadAncestors && ([A-Za-z_$][\w$]*)\.internal\.hasContent && \(\1\.markTileUsed\(\2\), \1\.queueTileForDownload\(\2\)\)/g;
  const ancestorPatched = /([A-Za-z_$][\w$]*)\.loadAncestors && ([A-Za-z_$][\w$]*)\.internal\.hasContent && ![A-Za-z_$][\w$]*\(\2\.internal\.loadingState\) && \(\1\.markTileUsed\(\2\), \1\.queueTileForDownload\(\2\)\)/g;
  const ancestorUpstreamMatches = [...source.matchAll(ancestorUpstream)];
  const ancestorPatchedMatches = [...source.matchAll(ancestorPatched)];
  if (ancestorUpstreamMatches.length === 1 && ancestorPatchedMatches.length === 0) {
    ancestorRetentionChunks += 1;
  } else if (ancestorPatchedMatches.length === 1 && ancestorUpstreamMatches.length === 0) {
    const [match, rendererVariable, tileVariable] = ancestorPatchedMatches[0];
    source = source.replace(match,
      `${rendererVariable}.loadAncestors && ${tileVariable}.internal.hasContent && (${rendererVariable}.markTileUsed(${tileVariable}), ${rendererVariable}.queueTileForDownload(${tileVariable}))`);
    ancestorRetentionChunks += 1;
  } else if (ancestorUpstreamMatches.length || ancestorPatchedMatches.length) {
    throw new Error(`${name}: ambiguous built ancestor-retention block`);
  }

  const readinessUpstream = /let ([A-Za-z_$][\w$]*) = !([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\), ([A-Za-z_$][\w$]*) = !\3\.internal\.hasContent \|\| ([A-Za-z_$][\w$]*)\(\3\.internal\.loadingState\);\s*\1 && \4 \|\| \3\.traversal\.allChildrenLoaded \|\| \(([A-Za-z_$][\w$]*) = !1\);/g;
  const readinessPatched = /let ([A-Za-z_$][\w$]*) = ([A-Za-z_$][\w$]*)\.internal\.hasRenderableContent \? \2\.internal\.loadingState === 4 : \2\.traversal\.allChildrenLoaded;\s*\1 \|\| \(([A-Za-z_$][\w$]*) = !1\);/g;
  const readinessUpstreamMatches = [...source.matchAll(readinessUpstream)];
  const readinessPatchedMatches = [...source.matchAll(readinessPatched)];
  if (readinessPatchedMatches.length === 1 && readinessUpstreamMatches.length === 0) {
    branchLocalReadinessChunks += 1;
  } else if (readinessUpstreamMatches.length === 1 && readinessPatchedMatches.length === 0) {
    const [match, readyVariable, , tileVariable, , , readyAccumulator] = readinessUpstreamMatches[0];
    source = source.replace(match,
      `let ${readyVariable} = ${tileVariable}.internal.hasRenderableContent ? ${tileVariable}.internal.loadingState === 4 : ${tileVariable}.traversal.allChildrenLoaded;\n\t\t\t\t${readyVariable} || (${readyAccumulator} = !1);`);
    branchLocalReadinessChunks += 1;
  } else if (readinessUpstreamMatches.length || readinessPatchedMatches.length) {
    throw new Error(`${name}: ambiguous built branch-local readiness block`);
  }

  const fallbackUpstream = /([A-Za-z_$][\w$]*)\.refine === "REPLACE" && !([A-Za-z_$][\w$]*) && \1\.traversal\.wasSetActive && ([A-Za-z_$][\w$]*)\(\1\) && \(\1\.traversal\.active = !0, ([A-Za-z_$][\w$]*)\(\1, ([A-Za-z_$][\w$]*)\)\)/g;
  const fallbackPatched = /([A-Za-z_$][\w$]*)\.refine === "REPLACE" && !([A-Za-z_$][\w$]*) && \(\1\.traversal\.wasSetActive \|\| ([A-Za-z_$][\w$]*)\.lodFallbackTiles\?\.has\(\1\)\) && ([A-Za-z_$][\w$]*)\(\1\) && \(\1\.traversal\.active = !0, ([A-Za-z_$][\w$]*)\(\1, \3\)\)/g;
  const fallbackUpstreamMatches = [...source.matchAll(fallbackUpstream)];
  const fallbackPatchedMatches = [...source.matchAll(fallbackPatched)];
  if (fallbackPatchedMatches.length === 1 && fallbackUpstreamMatches.length === 0) {
    scopedOverviewFallbackChunks += 1;
  } else if (fallbackUpstreamMatches.length === 1 && fallbackPatchedMatches.length === 0) {
    const [match, tileVariable, readyVariable, readyFunction, kickFunction, rendererVariable] = fallbackUpstreamMatches[0];
    source = source.replace(match,
      `${tileVariable}.refine === "REPLACE" && !${readyVariable} && (${tileVariable}.traversal.wasSetActive || ${rendererVariable}.lodFallbackTiles?.has(${tileVariable})) && ${readyFunction}(${tileVariable}) && (${tileVariable}.traversal.active = !0, ${kickFunction}(${tileVariable}, ${rendererVariable}))`);
    scopedOverviewFallbackChunks += 1;
  } else if (fallbackUpstreamMatches.length || fallbackPatchedMatches.length) {
    throw new Error(`${name}: ambiguous built scoped overview fallback block`);
  }

  const discardUpstream = /if \(([A-Za-z_$][\w$]*)\.getMemoryUsage\(([A-Za-z_$][\w$]*)\) === 0 && ([A-Za-z_$][\w$]*) > 0 && \1\.isFull\(\)\) \{\s*\1\.remove\(\2\);\s*return;\s*\}/g;
  const discardPatched = /if \(([A-Za-z_$][\w$]*)\.getMemoryUsage\(([A-Za-z_$][\w$]*)\) === 0 && ([A-Za-z_$][\w$]*) > 0 && \1\.isFull\(\)\) \{\s*this\.dispatchEvent\(\{ type: "tile-memory-pressure", tile: \2, bytesUsed: \3 \}\);\s*if \(\1\.isFull\(\)\) \{\s*\1\.remove\(\2\);\s*return;\s*\}\s*\}/g;
  const discardUpstreamMatches = [...source.matchAll(discardUpstream)];
  const discardPatchedMatches = [...source.matchAll(discardPatched)];
  if (discardPatchedMatches.length === 1 && discardUpstreamMatches.length === 0) {
    preDiscardRecoveryChunks += 1;
  } else if (discardUpstreamMatches.length === 1 && discardPatchedMatches.length === 0) {
    const [match, cacheVariable, tileVariable, bytesVariable] = discardUpstreamMatches[0];
    source = source.replace(match,
      `if (${cacheVariable}.getMemoryUsage(${tileVariable}) === 0 && ${bytesVariable} > 0 && ${cacheVariable}.isFull()) {\n\t\t\t\tthis.dispatchEvent({ type: "tile-memory-pressure", tile: ${tileVariable}, bytesUsed: ${bytesVariable} });\n\t\t\t\tif (${cacheVariable}.isFull()) {\n\t\t\t\t\t${cacheVariable}.remove(${tileVariable});\n\t\t\t\t\treturn;\n\t\t\t\t}\n\t\t\t}`);
    preDiscardRecoveryChunks += 1;
  } else if (discardUpstreamMatches.length || discardPatchedMatches.length) {
    throw new Error(`${name}: ambiguous built pre-discard recovery block`);
  }

  if (source !== originalSource) fs.writeFileSync(file, source);
}

if (matchingChunks !== 1) {
  throw new Error(`expected one built renderer traversal chunk, patched ${matchingChunks}`);
}
if (ancestorRetentionChunks !== 1) {
  throw new Error(`expected one built renderer ancestor-retention chunk, patched ${ancestorRetentionChunks}`);
}
if (branchLocalReadinessChunks !== 1) {
  throw new Error(`expected one built renderer branch-local readiness chunk, patched ${branchLocalReadinessChunks}`);
}
if (scopedOverviewFallbackChunks !== 1) {
  throw new Error(`expected one built renderer scoped overview fallback chunk, patched ${scopedOverviewFallbackChunks}`);
}
if (preDiscardRecoveryChunks !== 1) {
  throw new Error(`expected one built renderer pre-discard recovery chunk, patched ${preDiscardRecoveryChunks}`);
}
