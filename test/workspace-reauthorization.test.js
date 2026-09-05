const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'workspace-projects.js'), 'utf8');

test('expired workspaces use a fixed Operations reauthorization bounce with same-browser replay protection', () => {
  assert.match(source, /\/viewer\/reauthorize\?state=/);
  assert.match(source, /crypto\.randomUUID\(\)\.replaceAll\('-',''\)/);
  assert.match(source, /Date\.now\(\)-pending\.createdAt<=5\*60\*1000/);
  assert.match(source, /pending\?\.nonce===value/);
  assert.match(source, /sessionStorage\.removeItem\(REAUTH_STATE_KEY\)/);
  assert.match(source, /sessionStorage\.setItem\(OPS_ORIGIN_KEY,checked\.controllerOrigin\)/);
  assert.match(source, /parsed\.protocol==='https:'&&parsed\.origin===value/);
  assert.doesNotMatch(source, /return(?:Url|_url)=/);
});

test('auth loss redirects once and preserves model routing only for known expiry',()=>{
  const clear=source.split(/\r?\n/).find(line=>line.startsWith('function clearWorkspaceAuthorization('));
  for(const reason of ['expired','revoked','unauthorized']){
    const calls=[],state={token:'existing',adminSession:{expiresAt:new Date(Date.now()+(reason==='unauthorized'?60000:-1000)).toISOString()}};
    const context=vm.createContext({workspaceAuthorizationClearing:false,state,reviewSessionController:{suspend:options=>calls.push(['suspend',options.preserve])},storageUsagePoll:{stop(){}},workspaceRenewal:{dispose(){}},releaseAllGcpImages(){},sessionStorage:{removeItem(){}},TOKEN_KEY:'token',clearInterval(){},clearTimeout(){},beginWorkspaceReauthorization:()=>{calls.push(['redirect']);return true;},renderNav(){},access(){}});
    vm.runInContext(`${clear};clearWorkspaceAuthorization(${JSON.stringify(reason)});clearWorkspaceAuthorization('unauthorized');`,context);
    assert.equal(calls.filter(call=>call[0]==='suspend').length,1);
    assert.equal(calls[0][1],reason==='expired');
    assert.equal(calls.filter(call=>call[0]==='redirect').length,reason==='revoked'?0:1);
    assert.equal(state.token,null);
  }
});

test('model routing restoration occurs only after validated workspace session installation',()=>{
  const install=source.split(/\r?\n/).find(line=>line.startsWith('function installWorkspaceSession('));
  assert.ok(install.indexOf('validateWorkspaceSessionEnvelope')<install.indexOf('setAuthenticatedSubject(checked.session.subject)'));
  assert.match(install,/workspaceAuthorizationClearing=false/);
  assert.match(source,/storage:sessionStorage,issueGrant:/);
});
