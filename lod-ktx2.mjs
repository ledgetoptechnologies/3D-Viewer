import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { GLTFExtensionsPlugin } from '3d-tiles-renderer/three/plugins';

export function installLodKtx2Support(tilesRenderer, renderer, {
  KTX2LoaderClass = KTX2Loader,
  GLTFExtensionsPluginClass = GLTFExtensionsPlugin,
  transcoderPath = '/basis/',
  workerLimit = 2,
} = {}) {
  const loader = new KTX2LoaderClass()
    .setTranscoderPath(transcoderPath)
    .setWorkerLimit(workerLimit)
    .detectSupport(renderer);
  const plugin = new GLTFExtensionsPluginClass({ ktxLoader: loader, autoDispose: false });
  tilesRenderer.registerPlugin(plugin);
  let disposed = false;
  return {
    loader,
    plugin,
    dispose() {
      if (disposed) return;
      disposed = true;
      loader.dispose();
    },
  };
}
