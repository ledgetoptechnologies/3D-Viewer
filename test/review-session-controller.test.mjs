import test from 'node:test';
import assert from 'node:assert/strict';
import { ReviewSessionController } from '../review-session-controller.mjs';

const ORIGIN = 'https://viewer.example';
const CHANNEL_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const REQUEST_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const GRANT = '11111111-2222-4333-8444-555555555555';
const NOW = Date.parse('2026-08-26T12:00:00.000Z');
const CURRENT_EXPIRY = '2026-08-26T12:04:00.000Z';
const NEXT_EXPIRY = '2026-08-26T12:29:00.000Z';
const CONTEXT = Object.freeze({
  attemptId: 'attempt-one', modelId: 'model-one', modelVersionId: 'version-one', sessionTtlSeconds: 1800,
});

class FakeChannel {
  constructor(name) { this.name = name; this.posts = []; this.closed = false; this.onmessage = null; }
  postMessage(value) { this.posts.push(value); }
  emit(data) { return this.onmessage?.({ data }); }
  close() { this.closed = true; }
}

function harness(overrides = {}) {
  const channels = [];
  const calls = [];
  const timers = [];
  const controller = new ReviewSessionController({
    origin: ORIGIN,
    issueGrant: async context => {
      calls.push(context);
      return { grant: GRANT, sessionMode: 'review', ...CONTEXT };
    },
    createChannel: name => { const channel = new FakeChannel(name); channels.push(channel); return channel; },
    now: () => NOW,
    retryDelays: [10, 20],
    setTimer: (handler, delay) => { const timer = { handler, delay, cleared: false }; timers.push(timer); return timer; },
    clearTimer: timer => { timer.cleared = true; },
    ...overrides,
  });
  return { controller, channels, calls, timers };
}

function ready(channel, expiresAt = CURRENT_EXPIRY) {
  return channel.emit({ version: 1, type: 'ltds-viewer:ready', modelId: CONTEXT.modelId, expiresAt });
}

function expiring(channel, overrides = {}) {
  return channel.emit({
    version: 1, type: 'ltds-viewer:session-expiring', requestId: REQUEST_ID,
    modelId: CONTEXT.modelId, expiresAt: CURRENT_EXPIRY, ...overrides,
  });
}

test('isolated review channel navigates and issues one expiry-bound renewal grant', async () => {
  const { controller, channels, calls } = harness();
  assert.equal(controller.track(CHANNEL_ID, CONTEXT), true);
  const channel = channels[0];
  assert.equal(channel.name, `ltds-viewer-review:${CHANNEL_ID}`);
  assert.equal(controller.navigate(CHANNEL_ID, `${ORIGIN}/session/${GRANT}#reviewController=${CHANNEL_ID}`), true);
  assert.deepEqual(channel.posts.at(-1), { version: 1, type: 'ltds-viewer:navigate', url: `${ORIGIN}/session/${GRANT}#reviewController=${CHANNEL_ID}` });
  assert.equal(await ready(channel), true);
  assert.equal(await expiring(channel), true);
  assert.deepEqual(calls, [CONTEXT]);
  assert.deepEqual(channel.posts.at(-1), { version: 1, type: 'ltds-viewer:renew-session', requestId: REQUEST_ID, grant: GRANT });
  assert.equal(await expiring(channel), false, 'same request cannot mint another grant while redemption is pending');
  assert.equal(calls.length, 1);

  assert.equal(await channel.emit({ version: 1, type: 'ltds-viewer:session-renewed', requestId: REQUEST_ID, modelId: CONTEXT.modelId, expiresAt: NEXT_EXPIRY }), true);
  assert.equal(await expiring(channel), false, 'replayed request id and stale expiry stay rejected after renewal');
  controller.dispose();
  assert.equal(channel.closed, true);
});

test('a suspended Viewer may request an exact renewal after its recorded expiry', async () => {
  let clock = NOW;
  const { controller, channels, calls } = harness({ now: () => clock });
  controller.track(CHANNEL_ID, CONTEXT);
  const channel = channels[0];
  await ready(channel);
  clock = Date.parse(CURRENT_EXPIRY) + 60_000;
  assert.equal(await expiring(channel), true);
  assert.equal(calls.length, 1);
  assert.equal(channel.posts.at(-1).type, 'ltds-viewer:renew-session');
});

test('same-expiry response clears the renewal race and permits a later retry', async () => {
  const { controller, channels, calls } = harness();
  controller.track(CHANNEL_ID, CONTEXT);
  const channel = channels[0];
  await ready(channel);
  assert.equal(await expiring(channel), true);
  assert.equal(await channel.emit({
    version: 1, type: 'ltds-viewer:session-renewed', requestId: REQUEST_ID,
    modelId: CONTEXT.modelId, expiresAt: CURRENT_EXPIRY,
  }), true);
  const retryId = 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa';
  assert.equal(await expiring(channel, { requestId: retryId }), true);
  assert.equal(calls.length, 2);
  assert.equal(channel.posts.at(-1).requestId, retryId);
});

test('a delivered grant cannot leave the controller permanently awaiting a sleeping Viewer', async () => {
  const { controller, channels, calls, timers } = harness();
  controller.track(CHANNEL_ID, CONTEXT);
  const channel = channels[0];
  await ready(channel);
  await expiring(channel);
  const responseTimer = timers.find(timer => timer.delay === 35_000 && !timer.cleared);
  assert.ok(responseTimer);
  responseTimer.handler();
  const retryId = 'dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb';
  assert.equal(await expiring(channel, { requestId: retryId }), true);
  assert.equal(calls.length, 2);
});

test('wrong shape, model, expiry, early request, and unknown channel mint nothing', async () => {
  const { controller, channels, calls } = harness();
  controller.track(CHANNEL_ID, CONTEXT);
  const channel = channels[0];
  assert.equal(await expiring(channel), false, 'expiry cannot be requested before Viewer ready binds the session');
  await ready(channel, '2026-08-26T12:20:00.000Z');
  assert.equal(await expiring(channel, { expiresAt: '2026-08-26T12:20:00.000Z' }), false, 'requests outside the five-minute renewal window fail closed');
  await ready(channel);
  assert.equal(await expiring(channel, { modelId: 'other-model' }), false);
  assert.equal(await expiring(channel, { expiresAt: '2026-08-26T12:03:59.000Z' }), false);
  assert.equal(await expiring(channel, { extra: true }), false);
  const unknown = new FakeChannel('ltds-viewer-review:unknown');
  assert.equal(await expiring(unknown), undefined);
  assert.equal(calls.length, 0);
});

test('mismatched issuance response is never delivered', async () => {
  const { controller, channels } = harness({ issueGrant: async () => ({ grant: GRANT, sessionMode: 'review', ...CONTEXT, modelId: 'wrong' }) });
  controller.track(CHANNEL_ID, CONTEXT);
  const channel = channels[0];
  await ready(channel);
  assert.equal(await expiring(channel), false);
  assert.equal(controller.has(CHANNEL_ID), false);
  assert.equal(channel.posts.some(post => post.type === 'ltds-viewer:renew-session'), false);
});

test('an authoritative failed grant redemption closes the bounded renewal channel', async () => {
  const { controller, channels } = harness();
  controller.track(CHANNEL_ID, CONTEXT);
  const channel = channels[0];
  await ready(channel);
  assert.equal(await expiring(channel), true);
  assert.equal(await channel.emit({
    version: 1, type: 'ltds-viewer:session-renewal-failed', requestId: REQUEST_ID,
    modelId: CONTEXT.modelId, retryable: false,
  }), true);
  assert.equal(controller.has(CHANNEL_ID), false);
  assert.equal(channel.closed, true);
});

test('a transient grant redemption failure keeps the channel available for a new request', async () => {
  const { controller, channels, calls } = harness();
  controller.track(CHANNEL_ID, CONTEXT);
  const channel = channels[0];
  await ready(channel);
  await expiring(channel);
  assert.equal(await channel.emit({
    version: 1, type: 'ltds-viewer:session-renewal-failed', requestId: REQUEST_ID,
    modelId: CONTEXT.modelId, retryable: true,
  }), true);
  assert.equal(controller.has(CHANNEL_ID), true);
  const retryId = 'eeeeeeee-ffff-4aaa-8bbb-cccccccccccc';
  assert.equal(await expiring(channel, { requestId: retryId }), true);
  assert.equal(calls.length, 2);
});

test('transient issuance retries are bounded and workspace authorization failure closes the channel', async () => {
  let attempts = 0;
  const error = Object.assign(new Error('temporary'), { status: 503 });
  const { controller, channels, timers } = harness({ issueGrant: async () => { attempts += 1; throw attempts < 3 ? error : Object.assign(new Error('expired'), { status: 401 }); } });
  controller.track(CHANNEL_ID, CONTEXT);
  const channel = channels[0];
  await ready(channel);
  assert.equal(await expiring(channel), false);
  assert.equal(timers.filter(timer => !timer.cleared).length, 1);
  await timers.find(timer => !timer.cleared).handler();
  assert.equal(timers.filter(timer => !timer.cleared).length, 1);
  await timers.find(timer => !timer.cleared).handler();
  assert.equal(attempts, 3);
  assert.equal(controller.has(CHANNEL_ID), false);
  assert.equal(channel.closed, true);
  assert.equal(channel.posts.at(-1).type, 'ltds-viewer:session-unavailable');
  assert.equal(channel.posts.at(-1).requestId, REQUEST_ID);
  assert.equal(channel.posts.at(-1).reason, 'authorization-required');
});

test('published sessions renew through the same isolated channel with an immutable output scope', async () => {
  const context = { sessionMode: 'published', outputId: 'version-one', modelId: 'model-one',
    modelVersionId: 'version-one', sessionTtlSeconds: 1800 };
  const calls = [];
  const { controller, channels } = harness({ issueGrant: async value => {
    calls.push(value);
    return { grant: GRANT, sessionMode: 'published', modelId: context.modelId,
      modelVersionId: context.modelVersionId, sessionTtlSeconds: context.sessionTtlSeconds };
  } });
  assert.equal(controller.track(CHANNEL_ID, { ...context, outputId: 'different-version' }), false);
  assert.equal(controller.track(CHANNEL_ID, context), true);
  const channel = channels[0];
  await ready(channel);
  assert.equal(await expiring(channel), true);
  assert.deepEqual(calls, [context]);
  assert.ok(Object.isFrozen(calls[0]));
  assert.equal(channel.posts.at(-1).type, 'ltds-viewer:renew-session');
  assert.equal(await channel.emit({ version: 1, type: 'ltds-viewer:session-renewed',
    requestId: REQUEST_ID, modelId: context.modelId, expiresAt: NEXT_EXPIRY }), true);
});

test('published renewal refuses a new model version or a review grant', async () => {
  for (const change of [{ modelVersionId: 'version-two' }, { sessionMode: 'review' }]) {
    const context = { sessionMode: 'published', outputId: 'version-one', modelId: 'model-one',
      modelVersionId: 'version-one', sessionTtlSeconds: 1800 };
    const { controller, channels } = harness({ issueGrant: async () => ({ ...context, grant: GRANT, ...change }) });
    controller.track(CHANNEL_ID, context);
    await ready(channels[0]);
    assert.equal(await expiring(channels[0]), false);
    assert.equal(controller.has(CHANNEL_ID), false);
    assert.equal(channels[0].posts.at(-1).reason, 'scope-changed');
    assert.equal(channels[0].posts.some(message => message.grant), false);
  }
});
