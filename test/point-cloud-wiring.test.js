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
  assert.match(mainSource, /refreshPointGeometryBounds\(geometry\)/);
  assert.match(mainSource, /if \(is3D\) \{[\s\S]*?applyMeshLayer\(\);/);
  assert.match(
    mainSource,
    /pointCloudOffset\.add\(pointCloudObject\)[\s\S]*pointCloudParent\.updateMatrixWorld\(true\)[\s\S]*frameObjectHome\(pointCloudObject\)/,
  );
  assert.match(mainSource, /new THREE\.PointsMaterial\(\{[\s\S]*size:\s*2,[\s\S]*sizeAttenuation:\s*false/);
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

test('Potree controls preserve panel state and match mesh navigation feedback', () => {
  const viewerShell = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(mainSource, /message\.type === 'ready'[\s\S]*applyPcPanelState\(\)/);
  for (const call of ['setBudget', 'setSize', 'setSizing', 'setColor', 'setEDL']) {
    assert.match(mainSource, new RegExp(`api\\.${call}\\(`));
  }
  assert.match(pointCloudShell, /activeAttributeName = a/);
  assert.match(pointCloudShell, /PointSizeType\.ADAPTIVE/);
  assert.match(pointCloudShell, /PointSizeType\.ATTENUATED/);
  assert.match(pointCloudShell, /PointSizeType\.FIXED/);
  assert.match(pointCloudShell, /ctx\.strokeStyle = '#EE5007'/);
  assert.match(pointCloudShell, /ctx\.fillStyle = '#ffffff'/);
  assert.match(pointCloudShell, /Math\.PI \* 2 \* 0\.55 \/ h/);
  assert.match(pointCloudShell, /viewer\.earthControls\?\.pivotIndicator/);
  assert.match(pointCloudShell, /viewer\.setPointBudget\(4_000_000\)/);
  assert.match(pointCloudShell, /target:\s*4_000_000/);
  assert.match(viewerShell, /id="pc2-budget"[^>]*value="4"/);
  assert.match(viewerShell, /id="pc2-budget-val">4M</);
});

test('pre-metadata mesh view cannot strand a healthy cloud off camera', () => {
  assert.match(pointCloudShell, /pendingSyncedTarget = new THREE\.Vector3/);
  assert.match(pointCloudShell, /bounds\.distanceToPoint\(pendingSyncedTarget\)/);
  assert.match(pointCloudShell, /if \(!window\.__pcViewReady \|\| !syncedTargetIsRelevant\)/);
  assert.match(pointCloudShell, /viewer\.fitToScreen\(0\.7\)/);
});
