# Approved processing and staging implementation — 2026-10-04

This record covers the current candidate. It does not close the active goal.

## Implemented candidate behavior

- Provider-led scheduling without a Viewer outstanding-job cap; one transactional submit lease per provider.
- Schema 40 durable sequence with deterministic legacy backfill and insertion trigger.
- Accepted queued/running/terminal tasks are reconciled without deletion or repeat uploads.
- Temporary capacity, availability and credential rejection have distinct behavior; waiting files remain retained.
- Uncertain temporary upload responses remain `provider_submission_ambiguous` because upstream task-info cannot enumerate staged files. This can require operator recovery; repeating an uncertain upload would rename duplicate filenames upstream.
- Provider UI has HTTP/HTTPS guidance and no admission-limit control; obsolete API mutations are rejected explicitly.
- Prepared staging policy pins proxy/API/worker edge IPs, scopes cluster connectivity and rejects rebuilding policy while the stack runs. Existing service preflights are preserved.

## Evidence so far

- Browser launch through signed-in Operations staging opened the Viewer workspace successfully.
- Local browser/UI/formatter/firewall suite: 55 passed, no failures or skips.
- Focused local dispatch/recovery/provider suite: 44 passed, one Windows symlink skip; additional dispatch/recovery coverage was added afterward.
- Isolated Linux candidate tests: 55 passed covering migration, storage, dispatch and recovery. The two shell guard tests initially required an executable mock-command tmpfs; rerun with that isolated test setting passed 2/2.
- Build passed. Linux-only `/proc` storage checks cannot run on the Windows host; this is not a deployed storage failure.
- Final focused dispatch/recovery/provider/firewall/release-policy run: 50 passed, no failures or skips.
- Read-only SSH verified installed ClusterODX 1.5.9, source revision `818f50bbbfcab107c41fcf4a7101e2bfcbce87e5`. Its actual `/info` source reports placeholder queue count zero and applies configured per-token concurrency gates at submission. The queue TODO exists in the installed source as well as upstream.
- Hermes confirmed no active import work and no overlapping Viewer configuration changes; coordination message acknowledged. Exact maintenance digest will be sent before restart.
- Corrected candidate revision `334572423fa4edc6ec4850fd97fd383cd4c18c10` passed CI run `37241032482`: 2,163 passed, zero failed, 15 skipped. Exact-image runtime checks passed 138/138 with no skips. The checksum-verified attestation binds schema 40 and immutable digest `sha256:216133ba57e5f0ee879dbf0676a084109d3bbf1f1799a861970fed7be3f48c97`. Staging pulled that digest and image inspection confirms the revision and runtime user `568:568`. No deployment yet.
- Staging workspace remains accessible in the signed-in browser; API/worker/proxy remain healthy on the existing image.
- The approved archive yielded exactly 15 M4E photos captured one second apart, 07:48:49–07:49:03 on 2026-08-22, totaling 95,023,104 bytes. Staging fixture: `/mnt/ViewerStaging/cache/approved-processing-sample-20261004`. Its `sample-receipt.json` records original ZIP names and each SHA-256; first/middle/last images visually overlap the same building. No job submitted. This oblique sample is not DTM coverage or large-model LOD acceptance.
- Independent review found and corrected duplicate-basename overwrite risk in the sample helper. Isolated Python tests on staging passed 5/5, covering counts 10–15, exact hashes/receipts, duplicate/case collisions, byte limits and malformed/both-endian EXIF.
- Fresh consistent backup `/home/bkoltz/3d-viewer-staging/backups/pre-provider-rollout-20261004T225317Z` passed integrity at schema 39. It contains database/configuration/TLS/guard files and service/firewall/mount/runtime evidence, root-private (directory 0700, files 0600); active dataset/processing/derivative/upload/measurement gates were empty. Do not restore its old proxy secret after rotation.
- Deployment review retained the stopped-stack rebuild gate and added proxy host-local NEW/INVALID/UNTRACKED rejection, preserving replies to host-initiated health checks. Updated shell guard tests pass 2/2 locally; the reviewed installed unit still has the existing NAS preflight and Docker/mount ordering. No drop-in or firewall change has been installed yet.

## Deployment gates still open

The first candidate (`884537e`, CI run `37240119477`) failed its Linux test gate: 2,162 passed, one legacy transfer-provenance fixture failed, 15 skipped. No image was published or deployed. The fixture now models accepted tasks separately from temporary initialization; recovery acknowledges the second initialization reply but retains generation-two ambiguity and cannot acquire trusted producer provenance. Focused receipt/recovery/firewall tests pass 23/23 after the correction. Full Linux CI remains required.

- Exact candidate Linux CI/runtime verification and immutable dev image publication.
- Fresh backup, paired proxy-secret rotation, supervised recreation and restrictive network acceptance.
- Fresh authenticated provider probe and approved 10–15-photo round trip.
- Known-value raster/volume checks and representative live mesh/cloud/DSM/DTM acceptance.
- Production deployment is outside this acceptance.

## Recovery constraints

Schema 40 is additive and older schema-39 SQL remains compatible. The older worker has unsafe ambiguous-submission behavior: after tests create processing jobs, image rollback must hold processing workers until interrupted submissions are reconciled. Never restore the exposed old proxy secret. Never restore the database merely to reverse an image/network change.

Keep revision, immutable digest, CI receipt and live screenshots/results here as each gate passes. Missing representative assets remain explicit gaps.
