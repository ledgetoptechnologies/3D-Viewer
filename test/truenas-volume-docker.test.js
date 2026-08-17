'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const test = require('node:test');

const enabled = process.env.RUN_DOCKER_TESTS === '1';
const image = process.env.VIEWER_DOCKER_TEST_IMAGE || '';

test('Docker named volume initializes for uid 568 and persists across restart/upgrade', { skip: !enabled }, () => {
  assert.match(image, /(?:@sha256:[a-f0-9]{64}|:sha-[a-f0-9]{7,64})$/i, 'VIEWER_DOCKER_TEST_IMAGE must be immutable');
  const upgradeImage = process.env.VIEWER_DOCKER_UPGRADE_IMAGE || image;
  assert.match(upgradeImage, /(?:@sha256:[a-f0-9]{64}|:sha-[a-f0-9]{7,64})$/i, 'VIEWER_DOCKER_UPGRADE_IMAGE must be immutable');
  const volume = `ltds-viewer-test-${crypto.randomUUID()}`;
  const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  docker('volume', 'create', volume);
  try {
    const write = 'const fs=require("node:fs"),{openDatabase}=require("./server/database");fs.writeFileSync("/app/storage/data/restart-marker","preserved");const db=openDatabase("/app/storage/data/viewer.sqlite");db.prepare("INSERT OR REPLACE INTO app_state(key,value,updated_at) VALUES (?,?,?)").run("volume-test","ok",new Date().toISOString());db.close();';
    docker('run', '--rm', '--user', '568:568', '-v', `${volume}:/app/storage`, image, 'node', '-e', write);
    const verify = 'const fs=require("node:fs"),{openDatabase}=require("./server/database");if(fs.readFileSync("/app/storage/data/restart-marker","utf8")!=="preserved")process.exit(2);const db=openDatabase("/app/storage/data/viewer.sqlite");if(db.prepare("SELECT value FROM app_state WHERE key=?").get("volume-test")?.value!=="ok")process.exit(3);db.close();';
    docker('run', '--rm', '--user', '568:568', '-v', `${volume}:/app/storage`, image, 'node', '-e', verify);
    docker('run', '--rm', '--user', '568:568', '-v', `${volume}:/app/storage`, upgradeImage, 'node', '-e', verify);
  } finally {
    docker('volume', 'rm', '-f', volume);
  }
});
