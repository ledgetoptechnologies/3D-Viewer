'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

test('new-tab session contract is versioned, removes grants, and isolates its exact controller', () => {
  assert.match(source, /SESSION_STORAGE_PREFIX\}\$\{session\.sessionId\}/);
  assert.match(source, /history\.replaceState\(null, '', `\/session\/active\/\$\{encodeURIComponent\(session\.sessionId\)\}`\)/);
  assert.match(source, /VIEW_MODE === 'session' \? 'view' : VIEW_MODE/);
  assert.match(source, /type: 'ltds-viewer:ready'/);
  assert.match(source, /window\.opener && !window\.opener\.closed/);
  assert.match(source, /event\.source !== controller \|\| !sessionAllowedOrigins\.includes\(event\.origin\)/);
  assert.match(source, /event\.data\.version !== 1/);
});

test('retryable renewal failure preserves the current stable capability', () => {
  const renewalHandler = source.slice(source.indexOf("window.addEventListener('message'"));
  assert.match(renewalHandler, /retryable: true/);
  assert.doesNotMatch(renewalHandler, /sessionStorage\.removeItem/);
});
