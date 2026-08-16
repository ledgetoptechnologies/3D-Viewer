'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const dockerSource = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
const pointCloudShell = fs.readFileSync(path.join(root, 'public', 'pointcloud.html'), 'utf8');

test('LAZ wiring retains Float64 until RTC localization and point-cloud-only init skips mesh load', () => {
  assert.match(mainSource, /las:\s*\{\s*colorDepth:\s*8,\s*fp64:\s*true\s*\}/);
  assert.match(mainSource, /localizePointPositions\(positions, RTC\)[\s\S]*new THREE\.BufferAttribute\(localized\.positions, 3\)/);
  assert.match(mainSource, /if \(hasMeshSource\(state\.meshSource\)\) applyMeshLayer\(\)/);
  assert.match(mainSource, /pointCloudOffset\.add\(pointCloudObject\)/);
});

test('production image copies and asserts the complete Potree release layout', () => {
  assert.match(dockerSource, /SRC_DIR="\$\(dirname "\$\(dirname "\$POTREE_BUILD_DIR"\)"\)"/);
  assert.match(dockerSource, /test -s \/potree\/build\/potree\/potree\.js/);
  assert.match(dockerSource, /test -s \/potree\/libs\/jquery\/jquery-3\.1\.1\.min\.js/);
  assert.match(dockerSource, /test -s \/potree\/libs\/copc\/index\.js/);
  assert.match(dockerSource, /test -s \/potree\/libs\/plasio\/js\/laslaz\.js/);
  assert.match(pointCloudShell, /\/potree\/libs\/jquery\/jquery-3\.1\.1\.min\.js/);
  assert.match(pointCloudShell, /\/potree\/libs\/copc\/index\.js/);
});
