# LTDS processing platform operations

The processing platform is feature-flagged and off by default. Published Viewer models remain available when NodeODM, ClusterODM, or the durable processing worker is unavailable. Provider health is intentionally excluded from the public Viewer liveness path.

## TrueNAS layout

The production Compose profile publishes only the Nginx gateway on port `8088`. The API and worker share the same pinned application image on a private Compose network. Cloudflared is managed separately by TrueNAS and should route `viewer.ledgetopdroneservices.com` to the gateway.

Host mounts are fixed under `/mnt/Plugins/App_Data/Model-Viewer`: `Data`, `Datasets`, `Models`, `Cache`, `Import/Datasets`, and `Import/Terra`. WebODM media is mounted read-only from `/mnt/Plugins/App_Data/WebODM/Media`. WebODM API discovery is disabled by default and does not require credentials. Release-one WebODM imports are read-only external references; source media is never moved or deleted.

Set `PROCESSING_PLATFORM_ENABLED=true`, configure exact provider origins in `PROCESSING_PROVIDER_ORIGINS`, and map provider IDs to tokens with `PROCESSING_PROVIDER_TOKENS_JSON`. Provider endpoints cannot select arbitrary environment variable names and redirects are rejected. Enable a provider only after its capability probe confirms the required `pc-ept`, `3d-tiles`, and `gltf` options. NodeODM 2.2.3 and ClusterODM 1.5.5 are tested baselines, not hard version lockouts; unknown compatible versions produce a warning.

`LOCAL_DERIVATIVES_ENABLED` remains false in the stock image. The production path requests native EPT, GLB, and 3D Tiles outputs from ODM. If local derivatives are explicitly enabled, worker startup fails unless compatible Entwine and Obj2Tiles executables are present. A 3D Tiles result is publishable only after the existing LOD-v2 audit proves the full-detail frontier; otherwise the self-contained full GLB is retained as the safe fallback.

## Dataset lifecycle

Uploads are chunked, checksum-bound, subject-bound, resumable, and finalized by the durable worker. Import adoption also runs as a durable operation. Both mutations return `202`, an origin-relative `Location`, and `Retry-After: 2`; poll the operation every two seconds. Operation state survives an API restart and leased work is reclaimed after lease expiry. The worker uses separate lanes for dataset operations, ODM processing, derivative work, and callback delivery, so a large copy cannot starve notifications.

Managed and adopted datasets are immutable after finalization. Every file is re-hashed before each ODM submission. External references retain their original location and are also re-hashed. Raw images, GCP files, logs, provider archives, and processing inputs are created unpublished and cannot be selected for a public share.

Deleting a dataset moves Viewer-owned bytes to recoverable trash for 14 days. Restore refuses destination conflicts. External-reference deletion changes Viewer metadata only and never deletes external bytes. Archive/delete refuse datasets with tasks or active finalize/import operations. Permanent purge requires the dedicated `viewer.storage.purge` permission and typed confirmation.

## Backups and recovery

Back up `Data/viewer.sqlite` together with its `-wal` and `-shm` files, or take a SQLite online backup after `PRAGMA wal_checkpoint(PASSIVE)`. Do not copy only the main database while the API or worker is writing. Dataset/model files and the database must be captured in the same storage snapshot when possible.

Before maintenance:

1. Stop new processing admission in Ops and wait for active operations or attempts to settle.
2. Stop the worker, then the API.
3. Run `PRAGMA wal_checkpoint(TRUNCATE)` through a SQLite client or take a TrueNAS atomic snapshot of Data, Datasets, Models, Cache, and Trash.
4. Restart the API and worker. Confirm `/api/v1/health`, `/api/v1/ready`, and the authenticated `/api/v1/processing/ready` response.

Never restore only `Models` without the matching database snapshot: published asset rows contain immutable SHA-256 manifests for every GLB, EPT child, and 3D Tiles child. Serving fails closed when files are missing, added, or modified.

After activation, run `node scripts/production-readiness.mjs --verify-mount-options --require-processing`. This opt-in check is read-only: it verifies all processing mounts, the datasets/trash same-filesystem invariant, configured disk reserve, fresh worker heartbeat, enabled provider capability fingerprints and required native outputs, and absence of stale operation leases. It does not probe, enable, or mutate a provider.

## Logs and callbacks

Processing logs are sanitized, capped per attempt, and retained for a bounded number of days. Client-facing errors never contain credentials, query tokens, absolute server paths, or multiline provider stderr. Terminal callbacks are delivered from a durable outbox with an exact-body HMAC, stable event ID, redirect rejection, bounded responses, and exponential retry. The callback URL must be exactly the configured Ops origin plus `/api/viewer/events` with no credentials, query, or fragment.

See [ODM_PROVIDER_COMPATIBILITY.md](ODM_PROVIDER_COMPATIBILITY.md) for upstream route evidence and option behavior.
