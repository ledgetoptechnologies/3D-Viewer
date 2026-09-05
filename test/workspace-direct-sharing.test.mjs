import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source=readFileSync(new URL('../workspace-projects.js',import.meta.url),'utf8');
function declaration(name){
  const match=new RegExp(`^(?:async )?function ${name}\\(`,'m').exec(source);
  assert.ok(match,`Missing shipped function ${name}`);
  const rest=source.slice(match.index),next=/\n(?:async )?function \w+\(|\nconst \w+\s*=/.exec(rest);
  return next?rest.slice(0,next.index):rest;
}
const names=['canShareOutput','openShareModal','associationModelId','associationProjectId','portalAccountId',
  'exactClientAssociations','clientGrantBody','clientShareCard','rememberShareResult','clearShareResult','visibleShareResult','shareModal','confirmSharedVersionUpdate',
  'createOutputShare','bindShareModal','bindProjectShareCard'];
function fixture(permissions=['viewer.shares.read','viewer.shares.create','viewer.shares.revoke','viewer.processing.publish','viewer.client_grants.manage']){
  const output={id:'output',modelId:'model',projectId:'project',taskId:'task',attemptId:'attempt',status:'ready',activePublished:false};
  const state={token:'signed-in',projects:[{id:'project',displayName:'Site'}],tasks:[{id:'task',projectId:'project'}],outputs:[output],
    shares:{},sharePreflight:{},projectShares:{},clientAccess:{projects:[],associations:[],grants:[]},shareContext:{id:'context'},lastShareUrl:null};
  const calls=[],notices=[],rendered=[],decisions=[],copyButtons=[];
  let sequence=0,respond=async(path,options)=>options.method==='POST'
    ?{share:{id:'share',permissions:{view:true,download:false}},viewUrl:'https://viewer.test/view/capability'}
    :path.endsWith('/client-grants')?state.clientAccess:{shares:[],publicationRequired:true,existingAccessUpdateRequired:false,eligibleAssetKinds:['glb']};
  const modal={open:true,close(){this.open=false}},modalContent={
    querySelector:selector=>selector==='.share-columns'?{dataset:{shareContext:state.shareContext?.id}}:null,
    querySelectorAll:selector=>selector==='[data-action="copy-share"]'?copyButtons:[],
  };
  const esc=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
  const context=vm.createContext({state,modal,modalContent,crypto:{randomUUID:()=>`request-${++sequence}`},
    can:permission=>permissions.includes(permission),esc,card:(title,body)=>`<section><h3>${esc(title)}</h3>${body}</section>`,
    empty:text=>`<p>${esc(text)}</p>`,field:(label,name,attrs='')=>`<label>${esc(label)}<input name="${name}" ${attrs}></label>`,
    badge:value=>`<span>${esc(value)}</span>`,button:(action,id,label)=>`<button data-action="${action}" data-id="${id}">${label}</button>`,
    openModal:(title,html)=>{rendered.push({title,html});modal.open=true},injectProjectShareCard:()=>{},
    values:form=>({label:form.elements.label?.value||'',password:form.elements.password?.value||'',expiresAt:form.elements.expiresAt.value}),
    api:async(path,options={})=>{calls.push({path,options:JSON.parse(JSON.stringify(options))});return respond(path,options)},
    mutate:async(...args)=>calls.push({mutation:args}),toast:(...args)=>notices.push(args),navigator:{clipboard:{writeText:async()=>{throw new Error('clipboard denied')}}},
    dialogs:{confirm:async()=>{decisions.push('confirm');return true},form:async()=>null},
  });
  vm.runInContext(names.map(declaration).join('\n'),context);
  const form={dataset:{outputId:'output'},isConnected:true,elements:{label:{value:''},password:{value:''},expiresAt:{value:''},
    measure:{checked:true},cameras:{checked:true},download:{checked:false}},button:{disabled:false},querySelector(){return this.button}};
  return {context,state,output,calls,notices,rendered,decisions,modal,modalContent,form,copyButtons,
    respond(fn){respond=fn},html:()=>rendered.at(-1)?.html||''};
}

test('ready share preflight and cancel execute only reads and never reopen a closed modal',async()=>{
  const f=fixture();let resolve;
  f.respond(path=>path.endsWith('/client-grants')?Promise.resolve(f.state.clientAccess):new Promise(done=>{resolve=done}));
  const opening=f.context.openShareModal('project','output');
  assert.match(f.html(),/Checking share eligibility/);assert.equal(f.calls.some(call=>call.options.method==='POST'),false);
  f.modal.close();resolve({shares:[],publicationRequired:true,existingAccessUpdateRequired:false,eligibleAssetKinds:['glb']});
  await opening;assert.equal(f.modal.open,false);assert.equal(f.rendered.length,1);assert.equal(f.output.activePublished,false);
});

test('dedicated ready sharing offers explicit link creation without publish UX or whole-project form',async()=>{
  const f=fixture();await f.context.openShareModal('project','output');
  assert.match(f.html(),/Create public link/);assert.match(f.html(),/This model is private/);
  assert.doesNotMatch(f.html(),/Review & publish|publish-attempt|project-share-form|name="wholeProject"/);
  assert.doesNotMatch(f.html(),/name="download" checked/);assert.match(f.html(),/Optional password/);
  assert.match(f.html(),/Direct Operations client sharing is not available/);
  assert.equal(f.calls.every(call=>!call.options.method||call.options.method==='GET'),true);
});

test('ready create form requires share-create and publish; published share needs only share-create',()=>{
  for(const permissions of [[],['viewer.processing.publish'],['viewer.shares.create'],['viewer.shares.read']]){
    const f=fixture(permissions);f.context.shareModal('project','output');assert.doesNotMatch(f.html(),/class="manage-form share-form"/);
  }
  const f=fixture(['viewer.shares.create']);f.output.activePublished=true;f.output.status='published';
  f.context.shareModal('project','output');assert.match(f.html(),/class="manage-form share-form"/);
  assert.doesNotMatch(f.html(),/data-action="revoke-share"/);
});

test('cancelled exposure confirmation sends nothing; accepted confirmation carries explicit consent and no download permission',async()=>{
  const f=fixture();f.state.sharePreflight.output={existingAccessUpdateRequired:true};
  f.context.dialogs.confirm=async()=>false;
  await f.context.createOutputShare(f.form,'project','output');assert.equal(f.calls.length,0);assert.equal(f.form.button.disabled,false);
  f.context.dialogs.confirm=async()=>true;
  await f.context.createOutputShare(f.form,'project','output');
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].options.body.publishIfReady,true);
  assert.equal(f.calls[0].options.body.allowExistingAccessUpdate,true);assert.equal(f.calls[0].options.body.permissions.download,false);
  assert.equal(f.state.lastShareUrl,'https://viewer.test/view/capability');assert.match(f.html(),/New public link/);
  assert.equal(f.notices.some(item=>/clipboard|failed/i.test(item[0])),false,'creation must not attempt clipboard');
});

test('raced consent retry uses new key, uncertain retry retains exact consent payload even if output refreshes as published',async()=>{
  const f=fixture();let attempt=0;
  f.respond(async()=>{
    attempt++;
    if(attempt===1)throw Object.assign(new Error('existing_access_update_confirmation_required'),{status:409});
    if(attempt===2)throw new Error('network interrupted');
    return{share:{id:'share'},viewUrl:'https://viewer.test/view/same-link'};
  });
  await f.context.createOutputShare(f.form,'project','output');
  assert.equal(f.calls.length,2);assert.notEqual(f.calls[0].options.headers['Idempotency-Key'],f.calls[1].options.headers['Idempotency-Key']);
  f.output.activePublished=true;f.output.status='published';
  await f.context.createOutputShare(f.form,'project','output');
  assert.equal(f.calls.length,3);assert.deepEqual(f.calls[2].options,f.calls[1].options);
  assert.equal(f.state.lastShareUrl,'https://viewer.test/view/same-link');
});

test('same-form uncertain network retry retains key; changing visible request input rotates it',async()=>{
  const f=fixture();f.respond(async()=>{throw new Error('offline')});
  await f.context.createOutputShare(f.form,'project','output');await f.context.createOutputShare(f.form,'project','output');
  assert.equal(f.calls[0].options.headers['Idempotency-Key'],f.calls[1].options.headers['Idempotency-Key']);
  f.form.elements.label.value='Changed';await f.context.createOutputShare(f.form,'project','output');
  assert.notEqual(f.calls[1].options.headers['Idempotency-Key'],f.calls[2].options.headers['Idempotency-Key']);
});

test('double submit is suppressed while creation is pending and close suppresses stale modal rendering',async()=>{
  const f=fixture();let done;f.respond(()=>new Promise(resolve=>{done=resolve}));
  const pending=f.context.createOutputShare(f.form,'project','output');
  await f.context.createOutputShare(f.form,'project','output');assert.equal(f.calls.length,1);
  f.modal.close();f.form.isConnected=false;done({share:{id:'share'},viewUrl:'https://viewer.test/view/success'});await pending;
  assert.equal(f.modal.open,false);assert.equal(f.state.lastShareUrl,'https://viewer.test/view/success');
});

test('copy failure cannot create another link and preserves manual-copy URL',async()=>{
  const f=fixture();await f.context.createOutputShare(f.form,'project','output');
  const copy={dataset:{url:f.state.lastShareUrl}};f.copyButtons.push(copy);
  f.context.bindShareModal('project','output');await copy.onclick();
  assert.equal(f.calls.length,1);assert.equal(f.state.lastShareUrl,'https://viewer.test/view/capability');
  assert.match(f.notices.at(-1)[0],/link is created.*copy it manually/);
});

function associated(f){
  f.output.activePublished=true;f.output.status='published';
  f.state.clientAccess={projects:[{id:'ops-project',accountId:'account',name:'Client site'}],associations:[
    {id:'match',modelId:'model',projectId:'ops-project'},
    {id:'wrong-model',modelId:'other',projectId:'ops-project'},
  ],grants:[]};
  f.form.elements.associationId={value:'match'};
  f.form.elements.includeFuturePublished={checked:true};
}
test('per-model client scope is exact task association and future=false despite forged broad inputs',()=>{
  const f=fixture();associated(f);
  f.form.elements.scopeType={value:'project'};f.form.elements.projectId={value:'unrelated'};
  const body=JSON.parse(JSON.stringify(f.context.clientGrantBody(f.form,'output')));
  assert.equal(body.grant.scopeType,'task');assert.equal(body.grant.includeFuturePublished,false);
  assert.equal(body.grant.associationId,'match');assert.equal(body.grant.projectId,'ops-project');assert.equal(body.grant.accountId,'account');
  f.form.elements.associationId.value='wrong-model';assert.throws(()=>f.context.clientGrantBody(f.form,'output'),/exact Operations/);
});

test('missing, conflicting, ambiguous, and private model associations fail closed',()=>{
  const f=fixture();associated(f);
  f.state.clientAccess.associations.push({id:'duplicate',modelId:'model',projectId:'ops-project'});
  assert.equal(f.context.exactClientAssociations(f.output).length,0);
  f.state.clientAccess.associations.pop();f.state.clientAccess.associations[0].accountId='other';
  assert.equal(f.context.exactClientAssociations(f.output).length,0);
  delete f.state.clientAccess.associations[0].accountId;f.output.activePublished=false;f.output.status='ready';
  assert.equal(f.context.exactClientAssociations(f.output).length,0);assert.throws(()=>f.context.clientGrantBody(f.form,'output'),/exact Operations/);
});

test('whole-project client scope and future publications are separate opt-ins',()=>{
  const f=fixture();associated(f);
  f.form.elements.projectId={value:'ops-project'};f.form.elements.wholeProject={checked:false};
  assert.throws(()=>f.context.clientGrantBody(f.form,null),/explicitly approve/);
  f.form.elements.wholeProject.checked=true;f.form.elements.includeFuturePublished.checked=false;
  assert.equal(f.context.clientGrantBody(f.form,null).grant.includeFuturePublished,false);
  f.context.shareModal('project');assert.match(f.html(),/name="wholeProject" required/);
  assert.doesNotMatch(f.html(),/name="(?:includeFuturePublished|wholeProject)" checked/);
});

test('whole-project public creation requires future-scope opt-in and separates clipboard from success',async()=>{
  const f=fixture();f.form.elements.dynamicProjectAccess={checked:false};
  f.modalContent.querySelector=selector=>selector==='.project-share-form'?f.form:null;
  f.context.bindProjectShareCard('project');await f.form.onsubmit({preventDefault(){}});assert.equal(f.calls.length,0);
  f.form.elements.dynamicProjectAccess.checked=true;await f.form.onsubmit({preventDefault(){}});
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].path,'/api/v1/projects/project/public-shares');
  assert.equal(f.state.lastShareUrl,'https://viewer.test/view/capability');assert.match(f.notices.at(-1)[0],/created.*Use Copy/);
});

test('new link result is bound to its project, output and share identity',async()=>{
  const f=fixture();await f.context.createOutputShare(f.form,'project','output');
  assert.match(f.html(),/New public link/);
  f.context.shareModal('other-project');assert.doesNotMatch(f.html(),/New public link|view\/capability/);
  f.context.shareModal('project','different-output');assert.doesNotMatch(f.html(),/New public link|view\/capability/);
  f.context.shareModal('project','output');assert.match(f.html(),/New public link/);
  f.context.clearShareResult('different-share','model');assert.ok(f.state.lastShareResult);
  f.context.clearShareResult('share','project');assert.ok(f.state.lastShareResult);
});

test('loaded revoked or expired link metadata hides and clears the stale creation card',async()=>{
  for(const metadata of [{revokedAt:'2026-01-01T00:00:00Z'},{expiresAt:'2020-01-01T00:00:00Z'}]){
    const f=fixture();await f.context.createOutputShare(f.form,'project','output');
    Object.assign(f.state.shares.output[0],metadata);
    f.context.shareModal('project');assert.doesNotMatch(f.html(),/New public link|created successfully/);
    assert.equal(f.state.lastShareUrl,null);
  }
  const f=fixture();f.context.rememberShareResult({share:{id:'project-share',expiresAt:'2020-01-01T00:00:00Z'},viewUrl:'https://viewer.test/project/expired'},'project',null);
  f.context.shareModal('project');assert.doesNotMatch(f.html(),/New public link/);assert.equal(f.state.lastShareUrl,null);
});

for(const kind of ['model','project'])test(`successful ${kind} revoke clears only its matching creation result`,async()=>{
  const f=fixture(),element={dataset:{id:'share'}};
  f.context.rememberShareResult({share:{id:'share'},viewUrl:'https://viewer.test/link'},'project',kind==='model'?'output':null);
  f.modalContent.querySelectorAll=selector=>selector===`[data-action="revoke-${kind==='model'?'share':'project-share'}"]`?[element]:[];
  f.context.mutate=async()=>({share:{id:'share',revokedAt:'now'}});
  if(kind==='model')f.context.bindShareModal('project','output');else f.context.bindProjectShareCard('project');
  await element.onclick();assert.equal(f.state.lastShareUrl,null);assert.equal(f.state.lastShareResult,null);
  f.context.shareModal('project');assert.doesNotMatch(f.html(),/New public link|created successfully/);
});

test('failed or cancelled revoke does not erase an otherwise valid created link',async()=>{
  const f=fixture(),element={dataset:{id:'share'}};
  f.context.rememberShareResult({share:{id:'share'},viewUrl:'https://viewer.test/link'},'project','output');
  f.modalContent.querySelectorAll=selector=>selector==='[data-action="revoke-share"]'?[element]:[];
  f.context.bindShareModal('project','output');f.context.dialogs.confirm=async()=>false;
  await element.onclick();assert.equal(f.state.lastShareUrl,'https://viewer.test/link');
  f.context.dialogs.confirm=async()=>true;f.context.mutate=async()=>undefined;
  await element.onclick();assert.equal(f.state.lastShareUrl,'https://viewer.test/link');
});
