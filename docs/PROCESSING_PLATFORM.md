# LTDS processing platform operations

The processing platform is feature-flagged and off by default. Published Viewer models remain available when NodeODM, ClusterODM, or the durable processing worker is unavailable. Provider health is intentionally excluded from the public Viewer liveness path.

## TrueNAS layout

Production Compose publishes `viewer-api` directly on the configured LAN bind address and port `8088`; it does not run Nginx. The worker shares the pinned application image but has no published port. Cloudflared and external Nginx are separately managed. Nginx forwards the exact Viewer host; optional proxy-secret/IP enforcement can be enabled later as a coordinated hardening step. The application itself streams authorized byte ranges because `X_ACCEL_REDIRECT_PREFIX` is empty.

Runtime settings and secrets live only in the host path
`/mnt/Plugins/App_Data/Model-Viewer/Config/viewer.env` (directory mode `700`,
file mode `600`) and are shared by API and worker through Compose `env_file`.
All managed application bytes live in the fixed Docker volume
`ltds-viewer-storage`, mounted at `/app/storage`. Docker creates the volume on
first deployment and copies the image's pre-owned directory skeleton into it,
so no host-path `chown` or privileged bootstrap is needed. The API and worker
run as the TrueNAS Apps service identity `568:568`, with all capabilities
dropped. The one volume keeps `datasets`, `models`, and `trash` on the same
filesystem for journaled atomic renames. Preserve and back up the volume across
image updates or app/project renames.

Run `scripts/truenas-storage.sh diagnose` after first boot. It launches the
pinned Viewer image as UID/GID 568, verifies each managed directory, and makes
and removes a bounded write marker. A volume created or populated before the
rootless layout may retain incompatible ownership because Docker copy-up runs
only for an empty volume. With processing admission stopped, the explicit
`repair-ownership CONFIRM_UID_568` command stops the services, repairs only the
fixed `ltds-viewer-storage` volume, and restarts the services that were running.

WebODM media is mounted read-only from
`/mnt/Plugins/App_Data/WebODM/Media`; legacy derivatives are also read-only.
WebODM API discovery is disabled by default and does not require credentials.
Release-one WebODM imports are external references; source media is never
moved or deleted.

Set `PROCESSING_PLATFORM_ENABLED=true`, generate the one-time
`PROVIDER_CREDENTIALS_KEY`, and configure the exact origins and/or private LAN
boundary in `PROCESSING_PROVIDER_ORIGINS` and
`PROCESSING_PROVIDER_ALLOWED_CIDRS`. Start with `docker compose --env-file
/mnt/Plugins/App_Data/Model-Viewer/Config/viewer.env --profile processing up
-d`; both API and worker must read the true flag from that file. Thereafter an
administrator creates nodes, stores or rotates tokens, probes, and enables them
in Ops without editing the environment or restarting containers. Provider
credentials are encrypted at rest and are never returned. Enable a provider
only after its capability probe confirms the required `pc-ept`, `3d-tiles`,
and `gltf` options. NodeODM 2.2.3 and ClusterODM 1.5.5 are tested baselines,
not hard version lockouts; unknown compatible versions produce a warning.

`scripts/update-truenas.sh . auto` derives the Compose profile from
`PROCESSING_PLATFORM_ENABLED`; explicit `processing` or `view-only` modes must
match it. The helper accepts only a CI `sha-<commit>` image or `@sha256` digest,
refuses active processing/dataset/storage work by default, preserves the prior
image under `ltds-viewer-rollback:previous`, waits for health, and runs the
read-only production readiness check. `VIEWER_UPDATE_ALLOW_ACTIVE=1` is an
emergency override: interrupted work remains lease/journal recoverable, but the
normal update path must drain first. Compose grants two minutes after SIGTERM;
do not force-kill a worker merely because a large operation has not exited yet.

`LOCAL_DERIVATIVES_ENABLED` remains false in the stock image. The production path requests native EPT, GLB, and 3D Tiles outputs from ODM. If local derivatives are explicitly enabled, worker startup fails unless compatible Entwine and Obj2Tiles executables are present. A 3D Tiles result is publishable only after the existing LOD-v2 audit proves the full-detail frontier; otherwise the self-contained full GLB is retained as the safe fallback.

## Dataset lifecycle

Uploads are chunked, checksum-bound, subject-bound, resumable, and finalized by the durable worker. Import adoption also runs as a durable operation. Both mutations return `202`, an origin-relative `Location`, and `Retry-After: 2`; poll the operation every two seconds. Operation state survives an API restart and leased work is reclaimed after lease expiry. The worker uses separate lanes for dataset operations, ODM processing, derivative work, and callback delivery, so a large copy cannot starve notifications.

Managed and adopted datasets are immutable after finalization. Every file is re-hashed before each ODM submission. External references retain their original location and are also re-hashed. Raw images, GCP files, logs, provider archives, and processing inputs are created unpublished and cannot be selected for a public share.

Friendly project and dataset names, descriptions, tags, and arbitrary bounded
catalog metadata remain editable. Dataset reassociation changes only the stable
project ID association; it never moves files or changes a manifest. It is
rejected while the dataset has an active operation, lifecycle mutation, or
non-archived processing task, and duplicate names in the target project fail
closed.

ODM submission persists initialization, photo-upload, auxiliary-upload, and
commit phases. A restart resumes photo batches from the provider's documented
image count. Auxiliary inputs such as GCP text cannot be inferred from that
count, so an ambiguous auxiliary response removes the assigned upstream task
and deterministically restarts it instead of risking a duplicate or missing
input. Commit ambiguity is reconciled from provider state. Before any provider
side effect, admission verifies the immutable source hashes and combines the
peak Dataset, Cache, and Model requirements for mounts that share one storage
pool.

Deleting a dataset moves Viewer-owned bytes to recoverable trash for 14 days. Trash, restore, manual purge, and retention purge use a durable two-phase journal: the database records intent before any rename/delete, the worker applies an idempotent filesystem effect, and a single database transaction finalizes metadata afterward. Startup and hourly maintenance reconcile interrupted intents, including a move that completed before its journal update. A source/destination conflict fails closed and makes processing readiness fail until an operator removes the conflicting path and retries the failed mutation through `POST /api/v1/storage/mutations/:id/retry`; failed mutations can be inspected with the bounded `GET /api/v1/storage/mutations?status=failed` route.

External-reference deletion changes Viewer metadata only and never creates a byte-mutation journal, moves, or deletes external bytes. Archive/delete refuse datasets with tasks or active finalize/import/lifecycle operations. Permanent purge requires the dedicated `viewer.storage.purge` permission and typed confirmation. Empty draft datasets use a metadata-only journal entry and remain restorable during the retention window.

Managed model outputs have the same 14-day recoverable lifecycle. The bounded
output catalog and project/task storage routes report actual ingested output
bytes separately from immutable dataset bytes. Archiving first unpublishes the
selected version and is rejected while a live share/session or processing job
still depends on it. Trash, restore, manual purge, and retention purge reuse
the two-phase storage journal; permanent purge removes asset rows and bytes but
retains the zero-byte output record as an audit tombstone.

Catalog and accounting routes used by Ops are:

- `PATCH /api/v1/projects/:id` and `PATCH /api/v1/datasets/:id`
- `GET /api/v1/projects/:id/storage` and `GET /api/v1/tasks/:id/storage`
- `GET /api/v1/processing/outputs`
- `POST /api/v1/processing/outputs/:id/archive` and
  `DELETE /api/v1/processing/outputs/:id`
- `POST /api/v1/storage/trash/:id/restore` and
  `DELETE /api/v1/storage/trash/:id` with typed confirmation for purge

All list routes use capped keyset pagination, and every mutation requires an
admin bearer permission plus `Idempotency-Key`.

## Backups and recovery

Back up `Config/viewer.env` through a secret-capable backup path together with
the entire `ltds-viewer-storage` Docker volume, or take a SQLite online backup
of `/app/storage/data/viewer.sqlite` after `PRAGMA wal_checkpoint(PASSIVE)` and
then capture the matching managed bytes. Never put the populated environment
file in source control or ordinary logs. Do not copy only the main database
while the API or worker is writing. Dataset/model files and the database must
be captured as one consistent backup.

The supported named-volume backup path stops API and worker before archiving so
the SQLite WAL and managed bytes form one snapshot, writes a SHA-256 sidecar,
then restores only the services that were previously running:

```bash
mkdir -p /mnt/Plugins/App_Data/Model-Viewer/Backups
VIEWER_ENV_FILE=/mnt/Plugins/App_Data/Model-Viewer/Config/viewer.env \
  scripts/truenas-storage.sh backup \
  /mnt/Plugins/App_Data/Model-Viewer/Backups/viewer-$(date -u +%Y%m%dT%H%M%SZ).tar.gz
```

Test restoration on a non-production copy first. Production restore verifies
the sidecar and archive paths, stops services, replaces only the exact named
volume contents, restores ownership to 568, and restarts prior services:

```bash
VIEWER_ENV_FILE=/mnt/Plugins/App_Data/Model-Viewer/Config/viewer.env \
  scripts/truenas-storage.sh restore \
  /mnt/Plugins/App_Data/Model-Viewer/Backups/viewer-TIMESTAMP.tar.gz \
  CONFIRM_RESTORE
```

If extraction fails, services remain stopped for inspection. Never restore a
volume archive from an untrusted source.

Before maintenance:

1. Stop new processing admission in Ops and wait for active operations or attempts to settle.
2. Stop the worker, then the API.
3. Run `PRAGMA wal_checkpoint(TRUNCATE)` through a SQLite client, then back up
   the complete `ltds-viewer-storage` volume before either service restarts.
4. Restart the API and worker. Confirm `/api/v1/health`, `/api/v1/ready`, and the authenticated `/api/v1/processing/ready` response. Processing readiness reports pending and failed lifecycle journal rows; do not resume admission while a failed row remains.

Never restore only `models` without the matching database snapshot: published asset rows contain immutable SHA-256 manifests for every GLB, EPT child, and 3D Tiles child. Serving fails closed when files are missing, added, or modified.

After activation, run `node scripts/production-readiness.mjs --verify-mount-options --require-processing`. This opt-in check is read-only: it verifies all processing mounts, the datasets/trash same-filesystem invariant, configured disk reserve, fresh worker heartbeat, enabled provider credential decryption, capability fingerprints and required native outputs, and absence of stale operation leases. It does not probe, enable, or mutate a provider.

## Logs and callbacks

Processing logs are sanitized, capped per attempt, and retained for a bounded number of days. Client-facing errors never contain credentials, query tokens, absolute server paths, or multiline provider stderr. Terminal callbacks are delivered from a durable outbox with an exact-body HMAC, stable event ID, redirect rejection, bounded responses, and exponential retry. The callback URL must be exactly the configured Ops origin plus `/api/viewer/events` with no credentials, query, or fragment.

See [ODM_PROVIDER_COMPATIBILITY.md](ODM_PROVIDER_COMPATIBILITY.md) for upstream route evidence and option behavior.
