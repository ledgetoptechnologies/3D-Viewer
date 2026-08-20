'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');
const root=path.join(__dirname,'..');
const source=fs.readFileSync(path.join(root,'workspace-projects.js'),'utf8');
const processingApi=fs.readFileSync(path.join(root,'server','processingApi.js'),'utf8');
const html=fs.readFileSync(path.join(root,'workspace.html'),'utf8');
const css=fs.readFileSync(path.join(root,'workspace-management.css'),'utf8');

test('workspace is project-first with an instant responsive project filter',()=>{
  assert.match(html,/workspace-projects\.js/);
  assert.match(source,/\['dashboard','⌂','Dashboard'\]/);
  assert.doesNotMatch(source,/\['review'.*Review/);
  assert.match(source,/id="project-filter"/);
  assert.match(source,/filter\.oninput/);
  assert.match(source,/data-project-name/);
  assert.match(source,/function pagedApi/);
  assert.match(css,/\.project-row/);
  assert.match(css,/@media\(max-width:720px\)/);
});

test('project detail owns import processing GCP outputs review and sharing',()=>{
  for(const value of ['project-import','project-process','project-share','gcp-import-form','Outputs and review','Review & publish','client-grant-form','share-form'])assert.ok(source.includes(value),value);
  for(const permission of ['viewer.shares.create','viewer.shares.read','viewer.shares.revoke','viewer.client_grants.manage'])assert.match(source,new RegExp(`'${permission.replaceAll('.','\\.')}'`));
  assert.match(source,/\['viewer\.shares\.create','viewer\.shares\.read','viewer\.shares\.revoke','viewer\.client_grants\.manage'\]\.some\(can\)/);
  assert.match(source,/if\(can\('viewer\.shares\.read'\)\|\|can\('viewer\.shares\.revoke'\)\)/);
  assert.match(source,/const list=mayRead\|\|mayRevoke\?/);
  assert.match(source,/This device/);
  assert.match(source,/Server import folder/);
  assert.doesNotMatch(source,/Scan WebODM mount|scan-webodm/);
  assert.match(source,/\/api\/v1\/task-submissions/);
  assert.match(source,/\/gcp-sets\/import/);
  assert.match(source,/\/gcp-sets\/import-preview/);
  assert.match(source,/emlid-all-columns-v1/);
  assert.match(source,/confirmationToken:preview\.confirmationToken/);
  assert.doesNotMatch(source,/NAD83 \/ Wisconsin Central|value="NAVD88"/);
});

test('task details render authoritative metrics and bounded sanitized API log tails',()=>{
  for(const label of ['Average GSD','Surveyed area','Source images','Reconstructed points','Georeferencing CRS','Processing duration','Outputs','Task disk usage'])assert.ok(source.includes(label),label);
  assert.match(source,/Unavailable means the processing API did not provide an authoritative value/);
  assert.match(source,/class="task-facts"/);
  assert.doesNotMatch(source,/class="task-metrics"/);
  for(const disclosure of ['Details and controls','Processing history','Ground control points','Outputs and review','Task output'])assert.ok(source.includes(disclosure),disclosure);
  assert.match(source,/aria-controls=/);
  assert.match(css,/prefers-reduced-motion/);
  assert.match(source,/logLimit=100/);
  assert.match(source,/\.slice\(-100\)/);
  assert.match(source,/Live tail refreshes every five seconds/);
  assert.match(source,/download-logs/);
  assert.match(source,/fullscreen-logs/);
  assert.match(source,/artifactActions\(output,/);
  for(const field of ['averageGsdM','surveyedAreaM2','sourceImageCount','reconstructedPointCount','georeferencingCrs','processingDurationMs','processingStatus','outputCount','taskDiskUsageBytes'])assert.ok(processingApi.includes(field),field);
  assert.ok(source.includes('formatGsd(metrics.averageGsdM,units)'));
  assert.ok(source.includes('formatArea(metrics.surveyedAreaM2,units)'));
  assert.match(processingApi,/assetKinds:\[\.\.\.new Set/);
  assert.doesNotMatch(processingApi,/requestedBySubject|createdBy\s*===\s*req\.actorId/);
});

test('published orthophoto previews use the real authenticated derivative and fail closed',()=>{
  assert.match(source,/output\.activePublished&&output\.status==='published'/);
  assert.match(source,/output\.assetKinds\.includes\('ortho'\)/);
  assert.match(source,/openGeoTiff\(`\/api\/v1\/processing\/outputs\/\$\{encodeURIComponent\(outputId\)\}\/assets\/ortho`/);
  assert.match(source,/Authorization:`Bearer \$\{state\.token\}`/);
  assert.match(source,/allowFullFile:false/);
  assert.match(source,/image\.readRGB/);
  assert.match(source,/Preview unavailable/);
  assert.doesNotMatch(source,/placeholder.*orthophoto|mock.*orthophoto/i);
});

test('server imports hand off to a persistent workspace activity feed',()=>{
  assert.match(source,/pagedApi\('\/api\/v1\/operations','operations'\)/);
  assert.match(source,/id="import-activity"/);
  assert.match(source,/Import activity/);
  assert.match(source,/Source: \$\{esc\(operationSource\(operation\)\)\}/);
  assert.match(source,/Phase: \$\{esc\(progress\.phase\)\}/);
  assert.match(source,/Worker heartbeat/);
  assert.match(source,/data-action="retry-operation"/);
  assert.match(source,/\/api\/v1\/operations\/\$\{encodeURIComponent\(id\)\}\/retry/);
  assert.match(source,/rememberOperation\(result\.operation\);modal\.close\(\)/);
  assert.match(source,/scheduleOperationRefresh\(500\)/);
  assert.doesNotMatch(source,/while\(modal\.open\)/);
  assert.match(css,/\.import-activity/);
  assert.match(css,/\.operation-progress/);
});

test('providers are master-detail and diagnostics owns storage health and trash',()=>{
  assert.match(source,/provider-master-detail/);
  assert.match(source,/API token/);
  assert.match(source,/Detect & add node/);
  assert.match(source,/API token \(if required\)/);
  assert.match(source,/Not required/);
  assert.match(source,/Detected engine/);
  assert.match(source,/API version/);
  assert.match(source,/Processing engine/);
  assert.match(source,/Queue/);
  assert.match(source,/provider-option-list/);
  assert.doesNotMatch(source,/select\('Type','type'/);
  assert.doesNotMatch(source,/name="admissionLimit"/);
  assert.match(source,/Secrets are write-only/);
  assert.match(source,/function diagnostics/);
  assert.match(source,/Storage trash & recovery/);
  assert.match(source,/Queue & provider health/);
});
