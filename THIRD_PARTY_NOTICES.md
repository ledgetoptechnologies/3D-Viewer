# Attribution and third-party notices

The Viewer source modules retain their existing authorship comments and internal namespace. They are adapted from the first user-accepted Viewer baseline. Only customer-specific comments were generalized in the shared policy module; the production repository is not modified by those demo edits.

This demo uses pinned upstream packages downloaded by npm. Copies of the direct dependency licenses and Basis README are included in `public/third-party/`, and are carried into the built output. Preserve their LICENSE/NOTICE files when redistributing dependencies or compiled output:

- **Three.js** — rendering, loaders and the Basis transcoder distribution. See `node_modules/three/LICENSE` and the notices in `node_modules/three/examples/jsm/libs/basis/`.
- **3d-tiles-renderer** — 3D Tiles traversal and rendering. See its installed `LICENSE` file. `scripts/patch-3d-tiles-renderer.mjs` applies explicit version-pinned Viewer changes to source and bundle.
- **three-mesh-bvh** — mesh raycasting acceleration. See its installed `LICENSE` file.
- **Vite** and its transitive dependencies — build/local development tooling. Preserve the installed package license and dependency notices where applicable.
- **Basis Universal / Emscripten** — KTX2 transcoding assets distributed with Three.js. The install script verifies pinned asset hashes and changes only CSP-compatible JavaScript invocation bridges; it does not replace the decoder WASM. Preserve the upstream notices included with these assets.

The tiny textured fixture is the synthetic checker fixture used in the Viewer test suite; it contains no customer imagery or georeferenced scan. The point surface is generated mathematically in `fixture-policy.mjs`.

The project's original package declared ISC, but no standalone owner LICENSE file was found in the source snapshot. This document is attribution and disclosure, **not** a new license grant or a legal determination that third-party redistribution requirements are complete. Confirm distribution terms before shipping a derived public product.
