import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const patcher=path.join(root,'scripts','patch-potree-ept.mjs');

test('pinned Potree patch corrects classic EPT without changing genuine COPC',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'potree-ept-patch-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const target=path.join(directory,'potree.js');
  const wrong='new Potree.PointCloudCopcGeometryNode(geometry)';
  fs.writeFileSync(target,`class EptLoader { load(){ return ${wrong}; } }\nclass CopcLoader { load(){ return ${wrong}; } }`);
  execFileSync(process.execPath,[patcher,target]);
  const patched=fs.readFileSync(target,'utf8');
  assert.match(patched,/class EptLoader[^]*new Potree\.PointCloudEptGeometryNode\(geometry\)/);
  assert.match(patched,/class CopcLoader[^]*new Potree\.PointCloudCopcGeometryNode\(geometry\)/);
  assert.throws(()=>execFileSync(process.execPath,[patcher,target],{stdio:'pipe'}));
});

test('container build applies the fail-closed patch before Vite copies Potree',()=>{
  const docker=fs.readFileSync(path.join(root,'Dockerfile'),'utf8');
  assert.match(docker,/COPY --from=potree \/potree \.\/public\/potree\s+RUN node scripts\/patch-potree-ept\.mjs public\/potree\/build\/potree\/potree\.js\s+RUN npx vite build/);
});
