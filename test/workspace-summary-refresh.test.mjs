import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createWorkspaceSummaryRefresh } from '../workspace-summary-refresh.mjs';

function fixture(read) {
  const state = { context: ['token', 'operator', 'dashboard'], tasks: [{ id: 'task', latestAttempt: { id: 'old', status: 'complete' } }], outputs: [] };
  const refresh = createWorkspaceSummaryRefresh({ read, getContext: () => [...state.context], getItems: key => state[key], applyItems: (key, value) => { state[key] = value; } });
  return { state, refresh };
}

test('bounded pagination discovers cross-tab attempts even with only terminal cached tasks', async () => {
  const calls = [];
  const f = fixture(async (key, page) => { calls.push([key, page]); return key === 'tasks' ? { tasks: [{ id: 'task', latestAttempt: { id: 'new', status: 'queued_upstream' } }], nextCursor: page.cursor ? null : 'page2' } : { outputs: [] }; });
  await f.refresh();
  assert.equal(f.state.tasks[0].latestAttempt.id, 'new');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0][1], { limit: 100, cursor: null });
  await f.refresh();
  assert.deepEqual(calls[2][1], { limit: 100, cursor: 'page2' });
  await f.refresh();
  assert.equal(calls[4][1].cursor, null, 'new sweeps continue after reaching the last page');
});

test('auth or navigation context changes discard in-flight pages and reset cursors', async () => {
  for (const index of [0, 1, 2]) {
    let release;
    const f = fixture(() => new Promise(resolve => { release = resolve; }));
    // Use one collection so the fixture controls the sole outstanding response.
    const refresh = createWorkspaceSummaryRefresh({ collections: ['tasks'], read: () => new Promise(resolve => { release = resolve; }), getContext: () => f.state.context, getItems: key => f.state[key], applyItems: (key, value) => { f.state[key] = value; } });
    const before = f.state.tasks;
    const pending = refresh();
    f.state.context = [...f.state.context]; f.state.context[index] = 'different';
    release({ tasks: [{ id: 'task', displayName: 'stale' }], nextCursor: 'old-cursor' });
    assert.equal(await pending, false);
    assert.equal(f.state.tasks, before);
  }
});

test('an overlapping newer detail/rename read is never overwritten by an older page', async () => {
  let release;
  const state = { tasks: [{ id: 'task', displayName: 'original' }] };
  const refresh = createWorkspaceSummaryRefresh({ collections: ['tasks'], getContext: () => ['token'], getItems: key => state[key], applyItems: (key, value) => { state[key] = value; }, read: () => new Promise(resolve => { release = resolve; }) });
  const pending = refresh();
  const newer = { id: 'task', displayName: 'saved rename' }; state.tasks = [newer];
  release({ tasks: [{ id: 'task', displayName: 'old rename' }, { id: 'new-task' }] });
  await pending;
  assert.equal(state.tasks[0], newer); assert.equal(state.tasks[1].id, 'new-task');
});

test('single-flight remains held until every collection settles, including a partial error', async () => {
  let release; let calls = 0;
  const f = fixture(key => { calls++; return key === 'tasks' ? Promise.reject(Error('temporary outage')) : new Promise(resolve => { release = resolve; }); });
  const pending = f.refresh(); await Promise.resolve();
  assert.equal(await f.refresh(), false); assert.equal(calls, 2);
  release({ outputs: [] }); await assert.rejects(pending, /temporary outage/);
});

test('repeated cursors fail safely and restart the next bounded sweep', async () => {
  const cursors = [];
  const refresh = createWorkspaceSummaryRefresh({ collections: ['tasks'], getContext: () => ['token'], getItems: () => [], applyItems: () => {}, read: async (_key, page) => { cursors.push(page.cursor); return { tasks: [], nextCursor: 'repeated' }; } });
  await refresh(); await assert.rejects(refresh(), /cursor repeated/); await refresh();
  assert.deepEqual(cursors, [null, 'repeated', null]);
});

test('summary patch preserves focused toggle, expanded editor, upload/modal and open action menus', () => {
  const source = readFileSync(new URL('../workspace-projects.js', import.meta.url), 'utf8');
  const start = source.indexOf('function renderDashboardSummaries()');
  const end = source.indexOf('\nfunction dashboard()', start);
  assert.ok(start >= 0 && end > start);
  const freshToggle = { innerHTML: 'new status' };
  let replaced = false;
  const actions = { innerHTML: 'old actions', contains: () => true, querySelector: () => ({ open: true }), replaceWith: () => { replaced = true; } };
  const toggle = { innerHTML: 'old status', parentElement: { querySelector: () => actions } };
  const state = { section: 'dashboard', taskPage: null, tasks: [{ id: 'task' }] };
  const context = vm.createContext({ state, CSS: { escape: value => value }, taskPanel: () => '', dashboard: () => '', content: { querySelector: selector => selector.startsWith('[data-action') ? toggle : null, querySelectorAll: () => [] }, document: { activeElement: toggle, createElement: () => ({ querySelector: selector => selector === '.task-summary-toggle' ? freshToggle : selector === '.task-quick-actions' ? { innerHTML: 'new actions' } : null }) } });
  vm.runInContext(source.slice(start, end), context);
  context.renderDashboardSummaries();
  assert.equal(toggle.innerHTML, 'new status'); assert.equal(replaced, false);
  state.taskPage = 'gcp'; toggle.innerHTML = 'editor untouched';
  context.renderDashboardSummaries(); assert.equal(toggle.innerHTML, 'editor untouched');
});

test('completion reload checks authorization, navigation and editing safety again after reads, before state or DOM writes', async () => {
  const source = readFileSync(new URL('../workspace-projects.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const start = source.indexOf('async function load(background=false)');
  // Extract only the function, independent of its next top-level declaration.
  const code = source.slice(start, source.indexOf('\n}\n', start) + 2);
  assert.ok(start >= 0 && code.endsWith('\n}'));
  for (const change of ['authorization', 'navigation', 'editor']) {
    const state = { token: 'token', adminSession: { subject: 'operator' }, section: 'dashboard', storage: { kept: true }, tasks: [{ id: 'before' }] };
    const before = state.tasks; let safe = true, release;
    const pending = new Promise(resolve => { release = resolve; });
    const context = vm.createContext({ state, summaryContext: () => [state.token, state.section], canApplyCompletionReload: () => safe, can: () => false,
      pagedApi: async (_path, key) => { await pending; return { [key]: [{ id: 'after' }] }; }, pagedStorage: async () => { await pending; return {}; }, api: async () => { await pending; return {}; },
      access: () => assert.fail('no auth modal or DOM changes'), render: () => assert.fail('must not render stale or editing workspace') });
    vm.runInContext(code, context); const loading = context.load(true);
    if(change==='authorization')state.token='renewed';else if(change==='navigation')state.section='providers';else safe=false;
    release(); assert.equal(await loading, false); assert.equal(state.tasks, before); assert.deepEqual(state.storage, { kept: true });
  }
});

test('safe completion reload still refreshes full collections, shares and rendering', async () => {
  const source = readFileSync(new URL('../workspace-projects.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const start = source.indexOf('async function load(background=false)'), code = source.slice(start, source.indexOf('\n}\n', start) + 2);
  const state = { token: 'token', section: 'dashboard', adminSession: { subject: 'operator' }, storage: null };
  let renders=0, scheduled=0; const paths=[];
  const context = vm.createContext({ state, summaryContext: () => ['token', 'dashboard'], canApplyCompletionReload: () => true, can: () => false,
    pagedApi: async (_path,key) => ({ [key]: [{ id: key, ...(key==='outputs'?{activePublished:true}:{}) }] }), pagedStorage: async () => ({usage:'fresh'}),
    api: async path => { paths.push(path);return path.endsWith('/shares')?{shares:[{id:'share'}]}:{ok:true}; },
    validateWorkspaceView: () => {}, syncWorkspaceView: () => {}, document: {querySelector: () => ({})}, render: () => {renders++}, hydrateExpandedTask: () => {}, scheduleOperationRefresh: () => {scheduled++} });
  vm.runInContext(code,context);
  assert.equal(await context.load(true),true);
  assert.equal(state.projects[0].id,'projects');assert.equal(state.datasets[0].id,'datasets');assert.equal(state.tasks[0].id,'tasks');
  assert.equal(state.shares.outputs[0].id,'share');assert.equal(state.storage.usage,'fresh');
  assert.ok(paths.some(path=>path.endsWith('/outputs/outputs/shares')));assert.equal(renders,1);assert.equal(scheduled,1);
});

test('summary-first expanded status transition redraws detail, or retains a deferred redraw while editing', async () => {
  const source=readFileSync(new URL('../workspace-projects.js',import.meta.url),'utf8');
  const code=source.slice(source.indexOf('const taskDetailRefreshes='),source.indexOf('async function refreshGcpWorkspace('));
  for(const safe of [true,false]){
    const task={id:'task',datasetId:'dataset',latestAttempt:{id:'attempt',status:'running'}};
    const state={token:'token',tasks:[task],expandedTaskId:'task',taskDetails:{task:{attempt:{id:'attempt',status:'queued_upstream'},logs:[]}}};
    let renders=0,logPatches=0;
    const context=vm.createContext({state,api:async path=>path==='/api/v1/tasks/task'?{task}:path.includes('/attempts/attempt?')?{attempt:task.latestAttempt,logs:[]}:{},
      refreshGcpWorkspace:async()=>{},canApplyCompletionReload:()=>safe,render:()=>{renders++},CSS:{escape:value=>value},
      content:{querySelector:()=>({replaceWith:()=>{logPatches++}})}});
    vm.runInContext(code,context);await context.refreshTaskDetails('task',true);
    assert.equal(logPatches,0);assert.equal(renders,safe?1:0);assert.equal(state.taskDetails.task.summaryTransitionPending,!safe);
  }
});

test('cross-tab active attempt on an expanded terminal task starts detail polling only once',()=>{
  const source=readFileSync(new URL('../workspace-projects.js',import.meta.url),'utf8');
  const code=source.slice(source.indexOf('function renderDashboardSummaries()'),source.indexOf('\nfunction dashboard()'));
  const attempt={id:'new-attempt',status:'queued_upstream'},task={id:'task',projectId:'project',latestAttempt:attempt};
  const state={section:'dashboard',tasks:[task],expandedTaskId:'task',taskDetails:{task:{attempt}},logTimer:null};
  const toggle={innerHTML:'status',parentElement:{querySelector:()=>null}};let timers=0;
  const context=vm.createContext({state,ACTIVE:new Set(['queued_upstream']),setInterval:(_callback,delay)=>{assert.equal(delay,5000);timers++;return 123},
    CSS:{escape:value=>value},taskPanel:()=>'',dashboard:()=>'',content:{querySelector:selector=>selector.startsWith('[data-action="toggle-task"]')?toggle:null,querySelectorAll:()=>[]},
    document:{activeElement:null,createElement:()=>({querySelector:selector=>selector==='.task-summary-toggle'?{innerHTML:'status'}:null})}});
  vm.runInContext(code,context);context.renderDashboardSummaries();context.renderDashboardSummaries();
  assert.equal(timers,1);assert.equal(state.logTimer,123);
});

test('deferred import completion survives same-owner token renewal, but not another owner', async () => {
  const source=readFileSync(new URL('../workspace-projects.js',import.meta.url),'utf8');
  const code=source.slice(source.indexOf('let deferredCompletionReload='),source.indexOf('function scheduleOperationRefresh(',source.indexOf('let deferredCompletionReload=')));
  for(const changedOwner of [false,true]){
    const state={token:'old',adminSession:{subject:'owner'},operations:[{id:'import',status:'leased'}],derivativeJobs:[],section:'dashboard',operationRefreshBusy:false,busy:false};
    const modal={open:true};let loads=0;
    const context=vm.createContext({state,modal,workspaceRecovery:{isPaused:()=>false},summaryContext:()=>[state.token,state.adminSession.subject],
      content:{contains:()=>false},document:{querySelector:()=>null},pagedApi:async(_path,key)=>({[key]:key==='operations'?[{id:'import',status:'succeeded'}]:[]}),
      toast:()=>{},renderOperationActivity:()=>{},refreshWorkspaceSummaries:async()=>{},renderDashboardSummaries:()=>{},
      load:async background=>{assert.equal(background,true);loads++;return true},console});
    vm.runInContext(code,context);await context.refreshOperations();assert.equal(loads,0);
    state.token='renewed';if(changedOwner)state.adminSession.subject='other';modal.open=false;
    await context.refreshOperations();assert.equal(loads,changedOwner?0:1);
  }
});
