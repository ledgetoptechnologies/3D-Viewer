# Viewer LOD and camera investigation handoff

## Status

**Unresolved as of 2026-08-27.**

The current release passed repository tests, real local B3DM fixture tests, image
verification, and independent review. The user subsequently reported that the
Viewer is still having issues. Earlier repeated reports described the LOD view
as incomplete, transparent, ghost-like, or otherwise visually off near the
camera. The exact post-release manifestation has not yet been captured against
the current production build.

Treat the user's live report as authoritative. Do not conclude that the issue
is fixed merely because the fixture tests below passed.

This document is a handoff for a fresh investigation. It records the current
implementation, evidence, rejected approaches, and open questions. It does not
claim a root cause for the remaining live issue.

## Runtime baseline under investigation

The behavior described here was introduced by the following runtime commit.
Documentation-only descendants may carry a later source revision and mutable
`latest` digest without changing the Viewer runtime behavior.

- Source commit: `2d88c70511b01d63bb17e8841c066fb5cb6c6ca7`
- Commit subject: `[verified] Fix camera markers and LOD streaming`
- GitHub Actions run: `33116723395`
- Mutable image tag at the time of the runtime release:
  `ghcr.io/ledgetoptechnologies/3d-viewer:latest`
- Immutable image tag: `ghcr.io/ledgetoptechnologies/3d-viewer:sha-2d88c70`
- Image digest:
  `sha256:44a909b95e757033b956c0b4b071bd8adc2f404aa2fe6e781fcbe477d7fb6fc8`
- Viewer schema: `26`
- `3d-tiles-renderer`: package range `^0.5.1`
- Three.js: package range `^0.185.1`
- Potree runtime: `1.8.2`
- Obj2Tiles runtime: `1.6.2`

Before debugging rendering, verify the live browser is actually using this
revision. The Viewer reads `x-ltds-viewer-revision` from `/api/v1/health` and
stores it in `VIEWER_BUILD_REVISION`. A stale deployment, stale container, or
cached frontend must be ruled out first.

## Relevant source map

### LOD runtime

- `lod-policy.mjs`
  - Detail-to-screen-space-error mapping
  - desktop and low-memory cache profiles
  - queue priority
  - Detail 13 warmup policy
  - slider transition policy
  - safe aggregate diagnostics
- `main.js`
  - `loadTiles()` renderer setup and event wiring
  - `maybeAdvanceLodWarmup()` runtime transition
  - Detail slider event handling
  - render loop
  - `[LTDS LOD]` console telemetry
- `lod-materials.mjs`
  - conversion of streamed tile materials to unlit materials
  - texture, alpha, transparency, vertex-color, and depth behavior
- `test/lod-policy.test.mjs`
  - policy and state-transition coverage
- `test/lod-materials.test.mjs`
  - streamed material behavior
- `test/lod-browser-acceptance.test.mjs`
  - real B3DM browser fixtures and close/far/return tests
- `test/viewer-runtime-wiring.test.js`
  - runtime source contracts

### Camera markers

- `camera-markers.mjs`
  - independently drawn orange, white, and yellow geometry
  - fixed world scale and representative selection
- `main.js`
  - Model camera loading, matrices, hover, picking, and photo opening
- `public/pointcloud-cameras.js`
  - Potree-compatible camera geometry, fixed scale, hover, and source mapping
- `public/pointcloud.html`
  - Point Cloud pointer and camera-open wiring
- `test/camera-runtime.test.mjs`
- `test/camera-photos.test.js`
- `test/point-cloud-cameras.test.js`
- `test/point-cloud-wiring.test.js`

## Current LOD behavior

### Traversal

The runtime now preserves the manifest's standard `REPLACE` refinement. It no
longer mutates the root to `ADD`.

Current renderer settings:

- `loadAncestors = false`
- `loadSiblings = false`
- `maxDepth = Infinity`
- download queue maximum: 6 jobs
- parse queue maximum: 2 jobs
- visible, in-frustum, high-error tiles receive queue priority

The application does not manually change cached tile `scene.visible`, tile
active state, tile visible state, or LRU usage.

### Detail mapping

The Detail slider range is `2..24`. Detail maps exponentially to screen-space
error:

```text
errorTarget = 2 * 256 ^ ((24 - detail) / (24 - 2))
```

Examples:

- Detail 24: error target 2
- Detail 13: error target 32
- Detail 2: error target 512

### Desktop warmup

A desktop request above Detail 13 starts at Detail 13. The runtime advances to
the requested Detail only when:

1. the current visible frontier satisfies the active error target;
2. the download queue is settled;
3. the parse queue is settled; and
4. the process-node queue is settled.

Lowering Detail below 13 clears warmup completion. A later increase must stage
through Detail 13 again. This prevents the `24 -> 2 -> 24` slider sequence from
bypassing the warmup.

### Memory profiles

Desktop/default profile:

- minimum warm bytes: `0.4 GiB`
- maximum decoded bytes: `3 GiB`
- minimum entries: 8
- maximum entries: 48
- unload percentage: 20 percent

Clients reporting `navigator.deviceMemory <= 4`:

- maximum Detail: 13
- minimum warm bytes: `384 MiB`
- maximum decoded bytes: `768 MiB`
- minimum entries: 8
- maximum entries: 24
- unload percentage: 20 percent

The reduced profile is deliberately honest. It does not claim that Detail 24
will eventually load inside a cache too small for the measured frontier.

## Current camera behavior

The WebODM camera asset was inspected only as a visual reference. No WebODM
GLB, Blender data, or extracted geometry was copied into this repository.

The current marker is independently drawn as three synchronized instanced
meshes:

- orange `#EE5007` camera body
- white tapered frustum
- yellow `#FFA200` forward lens/direction region

Other contracts:

- default fixed world scale: `0.5`
- user range: `0.1..4`
- normal opacity: `0.7`
- representative screen cell: 18 pixels
- maximum visible representatives: 4,000
- fallback pick radius: 12 pixels
- source camera orientation is preserved
- rendered draw indices map back to exact source indices
- Model and Point Cloud use the same geometry
- Model uses lit `MeshStandardMaterial`
- Point Cloud uses unlit `MeshBasicMaterial` because Potree renders custom
  markers in a scene without the point-cloud scene's lights
- Point Cloud hover is source-index based, so a changed representative draw
  slot does not inherit a stale highlight
- camera photos remain permission-gated, indexed, and path-normalized

The latest user message did not say whether camera appearance is still part of
the remaining issue. Confirm that separately instead of assuming it is solved.

## External references and reviews

### WebODM visual reference

The public `OpenDroneMap/WebODM` repository was inspected at commit
`35daffa41768b2ece493367ae62f76739522ccba`. The investigation reviewed
`ModelView.jsx`, the camera model/material arrangement, styling, and license.
The temporary clone was removed after inspection. No upstream camera asset or
extracted vertex data was committed.

### Anthropic Fable 5 advice

Fable 5 was asked for a read-only review of the LOD problem. Its useful advice
was to:

- preserve standard `REPLACE` traversal;
- stop treating a cache increase as a complete solution;
- stage a bounded visible frontier before requesting maximum detail;
- report reduced-memory quality honestly; and
- avoid broad manual renderer-state intervention.

That advice was treated as a hypothesis and checked against the pinned source
and real fixture. A suggestion to set cached `scene.visible = false` was
rejected after source inspection because it could persist through scene reuse.
No external-review credentials, prompts, or raw responses are stored in this
repository.

### Independent release reviews

Independent reviewers found four release blockers during the final iteration:

1. Potree camera markers used a lit material in an unlit scene.
2. Point Cloud camera markers lacked source-mapped hover parity.
3. early diagnostics exposed sanitized tile filenames instead of aggregate
   counts only;
4. the Detail slider could bypass Detail 13 warmup through a
   `24 -> 2 -> 24` sequence.

All four were corrected and covered before release. They remain important
regression checks for future proposals.

## What was changed and tried

### Commit `ea5447fb0ee98faea9a140456bf78341d9b7ac6a`

This earlier attempt added compact camera markers, density decluttering, exact
source-index picking, the 12-pixel fallback, and foreground LOD handling. The
LOD approach retained a transient coarse-root underlay by changing the runtime
root behavior to `ADD` and managing its appearance.

Outcome:

- camera interaction worked;
- the user still reported foreground LOD problems;
- later A/B testing showed coarse root and fine children rendering together,
  which is a direct ghost/mixed-detail mechanism.

### Commit `d32368f24dc3c152a045aeb5f8ce3409668c8c5b`

This attempt:

- raised the desktop cache from 1.75 GiB to 2.75 GiB;
- removed depth/FOV/viewport-dependent camera scaling;
- retained fixed world-space camera matrices;
- added a strict close/far/return fixture regression.

Outcome:

- the strict fixture test passed;
- the user still reported the live LOD view was off;
- the larger cache fixed a proven capacity failure but did not prove that
  capacity was the only live defect.

### Commit `2d88c70511b01d63bb17e8841c066fb5cb6c6ca7`

This release:

- restored standard `REPLACE` traversal;
- removed the transient root underlay and manual tile/LRU state changes;
- added Detail 13 desktop warmup and honest low-memory capping;
- increased measured desktop transition headroom to 3 GiB;
- added aggregate LOD console diagnostics;
- replaced the two-part marker with the current three-part marker;
- reduced the default camera scale to 0.5;
- added Potree hover and corrected Potree's unlit material requirement;
- fixed the Detail-slider warmup bypass.

Outcome:

- all repository and fixture release gates passed;
- the user then reported that the Viewer still has issues;
- therefore the current release remains an investigation baseline, not a
  confirmed live fix.

## Measurements and test evidence

The real local test fixture contains 33 B3DM tiles.

Measured decoded working sets:

- root plus 12 close LOD-0 leaves: `2,482,109,023` bytes, about 2.31 GiB
- sustained all-16-leaf frontier: about `2,713,539,801` bytes, about 2.53 GiB
- measured branch-replacement transition peak: about 2.784 GiB

The 1.75 GiB cache reproducibly became full and prevented three required leaves
from entering the download queue. The 2.75 GiB and 3 GiB profiles could complete
the measured fixture frontier.

The final sustained test pose is encoded in
`test/lod-browser-acceptance.test.mjs`. The final real fixture regression:

- loaded all required foreground branches;
- detached the coarse root after full replacement coverage;
- moved far enough to drain detailed content;
- returned to the original view; and
- restored all required leaves.

That test completed successfully in about 490 seconds.

Final release evidence:

- Node 24 suite: 459 passed, 0 failed, 0 cancelled, 9 expected skips
- real camera/diagnostics browser test: passed
- real 16-leaf close/far/return test: passed
- `npm audit --omit=dev --audit-level=high`: zero vulnerabilities
- independent release gate: approved
- container user: `568:568`
- schema 26 verified
- Obj2Tiles 1.6.2 runtime verified
- Potree 1.8.2 EPT/COPC patch verified
- immutable image and release attestation verified

### Limits of that evidence

The browser tests use a local verified fixture and local HTTP transport. They do
not reproduce every production model, proxy path, GPU, browser, viewport,
network condition, decoded texture footprint, or cache history. A passing local
fixture cannot disprove a live failure on a different hierarchy or client.

The final release test also proves eventual convergence, not necessarily that
every intermediate frame looks acceptable to a user. A branch can legally show
an intermediate parent while its replacement leaf parses. The remaining report
may involve transition quality, latency, materials, clipping, stale deployment,
or a different working set rather than the original global-root overlap.

## Approaches rejected or superseded

Do not restore these without new, direct evidence:

1. **Runtime root `REPLACE -> ADD` mutation**
   - It can render a global coarse root with refined descendants.
   - The A/B screenshot test showed a mixed coarse/fine state.

2. **Manual `engineData.scene.visible = false`**
   - Scene visibility can survive cached-scene reuse and create revisit holes.

3. **Manual tile active/visible/LRU manipulation**
   - It bypasses renderer lifecycle assumptions and previously created hard to
     reason about revisit behavior.

4. **Another cache increase without measuring the live model**
   - Cache capacity was one proven defect, but the user still reported trouble
     after the measured increase.

5. **Copying WebODM's camera asset**
   - WebODM is AGPL-3.0 and the Viewer uses an independently drawn marker.

6. **Potree `MeshStandardMaterial` without lights in the same scene**
   - The marker can render black. Potree markers intentionally use
     `MeshBasicMaterial`.

7. **General CSP `unsafe-eval` or broad external origins**
   - Keep the existing narrow WebAssembly and blob exceptions only.

## Safe runtime diagnostics

The Viewer logs deduplicated snapshots under:

```text
[LTDS LOD]
```

A user or agent can request a snapshot in DevTools:

```javascript
window.__ltds.lodDiagnostics()
```

The snapshot contains only aggregate state:

- phase: `warmup`, `requested-detail`, or `reduced-memory`
- requested, active, and maximum Detail
- active error target
- visible root, LOD-1, LOD-0, and other counts
- required, attached, and pending leaf counts
- download, parse, and process queue activity
- cache used MiB, maximum MiB, and full state

It intentionally excludes asset URLs, filenames, customer paths, query strings,
credentials, and raw exception objects. It is safe to copy into an issue or an
agent prompt.

At the moment the defect appears, collect:

1. a screenshot;
2. one `lodDiagnostics()` snapshot immediately;
3. another snapshot 15 to 30 seconds later without moving the camera;
4. the selected Detail value;
5. whether the status remains `warming`, `streaming`, `full-detail`, or
   `reduced-memory`;
6. browser name/version, viewport, device pixel ratio, and reported
   `navigator.deviceMemory`; and
7. the current Viewer revision from the health response.

Do not paste capability URLs, session URLs, cookies, authorization headers, or
asset request URLs into documentation or agent prompts.

## Fresh-investigation order

A fresh agent should avoid assuming the previous diagnosis is still correct.
Use this order:

1. **Verify deployment revision**
   - Confirm the browser receives revision
     `2d88c70511b01d63bb17e8841c066fb5cb6c6ca7` or a later intended commit.
   - Rule out a stale container or cached frontend.

2. **Capture the exact live symptom**
   - Determine whether the defect is missing geometry, coarse/fine overlap,
     transparent materials, texture delay, clipping, black surfaces, or slow
     but eventually correct replacement.

3. **Capture aggregate runtime state twice**
   - Compare required versus attached leaves, queue state, cache fullness, and
     active versus requested Detail.

4. **Inspect the live hierarchy, not only the 33-tile fixture**
   - Count root, intermediate, and zero-error leaves.
   - Measure decoded bytes for the actual visible replacement frontier.
   - Check bounding volumes, transforms, inherited refinement, and external
     tilesets.

5. **Separate renderer traversal from material defects**
   - If geometry is attached but looks transparent, inspect material opacity,
     alpha map, alpha test, depth write, side, and texture decode state.
   - `preserveLodMaterials()` intentionally retains source transparency and
     alpha behavior. A source material issue can resemble missing LOD.

6. **Check main-thread parse behavior**
   - Very large B3DM/GLB leaves can block input and renderer updates while
     parsing. Queue state can look settled between long tasks.
   - If this is the cause, a deeper conversion hierarchy or smaller leaves may
     be more effective than runtime policy changes.

7. **Check production transport**
   - Look for failed, cancelled, delayed, or incorrectly cached tile and
     embedded texture requests.
   - Compare localhost behavior with the production proxy path.

8. **Change one hypothesis at a time**
   - Add a failing real-browser regression before changing runtime behavior.
   - Re-run close, far, pan, return, and low-memory cases.

## Open hypotheses

These are investigation candidates, not established causes:

- the live model's decoded replacement frontier exceeds the measured fixture;
- production leaves are too large, causing long main-thread parse stalls;
- a live tileset has different depth, transforms, bounding volumes, or inherited
  refinement than the fixture;
- the visual issue is material alpha/depth behavior rather than traversal;
- actual GPU texture memory exceeds the renderer's decoded-byte accounting;
- a proxy/cache/network problem delays or fails child content or embedded
  textures;
- the live deployment is not running the expected image digest;
- current branch-level parent-to-leaf replacement is correct but visually too
  slow, requiring a deeper tiling hierarchy rather than another renderer hack.

## Guardrails

- Make Viewer changes only in this repository unless separately authorized.
- Do not modify Ops, TrueNAS, production configuration, or client assets as part
  of a diagnosis.
- Do not manually toggle cached scene visibility.
- Do not reintroduce root `ADD` without a real A/B test that proves it does not
  overlap descendants.
- Preserve camera source mapping, photo authorization, fixed world scale,
  density selection, and Point Cloud parity.
- Preserve the pinned full-file EPT LAZ-RS worker and legacy COPC worker split.
- Preserve point budget and compressed-node safety limits.
- Preserve narrow CSP rules. Do not add general `unsafe-eval`.
- Do not claim a release fixed the issue until the user confirms the live view.

## Verification commands

Full repository suite with the CI Node version:

```bash
NODE_NO_WARNINGS=1 npx -y -p node@24 -c 'npm test'
```

Real LOD fixture tests:

```bash
CHROME_PATH=/path/to/chrome \
LTDS_LOD_TEST_TILE_ROOT=/path/to/verified/3d-tiles \
npx -y -p node@24 -c \
  'node --test --test-concurrency=1 test/lod-browser-acceptance.test.mjs'
```

Focused all-branch replacement regression:

```bash
CHROME_PATH=/path/to/chrome \
LTDS_LOD_TEST_TILE_ROOT=/path/to/verified/3d-tiles \
npx -y -p node@24 -c \
  'node --test --test-concurrency=1 --test-name-pattern="hides the coarse root when every visible branch" test/lod-browser-acceptance.test.mjs'
```

Dependency audit:

```bash
npm audit --omit=dev --audit-level=high
```

## Acceptance criteria for the next proposed fix

A fresh fix is not complete until:

- the exact current live symptom has a reproducible capture;
- a regression fails before the code change and passes afterward;
- root and refined descendants do not improperly overlap;
- the visible requested frontier eventually settles;
- close, far, pan, and return behavior is verified;
- reduced-memory behavior remains honest and stable;
- Model and Point Cloud camera behavior remains intact;
- the full Node 24 suite and image checks pass;
- an independent reviewer approves the diff; and
- the user confirms the live Viewer is corrected.
