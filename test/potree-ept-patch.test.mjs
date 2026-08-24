import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {patchPotreeEptSource} from '../scripts/patch-potree-ept.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const shared='new Potree.PointCloudCopcGeometryNode(geometry)';
const nonexistent='new Potree.PointCloudEptGeometryNode(geometry)';
const bundle=(eptNode=shared)=>`prefix class EptLoader { static load(){ ${eptNode}; } } class CopcLoader { static load(){ ${shared}; } } suffix`;

test('Potree 1.8.2 keeps the shared COPC/EPT geometry node constructor',()=>{
  const source=bundle();
  assert.equal(patchPotreeEptSource(source),source);
});

test('the production patch repairs the non-exported EPT constructor regression',()=>{
  const repaired=patchPotreeEptSource(bundle(nonexistent));
  assert.equal(repaired.includes(nonexistent),false);
  assert.equal(repaired.split(shared).length-1,2);
});

test('unknown Potree loader layouts fail the image build closed',()=>{
  assert.throws(()=>patchPotreeEptSource('class EptLoader {} class CopcLoader {}'),/COPC loader signature changed/);
  assert.throws(()=>patchPotreeEptSource(bundle('new UnknownNode(geometry)')),/EPT loader signature changed/);
});

test('container build enforces the EPT contract before Vite copies Potree',()=>{
  const docker=fs.readFileSync(path.join(root,'Dockerfile'),'utf8');
  assert.match(docker,/COPY --from=potree \/potree \.\/public\/potree\s+RUN node scripts\/patch-potree-ept\.mjs public\/potree\/build\/potree\/potree\.js\s+RUN npx vite build/);
});
