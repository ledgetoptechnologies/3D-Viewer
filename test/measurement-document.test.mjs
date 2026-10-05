import test from 'node:test';
import assert from 'node:assert/strict';
import {measurementCollection,measurementMetrics,measurementValue,validateMeasurementGeometry,exportMeasurements} from '../measurement-document.mjs';
import {createMeasurementStore} from '../measurement-store.mjs';
const polygon={id:'0e439915-bcda-4c90-852a-9e0a7f48c7ce',name:'North face',collection:'spatial3d',kind:'polygon',coordinateReference:{crs:'EPSG:32616',verticalUnit:'m'},vertices:[[500000,4800000,2],[500010,4800000,2],[500010,4800010,2],[500000,4800010,2]],visible:true,source:{kind:'mesh'}};

test('exports preserve density provenance and explicit estimated inventory bases',()=>{
  const materialDensity={value:600,unit:'kg/m3',basis:'as_fed',dryMatterPercent:35,sourceNote:'Client cores',sampledOn:'2026-06-19'};
  const r={...polygon,materialDensity,results:{cutM3:10,fillM3:9,netM3:1,coverage:1,status:'complete'}};
  const document=JSON.parse(exportMeasurements([r],'json')).measurements[0];
  assert.deepEqual(document.materialDensity,materialDensity);
  assert.equal(document.materialMassEstimate.volumeBasis,'cut_above_base');
  assert.equal(document.materialMassEstimate.asFed.kilograms,6000);
  assert.equal(document.materialMassEstimate.dryMatter.kilograms,2100);
  const feature=JSON.parse(exportMeasurements([r],'geojson',{toLonLat:()=>[-90,40]})).features[0];
  assert.deepEqual(feature.properties.materialDensity,materialDensity);
  assert.deepEqual(feature.properties.materialMassEstimate,document.materialMassEstimate);
  const csv=exportMeasurements([r],'csv');
  assert.match(csv,/"density_value","density_unit","density_basis"/);
  assert.match(csv,/"estimated_as_fed_us_short_tons"/);
  assert.match(csv,/"600","kg\/m3","as_fed","35","Client cores","2026-06-19","cut_above_base","10","6000"/);
  assert.match(csv,/material was not weighed/);
});

test('exports leave mass blank or null when only historical or invalidated volume exists',()=>{
  const materialDensity={value:48.4,unit:'lb/ft3',basis:'as_fed'};
  for(const results of [{previousVolume:{cutM3:10}},{cutM3:10,volumeInvalidated:true},{cutM3:10,status:'geometry-only'}]){
    const r={...polygon,materialDensity,results};
    assert.equal(JSON.parse(exportMeasurements([r],'json')).measurements[0].materialMassEstimate,null);
    assert.equal(JSON.parse(exportMeasurements([r],'geojson',{toLonLat:()=>[-90,40]})).features[0].properties.materialMassEstimate,null);
    const row=exportMeasurements([r],'csv').split('\r\n')[1];
    assert.ok(row.endsWith(',"","","","","","","","","","",""'));
  }
});

test('exports tolerate legacy numeric overflow and omit incomplete inventory',()=>{
  const materialDensity={value:48.4,unit:'lb/ft3',basis:'as_fed'};
  const records=[{...polygon,materialDensity:{...materialDensity,value:Number.MAX_VALUE},results:{cutM3:1}},{...polygon,materialDensity,results:{cutM3:Number.MAX_VALUE}},{...polygon,materialDensity,results:{cutM3:10,coverage:.9}}];
  const docs=JSON.parse(exportMeasurements(records,'json')).measurements;
  assert.ok(docs.every(r=>r.materialMassEstimate===null));
  assert.equal(docs[0].materialDensity.value,Number.MAX_VALUE);
  assert.doesNotThrow(()=>exportMeasurements(records,'csv'));
  assert.ok(JSON.parse(exportMeasurements(records,'geojson',{toLonLat:()=>[-90,40]})).features.every(f=>f.properties.materialMassEstimate===null));
});
test('renderer groups share coordinates without conflating map and model collections',()=>{assert.equal(measurementCollection('model'),measurementCollection('cloud'));assert.equal(measurementCollection('dsm'),measurementCollection('ortho'));assert.notEqual(measurementCollection('dtm'),measurementCollection('model'));});
test('full precision areas, vertical planes and nonplanarity are explicit',()=>{const m=validateMeasurementGeometry(polygon);assert.equal(m.horizontalAreaM2,100);assert.equal(m.planarAreaM2,100);assert.equal(m.lengthM,40);const wall={...polygon,vertices:[[0,0,0],[0,10,0],[0,10,10],[0,0,10]]};assert.equal(validateMeasurementGeometry(wall).planarAreaM2,100);assert.equal(measurementMetrics(wall).horizontalAreaM2,0);assert.equal(measurementMetrics({...polygon,vertices:[[0,0,0],[10,0,0],[10,10,1],[0,10,0]]}).planarAreaM2,null);});
test('invalid geometry rejected instead of plausible quantities',()=>{assert.throws(()=>validateMeasurementGeometry({...polygon,vertices:[[0,0,0],[1,1,0],[0,1,0],[1,0,0]]}));assert.throws(()=>validateMeasurementGeometry({...polygon,vertices:[[0,0,0],[1,0,0],[1,0,0]]}));});
test('three decimals are display only, volume defaults to cubic yards and unit systems are explicit',()=>{assert.equal(measurementValue(0.9144**3,3),'1.000 yd³');assert.equal(measurementValue(0.3048**3,3,'feet'),'0.037 yd³');assert.equal(measurementValue(1,3,'metric'),'1.000 m³');assert.equal(measurementValue(0.3048**2,2),'1.000 ft²');assert.equal(measurementValue(1.234567,2,'metric'),'1.235 m²');assert.equal(measurementValue(0.9144,1,'yards'),'1.000 yd');assert.equal(measurementValue(0.3048,1),'1′ 0.000″');});
test('human quantities group thousands and millions without changing machine-readable precision',()=>{assert.equal(measurementValue(26122.202123,2,'metric'),'26,122.202 m²');assert.equal(measurementValue(1234567.890123,3,'metric'),'1,234,567.890 m³');assert.equal(measurementValue(1000*0.3048,1),'1,000′ 0.000″');const result=JSON.parse(exportMeasurements([{...polygon,results:{cutM3:26122.202123}}],'json'));assert.equal(result.measurements[0].results.cutM3,26122.202123);assert.match(exportMeasurements([{...polygon,results:{cutM3:26122.202123}}],'csv'),/26122\.202123/);});

test('CSV summaries add labelled full-precision display volumes without replacing canonical SI data',()=>{
  const result={cutM3:0.9144**3,fillM3:0,netM3:0.9144**3,volumeM3:1.23456789123},record={...polygon,results:result};
  for(const [units,label,factor] of [['imperial','yd³',1/0.9144**3],['feet','yd³',1/0.9144**3],['yards','yd³',1/0.9144**3],['metric','m³',1],['centimeters','cm³',1e6]]){
    const [header,row]=exportMeasurements([record],'csv',{units}).split('\r\n');
    assert.match(header,/"cut_m3","fill_m3","net_m3"/);
    assert.ok(header.includes('"display_volume_unit","cut_display_volume","fill_display_volume","net_display_volume","object_display_volume"'));
    assert.ok(row.includes(`"${result.volumeM3}"`),'canonical quantity remains unrounded');
    assert.ok(row.includes(`"${label}","${result.cutM3*factor}","0","${result.netM3*factor}","${result.volumeM3*factor}"`));
    assert.equal(JSON.parse(exportMeasurements([record],'json',{units})).measurements[0].results.volumeM3,result.volumeM3);
  }
  const empty=exportMeasurements([{...polygon,results:{}}],'csv');assert.ok(empty.includes('"yd³","","","",""'),'missing values are blank, not invented zero');
});
test('exports preserve source data, neutralize formula labels, use DXF metres and geographic XY',()=>{const r={...polygon,name:'=SUM(A1)'};assert.match(exportMeasurements([r],'csv'),/'=SUM/);assert.equal(JSON.parse(exportMeasurements([r],'json')).measurements[0].vertices[0][0],500000);assert.match(exportMeasurements([r],'dxf'),/\$INSUNITS\r\n70\r\n6/);assert.throws(()=>exportMeasurements([r],'geojson'));const geo=JSON.parse(exportMeasurements([r],'geojson',{toLonLat:()=>[-87,43]}));assert.equal(geo.features[0].geometry.coordinates[0].length,5);assert.deepEqual(geo.features[0].geometry.coordinates[0][0],[-87,43]);});
test('public documents stay memory-only and new page has no documents',async()=>{let calls=0;const store=createMeasurementStore({token:()=>null,fetcher:()=>calls++});await store.load();await store.save(polygon);assert.equal(store.records.size,1);assert.equal(calls,0);assert.equal(createMeasurementStore({token:()=>null}).records.size,0);});
test('private writes use fresh credentials and accepted revisions',async()=>{let credential='first',revision=0;const requests=[];const store=createMeasurementStore({token:()=>credential,fetcher:async(url,options)=>{requests.push(options);return {ok:true,json:async()=>({measurement:{...JSON.parse(options.body),revision:++revision}})}}});await store.save(polygon);credential='renewed';await store.save({...store.records.get(polygon.id),name:'Changed'});assert.equal(requests[1].headers.Authorization,'Bearer renewed');assert.equal(JSON.parse(requests[1].body).revision,1);assert.equal(requests[1].method,'PUT');assert.equal(store.records.get(polygon.id).revision,2);});
test('conflict retains unsaved draft with explicit status, never silently overwrites',async()=>{let fail=false;const store=createMeasurementStore({token:()=> 'token',fetcher:async()=>({ok:!fail,status:fail?409:200,json:async()=>({measurement:{...polygon,revision:1}})})});await store.save(polygon);fail=true;await assert.rejects(store.save({...store.records.get(polygon.id),name:'Unsaved'}),/another tab/);assert.match(store.statuses.get(polygon.id),/Not saved/);assert.equal(store.records.get(polygon.id).name,'Unsaved');});

test('reload shares the write queue so a save during delayed reads is not erased',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});const requests=[];
  const store=createMeasurementStore({token:()=> 'token',fetcher:async(_url,options)=>{
    requests.push(options.method);
    if(options.method==='GET'){await gate;return{ok:true,json:async()=>({measurements:[],capabilities:{personalPersistence:true}})};}
    return{ok:true,json:async()=>({measurement:{...JSON.parse(options.body),revision:1}})};
  }});
  const loaded=store.load();await Promise.resolve();const saved=store.save(polygon);
  assert.deepEqual(requests,['GET','GET']);release();await Promise.all([loaded,saved]);
  assert.equal(store.records.get(polygon.id).name,polygon.name);assert.equal(store.statuses.get(polygon.id),'Saved');
  assert.deepEqual(requests,['GET','GET','POST']);
});

test('stale local revisions cannot overwrite newer edits in the same tab',async()=>{
  let revision=0,calls=0;const store=createMeasurementStore({token:()=> 'token',fetcher:async(_url,options)=>{calls++;return{ok:true,json:async()=>({measurement:{...JSON.parse(options.body),revision:++revision}})};}});
  await store.save(polygon);const snapshot=structuredClone(store.records.get(polygon.id));
  await store.save({...snapshot,name:'New name'});
  await assert.rejects(store.save({...snapshot,visible:false}),/changed or was deleted/);
  assert.equal(calls,2);assert.equal(store.records.get(polygon.id).name,'New name');assert.equal(store.records.get(polygon.id).visible,true);
});

test('DELETE 204 removes the record and status without trying to decode JSON',async()=>{
  const store=createMeasurementStore({token:()=> 'token',fetcher:async(_url,options)=>options.method==='DELETE'?{ok:true,status:204,json:()=>{throw new Error('204 has no JSON');}}:{ok:true,json:async()=>({measurement:{...JSON.parse(options.body),revision:1}})}});
  await store.save(polygon);await store.remove(polygon.id);
  assert.equal(store.records.has(polygon.id),false);assert.equal(store.statuses.has(polygon.id),false);
  await assert.rejects(store.save(polygon),/changed or was deleted/);
});

test('results attach only to unchanged geometry and revision, never resurrect deleted measurements',async()=>{
  let revision=0;const store=createMeasurementStore({token:()=> 'token',fetcher:async(_url,options)=>options.method==='DELETE'?{ok:true,status:204}:{ok:true,json:async()=>({measurement:{...JSON.parse(options.body),revision:++revision}})}});
  await store.save(polygon);const snapshot=structuredClone(store.records.get(polygon.id));
  await store.attachResults(snapshot,{cutM3:10,status:'complete'});assert.equal(store.records.get(polygon.id).results.cutM3,10);
  await assert.rejects(store.attachResults(snapshot,{cutM3:999}),/changed or was deleted/);
  const latest=structuredClone(store.records.get(polygon.id));await store.remove(polygon.id);
  await assert.rejects(store.attachResults(latest,{cutM3:999}),/changed or was deleted/);assert.equal(store.records.has(polygon.id),false);
});

test('temporary result attachment merges only results and guards changed source geometry',async()=>{
  const store=createMeasurementStore({token:()=>null});await store.save(polygon);
  const snapshot=structuredClone(store.records.get(polygon.id));await store.save({...snapshot,name:'Temporary renamed',visible:false});
  await store.attachResults(snapshot,{cutM3:10});assert.equal(store.records.get(polygon.id).name,'Temporary renamed');assert.equal(store.records.get(polygon.id).visible,false);
  const changed=structuredClone(store.records.get(polygon.id));changed.vertices[1][0]+=1;await store.save(changed);
  await assert.rejects(store.attachResults(snapshot,{cutM3:99}),/changed or was deleted/);
  const current=structuredClone(store.records.get(polygon.id));const deleting=store.remove(polygon.id);
  await assert.rejects(store.attachResults(current,{cutM3:99}),/changed or was deleted/);await deleting;assert.equal(store.records.size,0);
});
