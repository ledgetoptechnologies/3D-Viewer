# Measurement goal completion audit

Audited current checkout `be8e853` on 22 September 2026. The separate new-task/import workflow is planning work and is not evidence of completion for this measurement goal.

| Requirement | Evidence inspected | Conclusion |
| --- | --- | --- |
| Two visible records, orange overflow and responsive navigation | Current measurement-list-layout module and CSS assertions; fresh list/sidebar tests cover 0–2 natural height, 3+ measured two-card overflow, wrapping, keyboard and drag lifecycle | Implemented, focused checks pass; latest deployed layout still needs live acceptance |
| Area immediately, volume explicitly requested | User's later instruction supersedes the original automatic-volume wording. Current finish/inspector tests prove area-only save, no implicit volume, unchanged-result retention and geometry invalidation | Implemented; do not restore automatic volume |
| Honest interactive side section | Current profile/dialog tests and usability QA cover native cells, missing-data gaps, saved base, automatic profile updates, numeric/sliding controls and retained volume | Verified in isolated browser; latest deployment interaction pending |
| Numerical stockpile calculation | County reference validation records exact raster/hash, corrected Delaunay comparison, map/spatial agreement and actual worker IPC result. Usability QA records a larger-than-old-limit raster test | Evidence supports calculation consistency, not field accuracy or the exact missing Polygon 1 outline |
| Permission and lifecycle | Fresh capture/auto-volume tests cover revoked access, stale replies, mode changes, report retirement and explicit server transport | 39 total selected list/sidebar/capture/auto-volume tests passed, zero skips or failures |
| Point-cloud history and navigation | Inspected commits b234083, 9e46fdc, 6e76e32 and prior history; refinement QA records full 10M active/requested budget and changing node density during closer views/orbit | Historical live evidence supports the fixes; not a controlled GPU benchmark or proof for every dataset |
| Current live state | Existing County Road D tab still has export checkboxes, Rename buttons, Reload saved measurements and old screenshot/report placement | This tab is not running the latest UI. It cannot accept be8e853. A stale tab does not prove the server itself is outdated |
| Current point-cloud observation | Same tab shows 8.7M visible points, active/requested 10M, 244 nodes and 144 FPS | Stationary UI observation only; not a new loaded-navigation success claim |
| Release | be8e853 is committed; successful release was verified in preceding task turn, including exact candidate gate and publication as sha-be8e853 | Delivered; no new release created by this audit |
| Preserve Operations and user data | Current worktree has only new planning/audit documents beyond be8e853; this audit made no application, Operations, measurement or source-data edits | Preserved |

## Remaining acceptance

Reopen a current Viewer session after deploying/reloading be8e853. Confirm the new controls, actual PNG/PDF behavior, native profile interaction, and the user's exact large Polygon 1 calculation. Repeat orbit/pan/zoom at unchanged budget if navigation has changed. Do not reduce the point budget and call that verification.

Goal is not marked complete because current live acceptance is unproven. No deployment or refresh that could discard an active draft was performed during this audit.

Follow-up at 22:35:47 UTC: a read-only HEAD request to the public `/api/v1/health` endpoint returned HTTP 200, `Cache-Control: no-store` and `X-LTDS-Viewer-Revision: ff502e5fdd355102070953c6bcc1398c6a226ea4`. The server itself is still on the earlier release, so refreshing the tab alone will not load be8e853. Final deployed acceptance requires the operator to update the container to the verified `sha-be8e853` image. No deployment was attempted by this audit.

## Resumed after deployment

The next health check reported be8e853 and the user confirmed updating. A fresh authorized County Road D session opened with the new controls and all five records. The older cloud tab was switched to Orthophoto to avoid concurrent active 3D renderers.

- Sidebar End key resized it to 611 px in the current viewport. Saved-list client height was 339 px, scroll height 908 px, first card heights 182.984375 and 143.984375 px, with orange `rgb(238, 80, 7)` scrollbar and transparent track.
- QA feed-pile saved volume remained 78,542.712 ft³. Its native cross-section loaded automatically with 2,293 crossed cells and reviewed-source-provenance. No volume recalculation was requested for this record.
- Model report opened with a measured-view image and all five saved rows, including Polygon 1's 11 edge lengths. Native PDF output has not been independently inspected. Quick image/JSON export actions were exercised, but no new file appeared in the user's Downloads directory; do not substitute an initiated browser download for verified delivery.
- Exact Polygon 1 (26,122.202 ft²) was explicitly submitted for calculation and still failed with the generic calculation-limit message. Saved geometry is intact. The supplied prior JSON does not contain its vertices; requested a new export from the user.
- Live regressions identified: renderPanel wrongly exposes Retry after successful loading; current-result recognition expects `calculated` although persisted successful server results use `complete`. Both have focused fixes in progress.
- A deterministic concave raster reproduction exposes a second capacity guard: global cell-count multiplied by all clipped reference patches can exceed the work ceiling even though most patch/cell pairs cannot overlap. Exact spatial culling with conservative resource accounting is being implemented and numerically checked; no global safety limits are being removed.
- Map-authored record placement in 3D still reports missing height units while the verified source can calculate native profiles. The placement path is being audited separately without introducing a guessed unit override.

Completion remains unproven because these newly observed failures require fixes and verification.

## Follow-up fixes and export audit

The user supplied `measurements (1).csv`. Read-only inspection found all five records, including Polygon 1, but the CSV contains summary quantities and provenance, not vertex coordinates. Polygon 1 is geometry-only with no saved volume. A JSON export is still required to reproduce that exact outline; its CSV area is not sufficient to reconstruct geometry.

The local follow-up now fixes failed-load retry visibility and recognizes persisted `complete` surface results as current when their job, version, quantities and invalidation checks pass. A fresh combined run of display-elevation, overlay, volume-dialog and spatial-culling tests passed 52/52 without skips.

Native raster calculations now cull reference patches by conservative spatial bounds while keeping exact fractional-cell integration and the existing cell/work limits. A deterministic concave outline on the actual County DSM completed with 30,329,750 bounding cells and 34 patches in 6.89 seconds, approximately 294.5 MB end RSS. The former global cell-by-all-patches estimate was 1,031,211,500 and rejected it. This is a reproduction of the failure class, not the missing exact Polygon 1.

Map-to-3D placement now receives exact authorized reviewed-source evidence from the same registry as calculation. Explicit conflicting units and mismatched source identities are rejected. Large outlines read deduplicated vertex cells instead of a full bounding rectangle. The actual County raster returned 12 native vertex samples in 41 ms, without altering saved geometry.

The requested measurement UI batch has a read-only code/test checklist covering sidebar resizing, two-card overflow, automatic saved loading, floating image capture, separate report, centered volume labels, current/stale result actions, inline rename, visibility/edit controls, vertex insertion/deletion, export-all, accepted-job notice, help text, automatic profiles, numeric/reset controls and staff-only settings below ordinary output. These are implemented; local tests do not replace deployment acceptance. Native download/PDF delivery remains unverified in the user's browser.

The separate new-task/raw-import workflow remains planning-only in `NEW_TASK_WORKFLOW_PLAN_2026-09-22.md`. No raw processing job was launched and no Operations code was edited.

The original exact 12-vertex WebODM reference was rerun with spatial culling against the supplied DSM. At 128-cell windows its net result was 5,647.2716911718235 m³ (identical to the prior baseline), taking 7.69 seconds. At 512-cell windows it was 5,647.271691175985 m³, differing by 4.16e-9 m³ and taking 4.89 seconds. Both visited 22,226,061 bounding cells, counted 20,969,439 valid samples and budgeted 49,097,148 candidate patch visits. This confirms retained reference numerics, not the exact Polygon 1 or field accuracy.

Fresh combined Linux build-stage verification passed Vite and 1,542 source tests (1,572 total, zero failures, 30 skips). Skips were 27 browser-dependent checks, two native Poisson checks and one host-bind lifecycle check. This is source/build verification; exact production-container release verification is a separate gate. No new point-budget reduction or point-cloud renderer change is included in this follow-up.
