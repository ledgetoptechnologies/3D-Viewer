import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkspaceSessionRenewal } from '../workspace-renewal.mjs';

const TOKEN = 'workspace-token-000000000000000000000000';
const GRANT = 'workspace-grant-000000000000000000000000';
const ORIGIN = 'https://ops.example.test';

function harness({ fetchImpl } = {}) {
  const posted = [];
  const timers = [];
  const windowListeners = new Map();
  const documentListeners = new Map();
  const controllerWindow = { closed: false, postMessage: (message, origin) => posted.push({ message, origin }) };
  const windowRef = {
    addEventListener: (type, listener) => windowListeners.set(type, listener),
    removeEventListener: (type, listener) => { if (windowListeners.get(type) === listener) windowListeners.delete(type); },
  };
  const documentRef = {
    visibilityState: 'visible',
    addEventListener: (type, listener) => documentListeners.set(type, listener),
    removeEventListener: (type, listener) => { if (documentListeners.get(type) === listener) documentListeners.delete(type); },
  };
  let expired = null;
  const sessions = [];
  const expiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();
  const envelope = {
    accessToken: TOKEN,
    session: { id: 'session-one', subject: 'ops:one', permissions: [], displayUnits: 'imperial', expiresAt },
    controllerOrigin: ORIGIN,
  };
  const renewal = new WorkspaceSessionRenewal({
    controllerWindow,
    envelope,
    accessToken: TOKEN,
    fetchImpl: fetchImpl || (async () => { throw new Error('unexpected fetch'); }),
    windowRef,
    documentRef,
    setTimer: (handler, delay) => { const timer = { handler, delay, cleared: false };timers.push(timer);return timer; },
    clearTimer: (timer) => { timer.cleared = true; },
    randomUUID: (() => { let value = 0;return () => `request-${++value}`; })(),
    onSession: (value) => sessions.push(value),
    onExpired: (reason) => { expired = reason; },
  });
  return { renewal, envelope, controllerWindow, posted, timers, windowListeners, documentListeners, sessions, expired: () => expired };
}

test('workspace renewal pins the exact opener, Ops origin, protocol, request and stable bearer/session', async () => {
  const calls = [];
  const context = harness({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          accessToken: TOKEN,
          session: { ...context.envelope.session, expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() },
          controllerOrigin: context.envelope.controllerOrigin,
        }),
      };
    },
  });
  context.renewal.start();
  assert.deepEqual(context.posted[0], {
    origin: ORIGIN,
    message: { version: 1, type: 'ltds-viewer:workspace-ready', sessionId: 'session-one', subject: 'ops:one', expiresAt: context.envelope.session.expiresAt },
  });
  context.documentListeners.get('visibilitychange')();
  context.windowListeners.get('focus')();
  const request = context.posted.at(-1).message;
  assert.equal(request.type, 'ltds-viewer:workspace-session-expiring');
  assert.equal(context.posted.filter((entry) => entry.message.type === 'ltds-viewer:workspace-session-expiring').length, 1, 'focus and visibility coalesce while one renewal is pending');
  assert.deepEqual(Object.keys(request).sort(), ['expiresAt','requestId','sessionId','subject','type','version'].sort());

  await context.renewal.handleMessage({ source: {}, origin: ORIGIN, data: { version: 1, type: 'ltds-viewer:renew-workspace-session', requestId: request.requestId, grant: GRANT } });
  await context.renewal.handleMessage({ source: context.controllerWindow, origin: 'https://attacker.example', data: { version: 1, type: 'ltds-viewer:renew-workspace-session', requestId: request.requestId, grant: GRANT } });
  await context.renewal.handleMessage({ source: context.controllerWindow, origin: ORIGIN, data: { version: 2, type: 'ltds-viewer:renew-workspace-session', requestId: request.requestId, grant: GRANT } });
  await context.renewal.handleMessage({ source: context.controllerWindow, origin: ORIGIN, data: { version: 1, type: 'ltds-viewer:renew-workspace-session', requestId: request.requestId, grant: GRANT, extra: true } });
  assert.equal(calls.length, 0);

  await context.renewal.handleMessage({ source: context.controllerWindow, origin: ORIGIN, data: { version: 1, type: 'ltds-viewer:renew-workspace-session', requestId: request.requestId, grant: GRANT } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/v1/admin-sessions/redeem');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(calls[0].init.body), { grant: GRANT });
  assert.equal(context.sessions.length, 1);
  assert.equal(context.posted.at(-1).message.type, 'ltds-viewer:workspace-session-renewed');
  assert.deepEqual(Object.keys(context.posted.at(-1).message).sort(), ['expiresAt','requestId','sessionId','subject','type','version'].sort());
  assert.equal(context.posted.at(-1).origin, ORIGIN);
  assert.equal(context.expired(), null);
});

test('retryable renewal failures preserve the current session and stop after a bounded retry budget', async () => {
  let calls = 0;
  const context = harness({ fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ error: 'temporarily unavailable' }) }) });
  context.renewal.start();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal(context.renewal.requestRenewal(attempt ? 'retry' : 'timer'), true);
    const request = context.posted.findLast((entry) => entry.message.type === 'ltds-viewer:workspace-session-expiring').message;
    await context.renewal.handleMessage({ source: context.controllerWindow, origin: ORIGIN, data: { version: 1, type: 'ltds-viewer:renew-workspace-session', requestId: request.requestId, grant: GRANT } });
    calls += 1;
  }
  assert.equal(context.renewal.requestRenewal('retry'), false);
  assert.equal(calls, 5);
  assert.equal(context.renewal.accessToken, TOKEN);
  assert.equal(context.sessions.length, 0);
  assert.equal(context.expired(), null);
  const failures = context.posted.filter((entry) => entry.message.type === 'ltds-viewer:workspace-session-renewal-failed');
  assert.equal(failures.length, 5);
  assert.ok(failures.every((entry) => entry.message.retryable === true));
  assert.ok(failures.every((entry) => Object.keys(entry.message).sort().join(',') === ['requestId','retryable','type','version'].sort().join(',')));
});

test('only authoritative 401 or actual expiry clears the workspace session', async () => {
  const unauthorized = harness({ fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: 'authentication required' }) }) });
  unauthorized.renewal.start();
  unauthorized.renewal.requestRenewal('timer');
  const request = unauthorized.posted.findLast((entry) => entry.message.type === 'ltds-viewer:workspace-session-expiring').message;
  await unauthorized.renewal.handleMessage({ source: unauthorized.controllerWindow, origin: ORIGIN, data: { version: 1, type: 'ltds-viewer:renew-workspace-session', requestId: request.requestId, grant: GRANT } });
  assert.equal(unauthorized.expired(), 'unauthorized');
  assert.equal(unauthorized.posted.findLast((entry) => entry.message.type === 'ltds-viewer:workspace-session-renewal-failed').message.retryable, false);

  const expired = harness();
  expired.renewal.start();
  const expiryTimer = expired.timers.find((timer) => timer.delay > 60_000 && timer.delay < 3 * 60_000);
  expiryTimer.handler();
  assert.equal(expired.expired(), 'expired');
});

test('malformed controller configuration fails closed before registering a message channel', () => {
  const context = harness();
  assert.throws(() => new WorkspaceSessionRenewal({
    controllerWindow: context.controllerWindow,
    envelope: { ...context.envelope, controllerOrigin: `${ORIGIN}/path` },
    accessToken: TOKEN,
    windowRef: { addEventListener() {}, removeEventListener() {} },
    documentRef: { addEventListener() {}, removeEventListener() {} },
  }), /invalid workspace controller response/);
});
