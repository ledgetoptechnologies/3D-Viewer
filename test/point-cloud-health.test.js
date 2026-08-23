'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createPointCloudHealth, FAILURES } = require('../public/pointcloud-health.js');

function fixture() {
  const classes = () => {
    const values = new Set();
    return {
      add: (...names) => names.forEach((name) => values.add(name)),
      remove: (...names) => names.forEach((name) => values.delete(name)),
      contains: (name) => values.has(name),
    };
  };
  const elements = {
    'pc-loading': { classList: classes() },
    'pc-loading-text': { textContent: '' },
    'pc-status': { textContent: '' },
    'pc-retry': {
      hidden: true,
      disabled: false,
      addEventListener(type, handler) { if (type === 'click') this.click = handler; },
    },
  };
  const timers = new Map();
  const messages = [];
  let timerId = 0;
  let reloads = 0;
  const parent = { postMessage: (message, origin) => messages.push({ message, origin }) };
  const win = { parent, location: { origin: 'https://viewer.example' } };
  const health = createPointCloudHealth({
    window: win,
    document: { getElementById: (id) => elements[id] || null },
    setTimeout: (fn) => { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout: (id) => timers.delete(id),
    reload: () => { reloads += 1; },
    startupTimeoutMs: 1,
    loadTimeoutMs: 2,
    nodeTimeoutMs: 3,
  });
  const fireOnlyTimer = () => {
    assert.equal(timers.size, 1);
    const fn = [...timers.values()][0];
    timers.clear();
    fn();
  };
  return { elements, health, messages, timers, fireOnlyTimer, reloads: () => reloads };
}

test('startup and node watchdogs terminate with fixed actionable messages', () => {
  const startup = fixture();
  startup.health.beginStartup();
  startup.fireOnlyTimer();
  assert.equal(startup.health.phase(), 'failed');
  assert.equal(startup.elements['pc-loading-text'].textContent, FAILURES.startup_timeout);
  assert.equal(startup.elements['pc-retry'].hidden, false);
  assert.deepEqual(startup.messages, [{
    message: { source: 'ltds-pointcloud', type: 'error', code: 'startup_timeout' },
    origin: 'https://viewer.example',
  }]);

  const nodes = fixture();
  nodes.health.beginStartup();
  nodes.health.beginLoad();
  nodes.health.metadataReady();
  nodes.fireOnlyTimer();
  assert.equal(nodes.elements['pc-loading-text'].textContent, FAILURES.node_timeout);
  assert.equal(nodes.elements['pc-loading-text'].textContent.includes('http'), false);
});

test('visible points clear the watchdog and notify only the same-origin parent', () => {
  const value = fixture();
  value.health.beginStartup();
  value.health.beginLoad();
  value.health.metadataReady();
  value.health.pointsVisible();
  assert.equal(value.health.phase(), 'ready');
  assert.equal(value.timers.size, 0);
  assert.equal(value.elements['pc-loading'].classList.contains('hidden'), true);
  assert.deepEqual(value.messages, [{
    message: { source: 'ltds-pointcloud', type: 'ready', code: 'points_visible' },
    origin: 'https://viewer.example',
  }]);
});

test('late visible points recover from the observational node timeout only', () => {
  const late = fixture();
  late.health.beginStartup();
  late.health.beginLoad();
  late.health.metadataReady();
  late.fireOnlyTimer();
  assert.equal(late.health.phase(), 'failed');
  late.health.pointsVisible();
  assert.equal(late.health.phase(), 'ready');
  assert.equal(late.elements['pc-loading'].classList.contains('hidden'), true);
  assert.deepEqual(late.messages.map(({ message }) => message), [
    { source: 'ltds-pointcloud', type: 'error', code: 'node_timeout' },
    { source: 'ltds-pointcloud', type: 'ready', code: 'points_visible' },
  ]);

  const structural = fixture();
  structural.health.beginStartup();
  structural.health.fail('metadata_failed');
  structural.health.pointsVisible();
  assert.equal(structural.health.phase(), 'failed');
});

test('retry is explicit and missing configuration does not offer a reload loop', () => {
  const failed = fixture();
  failed.health.beginStartup();
  failed.health.fail('metadata_failed');
  assert.equal(failed.reloads(), 0);
  failed.elements['pc-retry'].click();
  assert.equal(failed.reloads(), 1);
  assert.equal(failed.elements['pc-retry'].disabled, true);

  const missing = fixture();
  missing.health.beginStartup();
  missing.health.fail('not_configured', { retryable: false });
  assert.equal(missing.elements['pc-retry'].hidden, true);
  assert.equal(missing.elements['pc-loading-text'].textContent, FAILURES.not_configured);
});

test('point-cloud shell starts watchdogs before Potree and requires visible nodes before readiness', () => {
  const shell = fs.readFileSync(path.join(__dirname, '..', 'public', 'pointcloud.html'), 'utf8');
  assert.ok(shell.indexOf('/pointcloud-health.js') < shell.indexOf('/potree/libs/jquery/jquery-3.1.1.min.js'));
  assert.match(shell, /pointCloudHealth\.beginStartup\(\)/);
  assert.match(shell, /pointCloudHealth\.beginLoad\(\)[\s\S]*Potree\.loadPointCloud/);
  assert.match(shell, /pc\.numVisiblePoints > 0[\s\S]*pc\.visibleNodes[\s\S]*pointCloudHealth\.pointsVisible\(\)/);
  assert.doesNotMatch(shell, /showPointCloudBootstrapError\([^)]*(?:event\.message|event\.reason|target\.src|target\.href)/);
});
