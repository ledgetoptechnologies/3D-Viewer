import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { installLodKtx2Support } from '../lod-ktx2.mjs';

test('KTX2 support configures the transcoder before registering the tile loader plugin', () => {
  const calls = [];
  class FakeKtx2Loader {
    setTranscoderPath(value) { calls.push(['transcoder', value]); return this; }
    setWorkerLimit(value) { calls.push(['workers', value]); return this; }
    detectSupport(value) { calls.push(['support', value]); return this; }
    dispose() { calls.push(['dispose']); }
  }
  class FakeGltfExtensionsPlugin {
    constructor(options) {
      this.options = options;
      calls.push(['plugin', options]);
    }
  }
  const webglRenderer = { name: 'renderer' };
  const tilesRenderer = {
    registerPlugin(plugin) { calls.push(['register', plugin]); },
  };

  const installed = installLodKtx2Support(tilesRenderer, webglRenderer, {
    KTX2LoaderClass: FakeKtx2Loader,
    GLTFExtensionsPluginClass: FakeGltfExtensionsPlugin,
    transcoderPath: '/basis/',
    workerLimit: 2,
  });

  assert.equal(installed.loader instanceof FakeKtx2Loader, true);
  assert.equal(installed.plugin instanceof FakeGltfExtensionsPlugin, true);
  assert.deepEqual(calls.slice(0, 3), [
    ['transcoder', '/basis/'],
    ['workers', 2],
    ['support', webglRenderer],
  ]);
  assert.equal(calls[3][0], 'plugin');
  assert.equal(calls[3][1].ktxLoader, installed.loader);
  assert.equal(calls[3][1].autoDispose, false);
  assert.deepEqual(calls[4], ['register', installed.plugin]);
  installed.dispose();
  assert.deepEqual(calls[5], ['dispose']);
});

test('Viewer installs KTX2 support before configuring or updating the tile renderer', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.match(main, /import \{ installLodKtx2Support \} from '\.\/lod-ktx2\.mjs';/);
  assert.match(
    main,
    /const rendererInstance = new TilesRenderer\(TILES_URL\);\s*tilesRenderer = rendererInstance;\s*lodKtx2Support = installLodKtx2Support\(rendererInstance, renderer\);\s*const detailSlider/,
  );
  assert.match(main, /tilesRenderer\.dispose\(\);[\s\S]*lodKtx2Support\?\.dispose\(\);[\s\S]*lodKtx2Support = null;/);
});

test('postinstall copies the pinned Three.js Basis transcoder into the public build', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.postinstall, /install-basis-transcoder\.mjs/);
  for (const name of ['basis_transcoder.js', 'basis_transcoder.wasm']) {
    const source = fs.readFileSync(path.join(root, 'node_modules', 'three', 'examples', 'jsm', 'libs', 'basis', name));
    const installed = fs.readFileSync(path.join(root, 'public', 'basis', name));
    assert.deepEqual(installed, source, `${name} must match the pinned Three.js package`);
  }
});

test('both container install stages receive the Basis installer before npm ci', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const copies = dockerfile.match(/COPY scripts\/patch-3d-tiles-renderer\.mjs scripts\/install-basis-transcoder\.mjs \.\/scripts\//g) || [];
  assert.equal(copies.length, 2);
});
