# Viewer LOD and camera fix handoff

## Status

**Root causes reproduced and fixed locally as of 2026-08-28; production remains
unconfirmed until the user tests the merged deployment.**

Production inspection on 2026-08-28 found that the hierarchy itself was
working, but the startup policy requested Detail 24 and immediately staged
through Detail 13. A cold default view consequently fetched the root and 240 of
241 LOD-0 payloads within 20 seconds; forcing Detail 2 before startup stabilized
at 29 payloads (root, 12 LOD-2, and 16 LOD-1) with no LOD-0 requests in that
measured pose. The runtime now starts with requested and active Detail 2. It
does not raise either value until the user moves the slider, after which the
Detail-13 staging and memory governor apply. Standard SSE traversal can still
select a fine tile for an unusually close incoming camera.

The released runtime passed its original repository and B3DM fixture gates, but
the user subsequently reported incomplete, transparent, or dark foreground
geometry at ground-level and oblique camera poses. A real Chromium reproduction
then showed the LOD phase stuck at `warmup`, with active Detail 13 of a requested
24, while distant tiles continued to load.

Two independent blockers were reproduced. First, a camera inside a terminal
leaf's bounding volume produces distance zero and infinite screen-space error;
the warmup gate incorrectly treated that zero-error leaf as refinable and
unsatisfied forever. Second, the renderer's LRU fullness check includes entry
count as well as decoded bytes. The old 48-entry desktop limit and 24-entry
reduced limit could fill with visible tiles and retained `REPLACE` parents, so
new downloads were refused even while the byte budget still had room.

The fix makes a visible terminal zero-error leaf satisfy warmup even at infinite
screen-space error, raises item-count headroom without changing byte ceilings,
and adds a non-oscillating memory-pressure governor. These changes have targeted
policy/runtime tests and real-browser reproductions. One long-running browser
acceptance case still needs a capable-host run before merge because it times out
identically on the changed and unchanged trees with the current Linux host's
snap Chromium. Treat the user's live report as authoritative: local evidence is
not a production confirmation, and the issue must not be called resolved in
the deployed Viewer until the user verifies it.

### Gap-free staged refinement update

The user's next production test exposed a separate transition failure: the
Detail-2 overview was coherent, but a high-detail request could take a long
time to replace the focused church facade, and zooming back out left large
black holes. A live browser capture showed Detail 24 requesting a large LOD-0
frontier, then dropping through memory-limited detail levels while required
content remained absent. Returning to Detail 2 restored full coverage.

The failure matches the hard cache-admission livelock documented upstream in
[`3d-tiles-renderer` issue #1689](https://github.com/NASA-AMMOS/3DTilesRendererJS/issues/1689):
when the demanded used set fills the cache, no unused entry can be evicted, new
downloads are refused, and the queues can become idle with refinement
unfinished. The previous application governor detected only terminal LOD-0
leaves, waited three samples, and stepped down one Detail at a time. It could
therefore react late and visibly discard an incomplete frontier.

This update:

- enables standard `REPLACE` ancestor fallback so a ready coarse branch remains
  visible until its selected children are content-ready;
- exact-pins `3d-tiles-renderer` 0.5.1 and applies a fail-closed postinstall
  patch that separates ancestor fallback from off-frustum sibling preload;
- stages high-detail requests as `13 → 16 → 19 → 22 → requested`, advancing
  only after the current visible frontier and all queues settle;
- treats any selected in-frustum renderable tile—not only a terminal LOD-0
  leaf—as pending starvation work;
- on the first full-cache/idle-queue sample, returns directly to the last fully
  settled stage and records the failed stage as a non-oscillating ceiling; and
- exposes both selected-tile and terminal-leaf aggregate counts in sanitized
  LOD diagnostics.

The stretched brick pattern in the supplied close facade screenshot is not yet
proven to be a converter defect. A stalled intermediate tile can present the
same visual symptom. The schema-v3 audit proves UV presence and bounded spatial
equivalence, but it does not prove pixel-level equivalence after Obj2Tiles atlas
repacking. Do not enable Obj2Tiles `--keeptextures` as a speculative fix: the
documented representative run exceeded 157 GiB. First deploy this runtime fix
and compare the same facade only after diagnostics show a settled Detail-24
LOD-0 frontier. If distortion remains then, add a focused source-GLB versus
LOD-0 texture/UV audit rather than weakening the current production proof.

## Released runtime baseline

The pre-fix released behavior was introduced by the following runtime commit.
Documentation-only descendants may carry a later source revision and mutable
`latest` digest without changing that Viewer runtime behavior.

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

The fix is based on documentation commit
`718d7c486b18df1bd2f5a025f02312256de99aaf`, whose runtime is unchanged from
`2d88c70511b01d63bb17e8841c066fb5cb6c6ca7`. Before production verification,
confirm the browser receives a revision containing the fix. The Viewer reads
`x-ltds-viewer-revision` from `/api/v1/health` and stores it in
`VIEWER_BUILD_REVISION`. A stale deployment, stale container, or cached frontend
must still be ruled out.

## Relevant source map

### LOD runtime

- `lod-policy.mjs`
  - Detail-to-screen-space-error mapping
  - desktop and low-memory cache profiles
  - queue priority
  - Detail 13 warmup policy
  - terminal zero-error leaf convergence at infinite screen-space error
  - sustained-starvation detection and memory-pressure resolution
  - slider transition policy
  - safe aggregate diagnostics
- `main.js`
  - `loadTiles()` renderer setup and event wiring
  - `maybeAdvanceLodWarmup()` runtime transition
  - one-hertz memory-pressure governor
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

- `loadAncestors = true`
- `loadSiblings = false`
- `loadAncestorSiblings = false` (LTDS exact-version patch)
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

Desktop/default startup uses Detail 2 as both the requested and active detail.
It is a settled requested-detail phase, not an unfinished warmup. Low-memory
clients report the separate `reduced-memory` phase. No higher requested or
active Detail is set until the user moves the slider upward.

### Desktop warmup

A desktop request above Detail 13 starts at Detail 13. The runtime advances by
three Detail units at a time, capped at the request, only when:

1. the current visible frontier satisfies the active error target;
2. the download queue is settled;
3. the parse queue is settled; and
4. the process-node queue is settled.

When the camera is inside a leaf bounding volume, `3d-tiles-renderer` can report
distance zero and infinite screen-space error. A visible terminal tile with
`geometricError: 0` now satisfies the first condition because it cannot refine
further. Infinite error still blocks advancement for a non-terminal or
non-zero-error tile.

Lowering Detail below 13 clears warmup completion. A later increase must stage
through Detail 13 again. This prevents the `24 -> 2 -> 24` slider sequence from
bypassing the warmup.

### Memory profiles

Desktop/default profile:

- minimum warm bytes: `0.4 GiB`
- maximum decoded bytes: `3 GiB`
- minimum entries: 24
- maximum entries: 1,024
- unload percentage: 20 percent

Clients reporting `navigator.deviceMemory <= 4`:

- maximum Detail: 13
- minimum warm bytes: `384 MiB`
- maximum decoded bytes: `768 MiB`
- minimum entries: 24
- maximum entries: 512
- unload percentage: 20 percent

The reduced profile is deliberately honest. It does not claim that Detail 24
will eventually load inside a cache too small for the measured frontier.
The decoded-byte limits are unchanged and remain the actual memory guards. The
higher item ceilings prevent the renderer's count-based `isFull()` condition
from refusing downloads merely because the visible frontier and retained
`REPLACE` parents contain more than the old entry limits.

### Memory pressure

The runtime samples aggregate LOD state once per second. A sample is classified
as starvation when the cache is full, a selected in-frustum renderable tile is
still pending, and renderer work queues cannot make progress. The governor then
restores the last fully settled detail stage and records the failed detail as a
ceiling.

That ceiling prevents automatic recover/starve oscillation: later recovery may
continue at or below the ceiling, but it cannot silently restore a detail level
already shown to starve. `starvedAtDetail` is nullable and must be checked
explicitly rather than passed through `Number()`. Moving the Detail slider is an
explicit new request and clears the ceiling. Starvation counters and ceilings
also reset during tile disposal and loading. The last-settled frontier resets
with the tile lifecycle; a slider increase retains it and a decrease bounds it
to the lower active request. Whenever the governor holds active detail below
the user's request, the status bar reports `memory-limited` instead of
`full-detail`.

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

### Current ground-warmup and starvation fix

The new real-browser reproductions established both causes rather than inferring
them from screenshots:

1. At a ground-level camera pose inside a terminal leaf bounding volume,
   `3d-tiles-renderer` reported distance zero and infinite screen-space error.
   `visibleLodTargetSatisfied()` rejected every non-finite error, so the visible
   zero-error leaf held desktop warmup at Detail 13 of 24 forever.
2. The live model used 38 to 46 visible entries before retained `REPLACE`
   parents were counted. `lruCache.isFull()` therefore tripped the 48-item
   desktop cap or 24-item reduced cap independently of decoded bytes, and used
   tiles could not be evicted to admit the pending downloads.

The fix:

- treats only a visible terminal `geometricError: 0` tile as satisfied at
  infinite screen-space error; coarse or refinable infinite-error tiles still
  block;
- raises item-count capacity to 1,024 desktop and 512 reduced, with a minimum of
  24 for both profiles, while preserving the existing decoded-byte limits and
  20-percent eviction setting;
- detects sustained cache starvation at one hertz and steps active detail down;
- records `starvedAtDetail` as a ceiling so automatic recovery cannot oscillate
  back into the same starving request;
- clears that ceiling only for an explicit Detail-slider request or tile
  lifecycle reset; and
- reports `memory-limited` whenever the ceiling holds active detail below the
  request.

## Measurements and test evidence

The real local test fixture contains 33 B3DM tiles.

Measured decoded working sets:

- root plus 12 close LOD-0 leaves: `2,482,109,023` bytes, about 2.31 GiB
- sustained all-16-leaf frontier: about `2,713,539,801` bytes, about 2.53 GiB
- measured branch-replacement transition peak: about 2.784 GiB

The 1.75 GiB cache reproducibly became full and prevented three required leaves
from entering the download queue. The 2.75 GiB and 3 GiB profiles could complete
the measured fixture frontier.

The released baseline's sustained test pose is encoded in
`test/lod-browser-acceptance.test.mjs`. The final real fixture regression:

- loaded all required foreground branches;
- detached the coarse root after full replacement coverage;
- moved far enough to drain detailed content;
- returned to the original view; and
- restored all required leaves.

That test completed successfully in about 490 seconds.

Released baseline evidence:

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

Current fix evidence:

- before the warmup fix, the ground-camera Chromium reproduction remained at
  Detail 13 of 24 with dark or transparent near-field geometry;
- after the fix, the same pose reached Detail 24 of 24 with all 16 zero-error
  leaves attached;
- forced byte-cap and item-cap reproductions now make the governor step detail
  down and report the result honestly instead of wedging or oscillating;
- the final targeted policy, runtime-wiring, and material suites passed 37 of
  37 tests; and
- the post-final-change Node 24 build and complete suite executed 484 tests:
  478 passed, none failed or were cancelled, and 6 environment-dependent tests
  skipped on Windows. The skipped set includes the three real-tile LOD cases
  because this worktree does not have the verified tile fixture.

The long-running acceptance test named `hides the coarse root after complete
top-down foreground coverage` still needs one run on a capable host. On the
current Linux host, snap Chromium stalls in a CDP `Runtime.evaluate` call and
the test times out after roughly 135 seconds. The unchanged baseline fails in
the same way, while the case historically completed on the Windows host in
about 490 seconds. Do not classify the Linux result as a regression, but do not
waive the capable-host check before merge.

### Limits of that evidence

The browser reproductions use a local verified fixture and local HTTP transport.
They establish the warmup and item-count failures and exercise the governor, but
do not reproduce every production model, proxy path, GPU, browser, viewport,
network condition, decoded texture footprint, or cache history. Passing local
fixtures cannot confirm a live deployment on a different hierarchy or client.

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

4. **Another decoded-byte increase without measuring the live model**
   - The current item-cap increase addresses a separately reproduced count
     failure and leaves the measured byte ceilings unchanged. Do not increase
     decoded-byte limits again without new working-set evidence.

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

- phase: `warmup`, `requested-detail`, `reduced-memory`, or `memory-limited`
- requested, active, and maximum Detail
- active error target
- visible root, LOD-1, LOD-0, and other counts
- required, attached, and pending selected-tile and terminal-leaf counts
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
5. whether the status remains `warming`, `streaming`, `full-detail`,
   `reduced-memory`, or `memory-limited`;
6. browser name/version, viewport, device pixel ratio, and reported
   `navigator.deviceMemory`; and
7. the current Viewer revision from the health response.

Do not paste capability URLs, session URLs, cookies, authorization headers, or
asset request URLs into documentation or agent prompts.

## Remaining verification order

The local diagnosis is complete. Finish verification without reopening rejected
renderer-state approaches:

1. Review the complete fix diff against `718d7c4`, including tests and these
   documentation updates.
2. Run the targeted policy, runtime-wiring, and material tests.
3. Run the complete suite under Node 24 after the final non-oscillation and
   status-label changes; reconcile environment-dependent skips with the host.
4. Run `hides the coarse root after complete top-down foreground coverage` once
   on a capable host, without running the full suite concurrently.
5. Optionally rerun the ground-camera and forced-starvation Chromium harnesses
   from their temporary directory. Do not commit harness files, screenshots, or
   other temporary artifacts.
6. After merge and deployment, verify the health revision, repeat the affected
   ground/oblique view, and obtain user confirmation before calling the live
   issue resolved.

## Remaining production risks

The reproduced root causes are established locally. If the corrected build
still differs in production, investigate these separately rather than undoing
the fixes:

- the live model's decoded replacement frontier exceeds the measured fixture;
- production leaves are too large, causing long main-thread parse stalls;
- a live tileset has different depth, transforms, bounding volumes, or inherited
  refinement than the fixture;
- the visual issue is material alpha/depth behavior rather than traversal;
- actual GPU texture memory exceeds the renderer's decoded-byte accounting;
- a proxy/cache/network problem delays or fails child content or embedded
  textures;
- the live deployment is not running the intended fixed image digest;
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

Targeted policy/runtime suites:

```bash
node --test test/lod-policy.test.mjs test/viewer-runtime-wiring.test.js test/lod-materials.test.mjs
```

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

Focused top-down foreground-coverage regression:

```bash
CHROME_PATH=/path/to/chrome \
LTDS_LOD_TEST_TILE_ROOT=/path/to/verified/3d-tiles \
npx -y -p node@24 -c \
  'node --test --test-concurrency=1 --test-name-pattern="hides the coarse root after complete top-down foreground coverage" test/lod-browser-acceptance.test.mjs'
```

Run this browser case on the capable Windows host before merge. Do not run it
concurrently with the full suite: both are memory-intensive and contention can
produce false CDP timeouts. The known snap-Chromium timeout on the current Linux
host occurs unchanged on the baseline and is not sufficient to pass or fail the
fix.

Dependency audit:

```bash
npm audit --omit=dev --audit-level=high
```

## Acceptance criteria for this fix

The fix is not complete until:

- the ground-level warmup stall is reproduced before the code change and clears
  afterward;
- zero-error terminal leaves satisfy warmup at infinite screen-space error while
  coarse infinite-error tiles still block;
- item caps and byte budgets match the documented desktop and reduced profiles;
- forced starvation steps detail down, remains below its starvation ceiling
  without oscillation, reports `memory-limited`, and resets only on the defined
  lifecycle or manual-slider paths;
- root and refined descendants do not improperly overlap;
- the visible requested frontier eventually settles;
- close, far, pan, and return behavior is verified;
- reduced-memory behavior remains honest and stable;
- Model and Point Cloud camera behavior remains intact;
- targeted tests and the post-final-change Node 24 suite pass;
- the top-down foreground-coverage regression passes on a capable host;
- image checks pass;
- an independent reviewer approves the diff; and
- the user confirms the live Viewer is corrected.
