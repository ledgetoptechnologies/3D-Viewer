#!/usr/bin/env node

import path from 'node:path';
import { auditFailureExitCode, writeLodProvenance } from './lib/lod-equivalence.mjs';

function usage() {
  console.error('Usage: npm run audit:lod -- <derivative-directory> <source.glb> [--tolerance <model-units>] [--external-source]');
}

async function main() {
  const args = process.argv.slice(2);
  const derivativeDir = args.shift();
  const sourceGlb = args.shift();
  let tolerance;
  let allowExternalSource = false;
  while (args.length) {
    const flag = args.shift();
    if (flag === '--tolerance' && args.length) tolerance = Number(args.shift());
    else if (flag === '--external-source') allowExternalSource = true;
    else throw new Error(`unknown or incomplete argument: ${flag}`);
  }
  if (!derivativeDir || !sourceGlb) {
    usage();
    process.exitCode = 2;
    return;
  }
  const result = await writeLodProvenance({
    derivativeDir: path.resolve(derivativeDir),
    sourceGlb: path.resolve(sourceGlb),
    allowExternalSource,
    ...(tolerance === undefined ? {} : { tolerance }),
  });
  console.log(JSON.stringify({ valid: true, output: result.outputPath, audit: result.provenance.audit }, null, 2));
}

try {
  await main();
} catch (error) {
  console.error(JSON.stringify({ valid: false, error: error.message }, null, 2));
  process.exitCode = auditFailureExitCode(error);
}
