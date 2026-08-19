'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');

const source=fs.readFileSync(path.join(__dirname,'..','workspace-projects.js'),'utf8');

test('staff output actions keep the admin bearer on downloads and mint published sessions',()=>{
  assert.match(source,/async function authenticatedDownload/);
  assert.match(source,/Authorization:`Bearer \$\{state\.token\}`/);
  assert.match(source,/URL\.createObjectURL\(blob\)/);
  assert.match(source,/URL\.revokeObjectURL\(url\)/);
  assert.match(source,/async function viewPublishedOutput/);
  assert.match(source,/\/processing\/outputs\/\$\{encodeURIComponent\(id\)\}\/view-sessions/);
  assert.match(source,/window\.open\('about:blank','_blank'\)/);
  assert.match(source,/target\.opener=null/);
  assert.match(source,/target\.location\.replace\(result\.embedUrl\)/);
  assert.match(source,/output\.activePublished\?button\('share-output'/);
  assert.match(source,/state\.outputs\.filter\(output=>output\.activePublished\)/);
  assert.doesNotMatch(source,/<a[^>]+href="\$\{esc\(output\.(?:download|report)Url\)\}/);
});

test('task expansion loads bounded immutable attempt history',()=>{
  assert.match(source,/\/tasks\/\$\{encodeURIComponent\(taskId\)\}\/attempts\?limit=100/);
  assert.match(source,/function attemptHistory/);
  assert.match(source,/Processing history \(\$\{attempts\.length\}\)/);
  assert.match(source,/\['failed','cancelled'\]\.includes\(item\.status\)/);
  assert.match(source,/state\.tasks=state\.tasks\.map\(item=>item\.id===taskId\?refreshedTask:item\)/);
});

test('node administration supports metadata credential and capability-bound preset maintenance',()=>{
  for(const action of ['edit-provider','replace-provider-token','clear-provider-token','new-preset','edit-preset','delete-preset'])assert.ok(source.includes(action),action);
  assert.match(source,/\/processing\/providers\/\$\{encodeURIComponent\(provider\.id\)\}\/credential/);
  assert.match(source,/Changing the endpoint disables the node until its capabilities are probed again/);
  assert.match(source,/Provider options \(JSON\)/);
  assert.match(source,/Options are checked against the node's latest detected capabilities/);
  assert.match(source,/JSON\.parse\(event\.currentTarget\.elements\.options\.value\)/);
});

test('trash lifecycle keeps permanent deletion behind exact typed confirmation',()=>{
  assert.match(source,/data-action="purge-trash"|button\('purge-trash'/);
  assert.match(source,/typed!==entityId/);
  assert.match(source,/body:\{typedId:typed\}/);
  assert.match(source,/Permanent deletion cannot be undone/);
});

test('server-folder copy is explicit about immediate durable import without a preview',()=>{
  assert.match(source,/\/api\/v1\/processing\/server-task-imports/);
  assert.match(source,/immediately queues a durable import/);
  assert.match(source,/there is no preview step/);
  assert.doesNotMatch(source,/supported artifacts after confirmation/);
});
