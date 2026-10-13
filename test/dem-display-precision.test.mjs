import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {formatElevation} from '../unit-formatters.mjs';

const source=fs.readFileSync(new URL('../main.js',import.meta.url),'utf8');
function shippedFunction(name){
  const start=source.indexOf(`function ${name}(`);
  assert.notEqual(start,-1,`${name} remains bound to the shipped implementation`);
  const end=source.indexOf('\nfunction ',start+1);
  assert.notEqual(end,-1);
  return source.slice(start,end);
}

// This tests shipped renderer/hover function integration with deterministic
// raster-reader and DOM/canvas adapters. It is not authenticated live-browser,
// GeoTIFF projection, source-accuracy, or browser paint acceptance.
for(const units of ['imperial','metric'])for(const kind of ['dsm','dtm']){
  test(`shipped ${kind.toUpperCase()} legend and sampled hover retain three decimal places in ${units}`,async()=>{
    const expected=units==='metric'?['100.125 m','100.625 m']:['328.494 ft','330.135 ft'];
    const hoverElevation=kind==='dsm'?100.625:100.125;
    const reads=[];
    const image={getWidth:()=>2,readRasters:async options=>{
      reads.push(options);
      return [new Float32Array([hoverElevation])];
    }};
    const ds={min:100.125,max:100.625,minE:0,maxE:2,minN:0,maxN:2,W:2,H:2,nodata:-9999,images:[image]};
    const context={
      DISPLAY_UNITS:units,formatElevation,
      demSettings:{minFt:null,maxFt:null,steps:0,cmap:'viridis'},
      COLORMAPS:{viridis:[]},sampleCmap:()=>[10,20,30],
      elevationInputMeters:value=>units==='metric'?value:value*0.3048,
      dom:{legendCanvas:{width:12,height:40,getContext:()=>({fillRect(){}})},demLegendLabels:{innerHTML:''},demHover:{textContent:'',style:{}}},
      latLonToUtm:(lat,lng)=>[lng,lat],modeAbortController:{signal:new AbortController().signal},geoPool:{},
    };
    vm.createContext(context);
    vm.runInContext(['refreshLegendFor','showDemHover','updateLegend'].map(shippedFunction).join('\n'),context);
    for(const steps of [0,4,10]){
      context.demSettings.steps=steps;
      context.refreshLegendFor(ds);
      const labels=[...context.dom.demLegendLabels.innerHTML.matchAll(/<span>([^<]+)<\/span>/g)].map(match=>match[1]).filter(value=>value!=='&nbsp;');
      assert.equal(labels[0],expected[1],'top legend endpoint is the highest elevation');
      assert.equal(labels.at(-1),expected[0],'bottom legend endpoint is the lowest elevation');
      assert.ok(labels.length>=3);
      for(const label of labels)assert.match(label,units==='metric'?/^-?\d+\.\d{3} m$/:/^-?\d+\.\d{3} ft$/);
    }
    context.showDemHover({latlng:{lat:1,lng:1}},{ds});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(context.dom.demHover.textContent,`Elevation: ${expected[kind==='dsm'?1:0]}`);
    assert.equal(context.dom.demHover.style.display,'block');
    assert.equal(reads.length,1);
    assert.deepEqual(Array.from(reads[0].window),[1,1,2,2]);
    assert.equal(reads[0].signal,context.modeAbortController.signal);
  });
}
