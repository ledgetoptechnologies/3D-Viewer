import fs from 'node:fs';

const file=process.argv[2];
if(!file)throw new Error('Potree bundle path is required');
const source=fs.readFileSync(file,'utf8');
const start=source.indexOf('class EptLoader');
const end=source.indexOf('class CopcLoader',start+1);
if(start<0||end<=start)throw new Error('pinned Potree EPT/COPC loader boundaries changed');
const wrong='new Potree.PointCloudCopcGeometryNode(geometry)';
const right='new Potree.PointCloudEptGeometryNode(geometry)';
const block=source.slice(start,end);
const wrongCount=block.split(wrong).length-1;
if(wrongCount!==1||block.includes(right))throw new Error('pinned Potree EPT loader signature changed');
if(!source.slice(end).includes(wrong))throw new Error('pinned Potree COPC loader signature changed');
const patched=source.slice(0,start)+block.replace(wrong,right)+source.slice(end);
const temporary=`${file}.patched-${process.pid}`;
fs.writeFileSync(temporary,patched,{mode:fs.statSync(file).mode});
fs.renameSync(temporary,file);
