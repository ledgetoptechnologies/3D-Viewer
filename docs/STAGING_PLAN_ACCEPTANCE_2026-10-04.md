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
