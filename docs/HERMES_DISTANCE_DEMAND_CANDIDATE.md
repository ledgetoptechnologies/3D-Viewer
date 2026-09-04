# Hermes follow-up: medium-distance demand candidate

## Scope and status

Candidate branch: `codex/hermes-medium-demand-evaluation`.
Baseline: `26643bec38765f1af1d447a90afd87bb89fde70d`.
The candidate also contains local photo/camera/navigation commit `c2c2148`;
see `PHOTO_CAMERA_NAVIGATION_QA.md` for those separate changes.
This is not a production release or proof that the Church angles are fixed.
No Operations changes, production imports/retries, asset replacement, or Rome
restoration were performed. Do not modify production for this evaluation.

The supplied `FOCUSED-LOADING-MOTION-EVALUATION.md` is accepted as external
measurement evidence, not rewritten or represented as measurements from this
machine. Its original evidence directory remains on Hermes's host.

## What the report established

- New Church medium view requested 234 of 256 terminal leaves, versus 161 close;
  Rome requested 217 medium versus 159 close. Medium parent SSE around 400 is
  far above the Detail-20 target of 5.481. Small target multipliers would still
  select nearly the entire leaf frontier.
- Downloads were relatively quick in these runs; the parse backlog drained over
  tens of seconds. A parse backlog alone does not distinguish texture-worker
  waiting, decoding, scene construction, or GPU upload. More simultaneous work
  is not yet justified and could worsen initial-motion stutter.
- Both new datasets used real compressed BC7/BPTC textures. Legacy Church's
  decoded shell cost was about four times the new shell cost. URL suffixes are
  not proof of compression.
- Decoded cache reuse worked on repeated views. The primary measured poses did
  not show cache-admission refusal or soft-limit pressure. This does not rule
  out different behavior at the still-unmeasured horizontal facade.
- HTTP `private, no-store` and decoded in-session tile reuse are different
  mechanisms. Authentication/cache headers remain unchanged.
- The old HUD number was JavaScript heap, not tile cache, browser-process memory,
  system RAM, or VRAM. It now explicitly says `JS heap: ... MiB` (or unavailable).

## Implemented candidate

### Default-off distance-demand experiment

Use `lodDistanceDemand=1` on the actual Viewer document URL. Without that exact
query value, selection behavior is unchanged. No preference is persisted.
Do not put the switch after `#`; append it to existing query parameters.
The memory panel labels the enabled experiment.

- Distance is camera-to-bound, not mouse position or screen-center ownership.
  Tight authored bounds are used for rigid/uniformly scaled scenes. Unsupported
  transforms use a conservative enclosing sphere; unknown bounds preserve quality.
- Near distance is 0.25 times the transformed root bounding-sphere radius. Far
  distance is 0.5 times that radius. These are model-relative experimental values,
  not universal metre thresholds and not claimed optimal for large survey sites.
- All nearby surfaces keep raw requested SSE, including two visible walls and
  relevant ancestor paths. Between near and far, smooth interpolation relaxes
  the target to 512 at Detail 20. Other detail levels scale relative to 5.481.
- Detail 24 explicitly restores raw SSE 2 everywhere. Bootstrap and existing
  locked quality cuts remain protected. Requested detail, memory ceilings,
  download/parse/texture-worker counts, retention policy, and strict REPLACE
  hierarchy are not changed. No ADD underlay, forced visibility, or occlusion
  assumption is introduced.
- This intentionally permits coarser medium/far content. Enabling it by default
  requires real near-surface visual proof. Loose bounds or many locked owners can
  still overprotect background branches; report that rather than weakening safety.

### Opt-in stage timing

Use `lodLoadingTiming=1` independently or alongside the experiment. It records
bounded stage events (256 recent records plus aggregates) without asset URLs,
tokens, model paths, raw errors, or retained tile/scene objects.

Available through existing diagnostics:

```js
window.__ltds.lodEvaluation()
window.__ltds.lodLoadingTiming()
window.__ltds.lodOwnerDiagnostics({ maxTiles: 4096 })
```

Timing distinguishes parse queue waiting/execution and texture-worker waiting/
execution. `response-body-ready-at-parse-entry` is a renderer boundary after body
read, not an independent network measurement. `model-ready` is decoded scene
acceptance; `tile-visible` records visibility transitions, including cached
redisplay. These are NOT GPU upload or first-paint measurements. Per-tile KTX
attribution and renderer-construction timing remain unmeasured. Worker IDs and
tile IDs are diagnostic identities, not a mapping between them.

Owner rows include effective target, distance thresholds, and a whitelisted reason
such as `near-surface`, `far-surface`, `locked-quality-cut`, or `unknown-bounds`.
Check `currentFrame` and truncation before aggregating. Use existing scene IDs to
separate disappearance from actual disposal/refetch.

### Baseline test repairs

The two photo failures used obsolete CSS-transform assertions and raced asynchronous
wheel/layout handling. They now wait for painted dimensions, require actual drag
movement, and check bounds. The orthophoto lifecycle fixture advertised a TIFF but
served HTML; it now serves a real georeferenced GeoTIFF with byte-range responses
and waits for a rendered raster. Stage-specific timeouts identify the failing step.
These are harness repairs, not evidence of a newly fixed production raster bug.

## Controlled real-dataset comparison

Use an isolated Viewer build from this candidate. Do not remove security policy,
change Cloudflare/Operations, disable authentication, or alter converter provenance.
The existing loopback test harness can run without Cloudflare. Never reuse production
write credentials or expose copied private assets on a public interface.

Compare the same candidate build with:

1. Baseline: `lodLoadingTiming=1` only.
2. Experiment: `lodLoadingTiming=1&lodDistanceDemand=1`.
3. If instrumentation overhead is material, repeat both with timing disabled.

Keep viewport, DPR, browser/GPU, camera, memory profile, detail, tile/worker limits,
dataset derivative, and network conditions identical. Record actual values, not
machine RAM as a substitute for browser hints. Run at least three repetitions in
alternating order. Separate cold fresh-session runs from decoded-cache-warm returns.

Original report poses (viewer world coordinates; preserve its target/orientation):

| Dataset | Target | Medium camera | Close camera |
| --- | --- | --- | --- |
| New Church | [-3.552127,-18.040829,2.391995] | [-3.552127,25.471018,61.726332] | [-3.552127,-0.636090,26.125730] |
| Rome | [-10.440394,-15.903791,4.232458] | [-10.440394,119.277036,188.569949] | [-10.440394,38.168540,77.967454] |

The report used FOV 60 and aspect 1.407407. Also capture the actual horizontal
Church facade, roof sections, and a two-wall building corner: the earlier close
fixture was roof-dominant and did not resolve those user cases. Do not infer
occlusion or hidden geometry from center/cone overlap alone.

For each pose capture:

- Selected terminal count and target distribution by near/medium/far and protection
  reason; network requests/bytes/errors; decoded cache bytes; JS heap separately.
- Download, parse, and KTX queue depths; queue-wait/execution timing; long tasks and
  frame-time p95 during immediate orbit and the identical orbit after 30 seconds.
- Time until nearby surfaces become sharp; synchronized screenshots of the same
  facade/roof/corner, not just triangle totals or the requested Detail number.
- Tiny pan/orbit transitions, medium-to-close approach, zoom-out then return, and
  Detail-24 override. Track scene identity, attachment, disposal, and refetch.
- Existing quality-owner locks and conservative-bound reasons that still prevent
  medium relaxation. Attribution is necessary before changing those mechanisms.

Accept the distance candidate only if medium leaf demand/bytes/backlog decreases,
nearby detail is no worse, both near walls refine, and gap/coarse-flash/return-cache
behavior does not regress. A smaller queue with damaged foreground is a failure.
If coarse intermediate assets are too poor, report an authored-hierarchy limitation;
do not hide it by disabling REPLACE or making exceptions to derivative validation.

Do not increase concurrency in this comparison. A later independent throughput
experiment requires the new stage evidence and the same frame-time/memory controls.

## Local QA and remaining gates

Completed locally: production frontend build; 193 focused policy, real-traversal,
diagnostics, decoder, cache, regional-fallback, photo, camera, navigation, and runtime
wiring tests; and 9 production-runtime/readiness tests with the repository's serial
test setting. All passed without skips. An initial concurrent run of the latter
had two server-start timeouts; the unchanged suite passed with `--test-concurrency=1`,
as used by `npm test`. That does not establish the cause of the concurrent failure.

Five real Edge browser cases passed without skips: four photo/camera/orthophoto
baseline regressions and one actual-main distance/timing A/B test using real KTX2.
The A/B test asserts both near leaves retain raw detail, at least six background
branches remain coarse, every branch has strict parent-XOR-child cover, cache and
all queue limits match baseline, and real texture-worker timing events are recorded.

Reproduce the new browser test:

```sh
node --test --test-name-pattern="browser opt-in distance demand" test/lod-browser-acceptance.test.mjs
```

For the four baseline cases, set `LTDS_LOD_TEST_TILE_ROOT` to the absolute path of
`test/fixtures/ktx2-tiles` and run:

```sh
node --test --test-name-pattern="browser LOD stream hides the coarse root after complete top-down foreground coverage|browser defaults to orthophoto|browser camera layer preserves|browser camera photo fills" test/lod-browser-acceptance.test.mjs
```

Set `CHROME_PATH` or `EDGE_PATH` if browser discovery cannot find an installed
browser. A skipped browser case is not a passed gate. The KTX fixture is committed;
no production model download is required for these synthetic tests.

Synthetic traversal proves a 26-to-2 terminal-demand reduction while keeping both
near walls raw; it does not prove Church/Rome visual quality or latency.

Full real-dataset A/B results, hardware texture-format readback, the horizontal
facade, and large-site calibration remain Hermes/production-safe testing gates.
Do not call this production-ready solely from synthetic tests. No automatic
re-import is necessary for this runtime experiment. Rome's missing companion
products are a separate explicit restoration action, not performed by these changes.
