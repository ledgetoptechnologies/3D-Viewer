'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');

const source=fs.readFileSync(path.join(__dirname,'..','workspace-projects.js'),'utf8');
const launcher=fs.readFileSync(path.join(__dirname,'..','isolated-viewer-launch.mjs'),'utf8');

test('staff output actions keep the admin bearer on downloads and mint published sessions',()=>{
  assert.match(source,/async function authenticatedDownload/);
  assert.match(source,/Authorization:`Bearer \$\{state\.token\}`/);
  assert.match(source,/URL\.createObjectURL\(blob\)/);
  assert.match(source,/URL\.revokeObjectURL\(url\)/);
  assert.match(source,/async function viewPublishedOutput/);
  assert.match(source,/\/processing\/outputs\/\$\{encodeURIComponent\(id\)\}\/view-sessions/);
  assert.match(source,/import \{ beginIsolatedViewerLaunch \} from '\.\/isolated-viewer-launch\.mjs'/);
  assert.match(launcher,/windowRef\.open\(launcherUrl, windowName, 'noopener'\)/);
  assert.doesNotMatch(source,/window\.open\('about:blank'/);
  assert.match(source,/reviewSessionController\.track\(launch\.channelId,\{attemptId:result\.attemptId,modelId:result\.modelId,modelVersionId:result\.modelVersionId,sessionTtlSeconds:result\.sessionTtlSeconds\}\)/);
  assert.match(source,/launch\.navigate\(result\.embedUrl,\{renewable:false\}\)/);
  assert.match(source,/output\.activePublished.*button\('share-output'/);
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
  assert.match(source,/data-action="purge-trash"|(?:button|dangerButton)\('purge-trash'/);
  assert.match(source,/typed!==entityId/);
  assert.match(source,/body:\{typedId:typed\}/);
  assert.match(source,/Permanent deletion cannot be undone/);
});

test('project-first lifecycle exposes rename and recoverable delete without archive-first UI',()=>{
  for(const action of ['edit-project','edit-task','trash-project','trash-task','trash-dataset','trash-output','restore-trash','purge-trash','retry-storage-mutation'])assert.ok(source.includes(action),action);
  for(const removed of ['archive-project','archive-task','archive-dataset','archive-output'])assert.equal(source.includes(removed),false,removed);
  for(const permission of ['viewer.projects.write','viewer.storage.purge','viewer.processing.write','viewer.processing.publish'])assert.ok(source.includes(`can('${permission}')`),permission);
  assert.match(source,/function confirmedMutation/);
  assert.match(source,/function editProject/);
  assert.match(source,/function editTask/);
  assert.match(source,/remain recoverable in trash for 14 days/);
  assert.match(source,/restored until \$\{purgeDate\(30\)\}/);
  assert.match(source,/after that date it will be permanently purged/);
  assert.match(source,/project is archived and read-only/);
  assert.match(source,/task\.status==='archived'\?'task':'project'\} is archived and read-only/);
  assert.match(source,/pagedStorage/);
  assert.match(source,/storage\/mutations\?status=failed/);
  assert.match(source,/\/storage\/mutations\/\$\{encodeURIComponent\(id\)\}\/retry/);
});

test('server-folder copy is explicit about immediate durable import without a preview',()=>{
  assert.match(source,/\/api\/v1\/processing\/server-task-imports/);
  assert.match(source,/immediately queues a durable import/);
  assert.match(source,/there is no preview step/);
  assert.doesNotMatch(source,/supported artifacts after confirmation/);
});
