import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import { renderMeasurementReport } from '../measurement-report-document.mjs';

const record = { id: 'pile-1', name: 'North pile', kind: 'polygon', collection: 'spatial3d', vertices: [[0,0,0],[2,0,0],[2,2,0],[0,2,0]], results: { method: 'surface-cut-fill', status: 'incomplete', netM3: 3.123456, cutM3: 4, fillM3: .876544, coverage: .8, warnings: ['Missing coverage'] } };
const options = { records: [record], units: 'metric', modelName: 'Quarry <west>', createdAt: '2026-09-23T12:00:00Z', coordinateReference: {crs:'EPSG:32616'} };
const image = 'data:image/png;base64,YQ==';

test('print keeps ordinary appendix records together without clipping oversized records',()=>{
  const css=readFileSync(new URL('../measurement-report-document.css',import.meta.url),'utf8');
  assert.match(css,/@media print[\s\S]*\.measurement-report-detail\s*\{\s*break-inside:\s*avoid;\s*\}/);
  assert.doesNotMatch(css,/\.measurement-report-detail\s*\{[^}]*(?:max-height|overflow:\s*hidden)/);
});

test('report has readable identity and concise quantities before detailed appendix', () => {
  const html = renderMeasurementReport(options);
  assert.match(html, /<h1>Measurements report<\/h1>/);
  assert.match(html, /measurement-report-brand">Ledge Top Drone Services <span>/);
  assert.match(html, /Quarry &lt;west&gt;/);
  assert.match(html, /September 23, 2026/);
  const summary = html.slice(html.indexOf('class="measurement-report-summary"'), html.indexOf('class="measurement-report-appendix"'));
  assert.match(summary, /4\.000 m²/);
  assert.match(summary, /8\.000 m/);
  assert.match(summary, /3\.123 m³/);
  assert.match(summary, /incomplete/);
  assert.doesNotMatch(summary, /Edge lengths/);
  assert.match(summary, /Display precision does not establish survey accuracy/);
  assert.match(html, /Edge lengths \(3D\)/);
  assert.match(html, /Missing coverage/);
});

test('imperial report volume quantities use cubic yards while metric remains cubic metres',()=>{
  const imperial=renderMeasurementReport({...options,units:'imperial'});
  assert.match(imperial,/4\.085 yd³/);
  assert.doesNotMatch(imperial,/ft³/);
  assert.match(renderMeasurementReport(options),/3\.123 m³/);
});

test('net volume does not substitute enclosed-object volume or sum overlapping records', () => {
  const html = renderMeasurementReport({...options, records: [record, {...record, id:'pile-2', results: {volumeM3:999, method:'closed-mesh', verified:false}}]});
  const summary = html.slice(html.indexOf('<tbody>'), html.indexOf('</tbody>'));
  assert.doesNotMatch(summary, /999/);
  assert.match(summary, /Enclosed volume in appendix/);
  assert.match(html, /Enclosed volume: 999\.000 m³/);
  assert.match(html, /Not independently verified/);
  assert.match(html, /Overlapping measurements are not summed/);
});

test('map geometry uses horizontal length, and zero net remains a valid quantity', () => {
  const html = renderMeasurementReport({...options, records:[{...record, collection:'map', kind:'distance', vertices:[[0,0,0],[3,4,12]],results:{netM3:0,status:'complete'}}]});
  const summary = html.slice(html.indexOf('<tbody>'), html.indexOf('</tbody>'));
  assert.match(summary, /5\.000 m/);
  assert.doesNotMatch(summary, /13\.000 m/);
  assert.match(summary, /0\.000 m³/);
  assert.match(html, /Edge lengths \(horizontal\)/);
});

test('images are independently labeled and toggled with a current placeholder when absent', () => {
  const html = renderMeasurementReport({...options,currentView:{src:image,label:'Perspective'},orthographicView:{src:image,label:'Orthographic site view'}});
  assert.match(html, /data-report-toggle="current" checked/);
  assert.match(html, /data-report-toggle="ortho" checked/);
  assert.ok(html.indexOf('data-report-image="current"') < html.indexOf('data-report-image="ortho"'));
  assert.match(html, /alt="Perspective"/);
  const missing = renderMeasurementReport(options);
  assert.match(missing, /data-report-image="current" alt="Current view" hidden/);
  assert.doesNotMatch(missing, /data-report-toggle=/);
});

test('untrusted text and image URLs cannot inject report markup', () => {
  const html = renderMeasurementReport({...options, modelName:'<script>alert(1)</script>', records:[{...record,name:'<img src=x onerror=alert(1)>'}],currentView:{src:'javascript:alert(1)'}, orthographicView:{src:'data:image/svg+xml;base64,YQ=='}, calculationSummary:()=>'<iframe src=x></iframe>'});
  assert.doesNotMatch(html, /<script|<iframe|onerror=alert\(1\)>|javascript:|data:image\/svg/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;iframe/);
  assert.doesNotMatch(html, /data-report-toggle=/);
});

test('empty selection remains printable without an empty appendix', () => {
  const html = renderMeasurementReport({records:[],createdAt:'invalid'});
  assert.match(html, /No measurements selected/);
  assert.match(html, /Date unavailable/);
  assert.doesNotMatch(html, /class="measurement-report-appendix"/);
});

test('calculation appendix retains base, estimate, coverage and height evidence without serializing private sources', () => {
  const html = renderMeasurementReport({...options,records:[{...record,results:{...record.results,estimated:true,reference:{type:'custom',offsetM:0,elevationM:100},verticalUnitBasis:'reviewed-source-provenance',sourceVerticalUnit:'m',source:{kind:'dsm',url:'https://private.example/token',token:'secret'},verticalUnitEvidence:{verticalDatum:'unknown'}}}]});
  assert.match(html,/Estimated quantity/);
  assert.match(html,/Base method: custom/);
  assert.match(html,/Base offset: 0\.000 m/);
  assert.match(html,/Base elevation: 100\.000 m/);
  assert.match(html,/Coverage: 80\.000%/);
  assert.match(html,/Height unit basis: reviewed-source-provenance/);
  assert.match(html,/Vertical datum: unknown/);
  assert.doesNotMatch(html,/private\.example|secret/);
});

test('inventory appendix labels supplied density and estimates cut volume in correct mass units', () => {
  const density = {value:600,unit:'kg/m3',basis:'as_fed',dryMatterPercent:35,sourceNote:'Client <script>sample</script>',sampledOn:'2026-06-19'};
  const records = [{...record,materialDensity:density,results:{cutM3:10,fillM3:9,netM3:1,coverage:1,status:'complete'}}];
  const metric = renderMeasurementReport({...options,records});
  assert.match(metric,/600 kg\/m³ \(as-fed\)/);
  assert.match(metric,/Above-base \(cut\) volume/);
  assert.match(metric,/6\.000 metric tonnes/);
  assert.match(metric,/2\.100 metric tonnes/);
  assert.match(metric,/35%/);
  assert.match(metric,/Dry-matter mass calculated from entered dry-matter percentage/);
  assert.match(metric,/2026-06-19/);
  assert.match(metric,/Client &lt;script&gt;sample&lt;\/script&gt;/);
  assert.doesNotMatch(metric,/<script>/);
  assert.match(metric,/material was not weighed/);
  assert.match(metric,/representative density samples and volume\/base-surface accuracy/);
  const imperial = renderMeasurementReport({...options,records,units:'imperial'});
  assert.match(imperial,/6\.614 US short tons/);
  assert.match(imperial,/2\.315 US short tons/);
  const summary = metric.slice(metric.indexOf('<thead>'),metric.indexOf('</thead>'));
  assert.equal((summary.match(/<th /g)||[]).length,4);
});

test('density report shows unavailable stale mass and retains the entered dry-matter basis', () => {
  const materialDensity = {value:17.22,unit:'lb/ft3',basis:'dry_matter'};
  const stale = renderMeasurementReport({...options,records:[{...record,materialDensity,results:{cutM3:100,volumeInvalidated:true,previousVolume:{cutM3:100}}}]});
  assert.match(stale,/calculate a current material volume/);
  assert.doesNotMatch(stale,/metric tonnes/);
  const current = renderMeasurementReport({...options,units:'imperial',records:[{...record,materialDensity,results:{volumeM3:.9144**3,method:'closed-mesh',status:'complete',checks:{closed:true,edgeManifold:true,vertexManifold:true,orientationConsistent:true,selfIntersections:false}}}]});
  assert.match(current,/17\.22 lb\/ft³ \(dry matter\)/);
  assert.match(current,/Enclosed-object volume/);
  assert.match(current,/0\.232 US short tons/);
  assert.match(current,/Unavailable without dry-matter percentage/);
  assert.doesNotMatch(renderMeasurementReport(options),/Estimated material inventory/);
});

test('reports suppress partial inventory and remain printable with overflow legacy inputs',()=>{
  const materialDensity={value:48.4,unit:'lb/ft3',basis:'as_fed'};
  for(const results of [{cutM3:10,coverage:.8},{cutM3:10,status:'incomplete'}]){
    const html=renderMeasurementReport({...options,records:[{...record,materialDensity,results}]});
    assert.match(html,/completed surface calculation|calculate a current material volume/);
    assert.doesNotMatch(html,/metric tonnes/);
  }
  for(const r of [{...record,materialDensity:{...materialDensity,value:Number.MAX_VALUE},results:{cutM3:1}},{...record,materialDensity,results:{cutM3:Number.MAX_VALUE,status:'complete',coverage:1}}]){
    const html=renderMeasurementReport({...options,records:[r,record]});
    assert.match(html,/invalid numeric|exceed the supported numeric range/);
    assert.match(html,/2\. North pile/);
  }
});

test('report explains missing surface evidence instead of showing mass',()=>{
  const materialDensity={value:48.4,unit:'lb/ft3',basis:'as_fed'};
  for(const coverage of [undefined,null,'1',NaN]){
    const html=renderMeasurementReport({...options,records:[{...record,materialDensity,results:{cutM3:10,status:'complete',coverage}}]});
    assert.match(html,/confirmed 100% numeric surface coverage/);
    assert.doesNotMatch(html,/metric tonnes|US short tons/);
  }
});

test('reconstructed inventory report retains inferred enclosure caveat',()=>{
  const materialDensity={value:48.4,unit:'lb/ft3',basis:'as_fed'};
  const results={volumeM3:1,method:'reconstructed-estimate',status:'estimate',checks:{closed:true,edgeManifold:true,vertexManifold:true,orientationConsistent:true,selfIntersections:false}};
  const html=renderMeasurementReport({...options,records:[{...record,materialDensity,results}]});
  assert.match(html,/inferred geometry.*unseen underside/);
  assert.match(html,/not validated observed-object volume/);
});
