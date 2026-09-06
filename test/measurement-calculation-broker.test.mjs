import test from 'node:test';
import assert from 'node:assert/strict';
import { createMeasurementCalculationBroker } from '../measurement-calculation-broker.mjs';
import { ReviewSessionController } from '../review-session-controller.mjs';

const origin = 'https://viewer.example';
const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', job = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const context = { modelId: 'model-one', modelVersionId: 'version-one', attemptId: 'attempt-one', sessionTtlSeconds: 1800 };
const expiry = () => new Date(Date.now() + 600_000).toISOString();
const request = (operation = 'capabilities', payload = {}) => ({ version: 1, type: 'ltds-viewer:measurement-request', requestId: id, ...Object.fromEntries(['modelId','modelVersionId'].map(key => [key,context[key]])), viewerToken: 'v'.repeat(43), operation, payload });
function harness(overrides = {}) {
  let authority = { accessToken: 'a'.repeat(43), session: { subject: 'ops:one', permissions: ['viewer.processing.write'], expiresAt: expiry() } };
  const viewer = { audience: 'ops', subject: 'ops:one', model: { id: context.modelId, activeVersion: { id: context.modelVersionId } }, sessionMode: 'review', reviewAttemptId: context.attemptId, permissions: { view: true, measure: true }, expiresAt: expiry(), ...overrides };
  const calls = [];
  const broker = createMeasurementCalculationBroker({ origin, getAuthorization: () => authority, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => url.endsWith('/sessions/current') ? viewer : { capabilities: { serverCalculations: true }, calculation: { id: job, status: 'queued' } } };
  } });
  return { broker, calls, viewer, setAuthority: value => { authority = value; } };
}

test('workspace broker uses a separately verified scoped Viewer session and never returns its admin bearer', async () => {
  const h = harness();
  const result = await h.broker(context, request());
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].url, `${origin}/api/v1/sessions/current`);
  assert.equal(h.calls[0].init.headers['X-Viewer-Admin-Authorization'], undefined);
  assert.equal(h.calls[1].init.headers.Authorization, `Bearer ${'v'.repeat(43)}`);
  assert.equal(h.calls[1].init.headers['X-Viewer-Admin-Authorization'], `Bearer ${'a'.repeat(43)}`);
  assert.equal(h.calls[1].init.redirect, 'error'); assert.equal(h.calls[1].init.credentials, 'omit');
  assert.doesNotMatch(JSON.stringify(result), /Bearer|accessToken|aaaaaaa/);
});

test('broker supports only fixed calculation endpoints and rejects client/person/version/mode mismatches', async () => {
  for (const overrides of [{ audience: 'client' }, { subject: 'ops:other' }, { model: { id: 'other', activeVersion: { id: context.modelVersionId } } }, { model: { id: context.modelId, activeVersion: { id: 'other' } } }, { sessionMode: 'published' }, { reviewAttemptId: 'other' }, { permissions: { view: true, measure: false } }, { expiresAt: 'invalid' }]) {
    const h = harness(overrides);
    await assert.rejects(h.broker(context, request('create', { measurementId: id, request: { method: 'surface-cut-fill' } })), /measurement_scope_changed/);
    assert.equal(h.calls.length, 1);
  }
  for (const bad of [request('fetch', { url: 'https://evil.example' }), request('status', { measurementId: '../projects', jobId: job }), request('create', { measurementId: id, request: {}, path: '/api/v1/tasks' })]) {
    const h = harness(); await assert.rejects(h.broker(context, bad), /measurement_request_invalid/); assert.equal(h.calls.length, 0);
  }
  for (const [operation,payload,path,method] of [['create',{ measurementId:id,request:{revision:1,method:'surface-cut-fill'} },`/${id}/calculations`,'POST'],['list',{measurementId:id},`/${id}/calculations`,'GET'],['status',{measurementId:id,jobId:job},`/${id}/calculations/${job}`,'GET'],['cancel',{measurementId:id,jobId:job},`/${id}/calculations/${job}`,'DELETE']]) {
    const h = harness(); await h.broker(context,request(operation,payload)); assert.equal(h.calls[1].url,`${origin}/api/v1/measurements${path}`); assert.equal(h.calls[1].init.method,method);
  }
});

test('ordinary workspace access and missing/expired admin state cannot broker processing', async () => {
  for (const authority of [null,{accessToken:'x',session:{subject:'ops:one',permissions:['viewer.processing.read'],expiresAt:expiry()}},{accessToken:'x',session:{subject:'ops:one',permissions:['viewer.processing.write'],expiresAt:'invalid'}}]) {
    const h = harness(); h.setAuthority(authority); await assert.rejects(h.broker(context,request()),/measurement_admin_required/); assert.equal(h.calls.length,0);
  }
});

test('registered channel correlates responses and ignores replay, foreign context and late sign-out completion', async () => {
  const posts = [], calls = [];
  let finish;
  const controller = new ReviewSessionController({ origin, issueGrant: async () => ({}), measurementRequest: async (scope, message) => { calls.push({scope,message}); return new Promise(resolve => { finish = resolve; }); }, createChannel: () => ({postMessage: message => posts.push(message),close(){}}) });
  controller.setAuthenticatedSubject('ops:one'); controller.track(id,context);
  assert.equal(await controller.handleMessage(id,{...request(),modelVersionId:'other'}),false);
  assert.equal(await controller.handleMessage(job,request()),false);
  const pending = controller.handleMessage(id,request());
  assert.equal(await controller.handleMessage(id,request()),false); assert.equal(calls.length,1);
  finish({capabilities:{serverCalculations:true}}); assert.equal(await pending,true);
  assert.equal(posts.at(-1).type,'ltds-viewer:measurement-response'); assert.equal(posts.at(-1).requestId,id);
  assert.equal(await controller.handleMessage(id,request()),false);
  const late = controller.handleMessage(id,{...request(),requestId:job}); controller.suspend(); finish({calculation:{id:job}});
  assert.equal(await late,false); assert.equal(posts.length,1);
});
