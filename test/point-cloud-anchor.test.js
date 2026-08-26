'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { POINT_PICK_WINDOW, isPlausibleAnchorDistance } = require('../public/pointcloud-navigation.js');

test('point-cloud picking uses a narrow odd window instead of Potree default 65 pixels', () => {
  assert.equal(POINT_PICK_WINDOW, 11);
  assert.equal(POINT_PICK_WINDOW % 2, 1);
  assert.ok(POINT_PICK_WINDOW < 20);
});

test('point-cloud anchor depth rejects distant background hits but keeps nearby surface variation', () => {
  assert.equal(isPlausibleAnchorDistance(104, 100), true);
  assert.equal(isPlausibleAnchorDistance(135, 100), true);
  assert.equal(isPlausibleAnchorDistance(136, 100), false);
  assert.equal(isPlausibleAnchorDistance(8, 10), true, 'foreground points remain valid');
  assert.equal(isPlausibleAnchorDistance(15, 10), true, 'close views retain a five-metre minimum allowance');
  assert.equal(isPlausibleAnchorDistance(15.01, 10), false);
  assert.equal(isPlausibleAnchorDistance(Number.NaN, 10), false);
  assert.equal(isPlausibleAnchorDistance(10, 0), false);
});
