# Viewer — local technology demo

This is a **synthetic, viewer-only demonstration**, separated from the main application's history and deployment. It is intended for technical evaluation and discussion, not as a production WebODM installation or an import service.

It includes the accepted application's Three.js/3D Tiles renderer patches, KTX2 decoder support, camera controls, detail and memory-policy modules, loading backpressure and resource cleanup. A small independent bootstrap displays:

- A bundled synthetic checker surface using a root and one detailed B3DM tile, with real KTX2 textures.
- A deterministic, generated 10,201-point surface, using the same camera controls.

These small fixtures prove integration, not performance on large photogrammetry models. The point demo is an in-memory Three.js cloud, **not** the full application's Potree/EPT streaming implementation. The complete production overview/region coordinator, import pipeline and authentication/session workflow are intentionally absent.

## Run locally

Use Node.js 24 or newer and npm. From this directory:

```sh
npm ci
npm test
npm start
```

Open `http://127.0.0.1:8080`. Install needs Internet access to download npm dependencies. The running demo uses only local assets; there are no account, analytics or production-service calls.

For a bundled build:

```sh
npm run build
npm run preview
```

The development and preview servers bind to loopback and reject non-loopback request hosts/peers. They are **not designed for public hosting**. Do not expose the dev server using a tunnel, reverse proxy or a changed bind address. If you want to publish a demo site, review that separate deployment first.

## Navigation and diagnostics

Left-drag orbits, right/middle-drag pans, and the mouse wheel zooms. Touch supports one-finger orbit and two-finger pan/pinch. Reset view returns to the starting camera.

Detail uses the original screen-space-error mapping (20 is about 5.481, 24 is 2). Low-memory browser hints retain the reduced-detail safety profile. The fixture is too small for memory modes to show a meaningful performance difference. Changing view or memory mode deliberately reloads this tiny demo and disposes the previous renderer resources.

The status bar reports **tracked tile cache**, not total JavaScript, browser-process or GPU memory. `window.demoSnapshot()` provides read-only counters for local browser inspection, including the actual decoded texture format. A compressed format is measured from decoded textures, not inferred from filenames.

## Deliberately excluded

No customer images, scans, geographic positions, project names, databases, secrets, deployment configuration, old operational notes or Git history are included. There is no login, upload/import, WebODM/NodeODM connection, Operations worker, storage cleanup, public share link, session renewal, orthophoto/DSM/DTM mode or photo inspector. Nothing here should be connected to the original deployment.

Only exact bundled synthetic fixture paths and SHA-256 hashes are accepted. This is a **demo-only fixture allowlist**, not a replacement for the main application's converter provenance or surface-equivalence audit. No production audit receipt is fabricated or weakened. To experiment with other assets, create a separate reviewed fixture generator and explicit allowlist; do not add production URLs, tokens or customer data to this branch.

## Sharing and licensing

Share an archive of **this branch only**, or a separate repository populated only from this branch. A branch inside a repository is not an access-control boundary: granting access to the original repository can expose main and its history.

The source package declares ISC; that existing metadata is preserved. No standalone project LICENSE was present in the source snapshot, and this demo does not choose a new license or add an owner's permission grant. Confirm the owner's intended distribution terms before redistribution or incorporation into another project. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for dependency and attribution notes.

This branch is an evaluation snapshot, not a claim that the complete hosted application has been open-sourced.
