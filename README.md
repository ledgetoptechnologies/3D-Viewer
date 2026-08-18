# LTDS 3D Viewer

Client-facing photogrammetry viewer and optional self-hosted processing
platform. The Three.js app provides Earth-style navigation, verified streamed
LOD with a full-detail fallback, camera-position browsing, measurements,
Potree EPT point clouds, and streamed GeoTIFF layers. It can display legacy
WebODM media in place or manage immutable uploaded/imported datasets and send
them to NodeODM/ClusterODM for native EPT, 3D Tiles, and GLB production.

## Architecture

- **Frontend** (`index.html`, `main.js`, `earth-controls.js`,
  `public/pointcloud.html`) — the three.js/Potree viewer. Loads no
  project-specific data at build time; everything comes from `GET /api/models`
  at runtime.
- **Backend** (`server/`) — a Node/Express API plus a durable worker that:
  - Optionally authenticates to WebODM's REST API and reconciles its catalog
    through mounted task-folder or exported ZIP migration. The processing
    platform do not require WebODM credentials. **It never queries WebODM's
    Postgres database directly.**
  - Verifies which output files actually exist on the read-only WebODM media
    mount and registers canonical models, versions, assets, imports, shares,
    and browser sessions in `data/viewer.sqlite`. Legacy JSON is migrated once
    and retained only for old admin/share route compatibility.
  - Manages immutable dataset manifests, durable upload/import operations,
    processing attempts, native derivatives, review/publish state, lifecycle
    journals, callbacks, shares, and scoped browser sessions in SQLite.
  - Serves the built frontend, versioned `/api/v1` Ops API, legacy
    `/api/models` compatibility routes, and protected assets without exposing
    server paths. Published viewing remains available during provider outages.

See `server/config.js` for all environment variables.

The optional direct-upload and ODM processing subsystem is documented in
[`docs/PROCESSING_PLATFORM.md`](docs/PROCESSING_PLATFORM.md). It is disabled
by default; enabling it does not make provider availability a dependency of
already-published viewing.

## Running with Docker (production)

1. Create only the fixed TrueNAS configuration path:
   ```bash
   mkdir -p /mnt/Plugins/App_Data/Model-Viewer/Config
   chmod 700 /mnt/Plugins/App_Data/Model-Viewer/Config
   ```

   Application data uses the fixed Docker-managed volume
   `ltds-viewer-storage`. Docker creates it automatically on first deployment
   and initializes its `data`, `datasets`, `models`, `cache`, `trash`, and
   import directories from the image. This avoids TrueNAS host-path ACL and
   startup-`chown` failures, while keeping every crash-safe rename on one
   filesystem. Do not delete this volume during an image update or app rename.
2. Copy `.env.example` to the persistent configuration path, restrict it, and
   set independent generated secrets:

   ```bash
   cp .env.example /mnt/Plugins/App_Data/Model-Viewer/Config/viewer.env
   chmod 600 /mnt/Plugins/App_Data/Model-Viewer/Config/viewer.env
   ```

   `SERVICE_AUTH_SECRET` must exactly equal Ops
   `VIEWER_SERVICE_HMAC_SECRET`; `VIEWER_EVENT_SECRET` must exactly equal Ops
   `VIEWER_EVENT_HMAC_SECRET`. `SESSION_SECRET` is an independent Viewer-only
   secret and must not be reused. `PROXY_SHARED_SECRET` and
   `TRUSTED_PROXY_ADDRESSES` are optional follow-up hardening and should remain
   empty until the matching Nginx changes are ready. WebODM migration uses
   mounted task folders or exported ZIP archives and never needs WebODM API
   credentials or database access. The production Viewer/Ops/client
   hostnames and read-only TrueNAS source paths already have safe defaults in
   `docker-compose.yml`. Back up `Config/viewer.env` securely with the database
   and never copy its populated contents into this repository or logs.
3. Set `VIEWER_IMAGE` to
   `ghcr.io/ledgetoptechnologies/3d-viewer:latest` for normal guarded TrueNAS
   updates. A reviewed `sha-<commit>` tag published by CI or an exact
   `@sha256:` digest can freeze a specific release. The update helper accepts
   no other mutable tag. If the GHCR package is private, configure TrueNAS/Docker with a GitHub token
   that has `read:packages`, then run the commands below. This installation
   should set `PROCESSING_PLATFORM_ENABLED=true`, the
   exact NodeODM/ClusterODM `PROCESSING_PROVIDER_ORIGINS`,
   `PROVIDER_CREDENTIALS_KEY`, and
   matching `VIEWER_EVENT_URL`/key/secret in `Config/viewer.env`, then run:

   ```bash
   VIEWER_ENV=/mnt/Plugins/App_Data/Model-Viewer/Config/viewer.env
   docker compose --env-file "$VIEWER_ENV" pull
   docker compose --env-file "$VIEWER_ENV" up -d
   docker compose --env-file "$VIEWER_ENV" ps
   ```

   For subsequent updates, use `scripts/update-truenas.sh . auto`. It derives
   the processing mode from the persistent environment, pulls the configured
   official `latest` or immutable image, refuses nonterminal work unless
   `VIEWER_UPDATE_ALLOW_ACTIVE=1` is explicitly supplied for an emergency,
   retains the previous image ID locally as
   `ltds-viewer-rollback:previous`, waits for container health, and runs the
   production readiness check.

   The API must receive `PROCESSING_PLATFORM_ENABLED=true` through the shared
   persistent environment; the always-started worker reads the same file and
   idles safely if the flag is explicitly false. The platform is
   not active unless both `viewer-api` and `viewer-worker` are healthy. The
   production Compose profile always pulls the configured registry image;
   local source builds remain explicit with `docker build` and cannot silently
   replace the reviewed production image.

   `PROCESSING_PROVIDER_ORIGINS` contains any fixed exact NodeODM or ClusterODM
   origins; it must not name the WebODM application. The one-time
   `PROCESSING_PROVIDER_ALLOWED_CIDRS` boundary permits IP-literal nodes on the
   two reviewed private LANs. After startup, create a provider and securely
   store or rotate its token in Ops, then probe capabilities and enable it.
   Credentials are encrypted in the Viewer database and never returned to the
   browser; no environment edit or container restart is needed for each node.
4. Compose publishes `viewer-api` directly on the configured LAN bind address
   and port `8088`; it does not run Nginx. Route Cloudflare/cloudflared through
   the separately managed Nginx, then proxy to that LAN address. Adapt
   `deploy/nginx-viewer.conf.example`: preserve request/body limits, streaming
   and range headers, rate/connection limits, disabled caching/access logging
   for capability paths and exact Host rewriting. Direct LAN requests using an
   IP Host are rejected. Optional proxy-secret/IP enforcement is documented for
   a later coordinated rollout. The bare authenticated Viewer URL redirects to LTDS Ops; there is
   no local password-admin login in production.

   For Nginx Proxy Manager, follow the paste-ready GUI instructions and
   verification matrix in [`deploy/NGINX_PROXY_MANAGER.md`](deploy/NGINX_PROXY_MANAGER.md).

Mounted WebODM task trees can be rescanned through the authenticated catalog
API; exported task ZIPs can be imported through the durable task-import API.
`GET /api/v1/health` is liveness and `GET /api/v1/ready` verifies the
database and required mounts. The authenticated
`GET /api/v1/processing/ready` separately reports the durable worker and
lifecycle journal, so provider failure never makes published viewing unhealthy.

The API and worker run directly as the TrueNAS Apps service identity
`568:568`; there is no privileged entrypoint or runtime ownership repair.
Every Linux capability is dropped, privilege escalation is disabled, process
creation is limited, and the container root is read-only. The fixed
`ltds-viewer-storage` volume is persistent and writable; `/tmp` is bounded
in-memory storage. WebODM Media and legacy Derivatives remain read-only host
mounts. An `adopted` import consumes its verified source after durable
promotion, while `external_reference` never moves or deletes external bytes.
The Viewer API is the only Compose service published on port `8088`; the worker
has no published port. Container JSON logs rotate at 10 MiB with three files.
`X_ACCEL_REDIRECT_PREFIX` is empty, so the application performs authorized,
range-capable asset delivery itself.

Client-origin shares are separately gated by
`CLIENT_VIEWER_SHARES_ENABLED=false`. When enabled, the Viewer calls the exact
HMAC-only automation origin `https://incoming.ledgetopdroneservices.com` to
revalidate the bound client grant at bootstrap, unlock, and every asset/range
authorization. Positive decisions are Promise-coalesced for at most five
seconds (negative decisions for one second), then timeout, redirect, mismatch,
revocation, or Ops failure fails that client share closed. Staff-created shares
bypass this check, so published staff viewing never depends on Ops or an ODM
provider. The event-direction HMAC key is reused only under the distinct
source-introspection canonical path/body; it is never the Ops-to-Viewer service
key.

Published Ops/client session revocation is separately gated by
`PUBLISHED_SESSION_SOURCE_REVOCATION_ENABLED=false`. Schema migration v17 adds
an immutable `{type:"model_association",id,version}` authorization descriptor
to published grants and sessions. The v16-to-v17 upgrade deliberately deletes
unredeemed legacy published grants and revokes active legacy published sessions
whose association cannot be proven; operators should expect those browsers to
reauthorize. It does not guess or backfill an association, and review sessions
are unaffected. Roll out with the flag off, deploy Ops support that sends the
descriptor on every new session and revokes the exact prior association version
on every refresh/reactivation/revoke transition, then enable the flag. Once
enabled, startup atomically removes/revokes any unbound state created during the
compatibility window, and descriptor-less session creation fails closed.

On a new volume, confirm Docker copied the image-owned directory skeleton and
that UID/GID 568 can write it:

```bash
VIEWER_ENV_FILE=/mnt/Plugins/App_Data/Model-Viewer/Config/viewer.env \
  scripts/truenas-storage.sh diagnose
```

If this bounded check reports an older, incorrectly owned
`ltds-viewer-storage` volume, stop admission and run
`scripts/truenas-storage.sh repair-ownership CONFIRM_UID_568`. The command
stops the Viewer services, changes ownership only inside that exact named
volume, and restores the services that were previously running. Do not use a
generic host-path recursive `chown`.

After the container is healthy, run the production readiness check inside it:

```bash
docker compose exec -T viewer-api \
  node scripts/production-readiness.mjs \
  --verify-mount-options --require-models --require-point-cloud
```

The command validates production configuration without printing secret values,
checks that WebODM/derivatives are read-only and Viewer data is writable, checks
the public health/ready probes, exact host redirect, disabled legacy admin API,
and the HMAC-authenticated model catalog. It prints only counts and mount paths.
Add `--model webodm-PROJECTID-TASKID` to require one exact registered model. Add
`--require-lod` only after its derivative directory contains `tileset.json`, a
full `model.glb`, and conversion-generated `lod-provenance.json`; this makes the
deployment check fail closed when full-quality LOD provenance is absent.
`--require-point-cloud` accepts either streamed EPT or a whole-file LAS/LAZ/PLY
fallback. For a browser-scalable production cloud, also pass `--require-ept`.

After configuring and enabling a provider in Ops, verify the processing mounts,
worker heartbeat, provider capability fingerprint/native outputs, disk reserve,
dataset-operation leases, and lifecycle-journal reconciliation:

```bash
docker compose exec -T viewer-api \
  node scripts/production-readiness.mjs \
  --verify-mount-options --require-processing
```

Do not submit a production dataset until this check is green. Provider health
is deliberately excluded from public `/api/v1/health`, so already-published
models remain viewable if NodeODM/ClusterODM later becomes unavailable.
Both public `/api/v1/health` and `/api/v1/ready` explicitly return
`Cache-Control: no-store` so proxy configuration cannot cache readiness state.
They also return matching `X-LTDS-Viewer-Revision` and
`X-LTDS-Viewer-Schema-Version` headers. The revision is read from the
root-owned source identity baked into the immutable image, while the schema
version is read after migrations complete. `production-readiness.mjs` verifies
both routes agree and that the served revision matches the baked identity; the
JSON bodies remain backwards-compatible.

The three readiness levels are intentionally different: container/public
`/api/v1/ready` proves the database and required local mounts only;
`--require-processing` additionally proves the worker heartbeat, disk/journal
state, enabled-provider outputs, and that every enabled credential decrypts;
`--live-capability` exercises an exact protected browser asset path. A green
public probe does not claim that an upstream processing provider is online.

After the Tunnel is live, exercise that exact model's real protected browser
path as well:

```bash
docker compose exec -T viewer-api \
  node scripts/production-readiness.mjs \
  --base-url https://viewer.ledgetopdroneservices.com \
  --model webodm-PROJECTID-TASKID \
  --verify-mount-options --require-models --require-ept --require-lod \
  --live-capability
```

`--live-capability` is deliberately opt-in and requires `--model`. It creates
one short-lived Ops grant/session (120 seconds by default), repeats the signed
creation with the same idempotency key, redeems the grant once, checks the
current session, and downloads only representative one-byte ranges. When
present, it also reads the protected 3D Tiles manifest/child and EPT manifest,
nested JSON hierarchy, and root data node. Unsigned creation, missing browser
authorization, grant reuse, an unscoped asset path, cross-model use, and a
tampered capability must all fail closed. It does not create, alter, or revoke
a model or public share; normal audit/idempotency rows and the expiring
grant/session are the only writes. Override the lifetime, if necessary, with
`--capability-ttl-seconds 30` through `600`. Output and errors redact the
service/session credentials, one-use grant, and browser capability.

The Viewer receives only the explicitly configured provider network access and
storage mounts. WebODM media is always **read-only**. It never mounts WebODM's
Postgres data, Redis/broker data, application source, worker configuration, or
the Docker socket.

### Read-only WebODM access

The Viewer uses the fixed host path
`/mnt/Plugins/App_Data/WebODM/Media`, mounted read-only inside the container as
`/imports/webodm`. It must contain WebODM's Django media tree
`project/{id}/task/{id}/assets/...` and must not be the WebODM Postgres path.

WebODM's own application must use that same dataset as its media
  root:
  ```yaml
  webapp:
    volumes:
      - ${WO_MEDIA_DIR}:/webodm/app/media:z
  worker:
    volumes:
      - ${WO_MEDIA_DIR}:/webodm/app/media:z
  ```
  (If that compose file also declares an `appmedia:`/`dbdata:` named volume
  under top-level `volumes:`, it's unused — every service overrides it with
  the bind mount above via `WO_MEDIA_DIR`/`WO_DB_DIR` env vars.)

The Viewer catalog scanner walks only this media tree. The Viewer never mounts
`WO_DB_DIR`, Redis, WebODM secrets, application source, or the Docker socket.

## Multi-project support

Nothing in the frontend is hardcoded to a specific project any more. In admin
mode, `main.js` calls `GET /api/models`, picks the project from `?project=` in
the URL (or the first available one), and fetches its full config from
`GET /api/models/:id`. A project switcher appears in the top bar whenever
more than one project is available.

Per-project config includes resolved asset URLs (mesh/tiles/point
cloud/orthophoto/DSM/DTM/camera shots — each `null` if that project doesn't
have it, which hides the corresponding tab/layer button) and georeferencing
(UTM zone + RTC origin, parsed from WebODM's `coords.txt`).

## Authentication & share links

The Viewer deliberately has no duplicate LTDS user database. LTDS Ops remains
the identity/ACL source of truth and calls the versioned API with signed HMAC
requests. The production Compose profile disables the legacy password admin.

- **Ops/client sessions**: Ops calls `POST /api/v1/models/:id/sessions` with
  the authorized subject, audience, active model-version ID, permission set,
  required future authorization expiry, and the immutable source authorization
  `{ "type": "model_association", "id": "<opaque association id>", "version": 1 }`.
  The descriptor is optional only during the flag-off rollout window. The browser redeems the returned one-use
  grant for a random, model-and-version-scoped capability; only its SHA-256
  hash is stored. Capability asset paths work when third-party cookies are
blocked and do not collide across simultaneous embeds. Renewal extends the
  same database session in place, so active 3D Tiles/EPT loaders retain stable
  URLs. Iframe renewal messages are accepted only from exact configured embed
origins.
  Capability paths must be excluded/redacted from reverse-proxy and Cloudflare
  URL logs; `deploy/nginx-viewer.conf.example` disables Nginx access logging
  for those routes.

- **Administration**: staff use LTDS Ops. The bare Viewer origin redirects to
  Ops, which lists models and uses the signed `/api/v1` service API to create
  staff/client sessions, project associations, provider rescans, and public
  demo links. Legacy `/api/admin` and password-protected catalog routes return
  `404` while emergency administration is disabled.
- **Share links**: created by Ops through
  `POST /api/v1/models/:id/shares`, each one gets a random
  256-bit token (only its SHA-256 hash is ever stored — the raw token is
  returned once, at creation time, and cannot be retrieved again). A link can
  optionally have a password (scrypt-hashed) and/or an expiry, and can disable
  the measuring tools and/or camera-position layer for that link specifically
  via `permissions: { measure, cameras }`. Revoking a link
  (`DELETE /api/v1/shares/:id`) is a soft-delete that takes effect
  immediately — asset requests re-check the live share record on every
  request rather than trusting a cached session.
- **`/view/:token`** opens the full toolbar (measurements, camera photos,
  layer switching) for that one project; **`/embed/:token`** is the same
  model with the sidebar/topbar hidden for an explicitly embedded public-share
  surface. Authenticated LTDS `/session/:grant` routes open the full Viewer in
  a dedicated tab and use an exact-origin/source opener channel for silent
  one-time-grant renewal. The grant is redeemed immediately and removed from
  the active URL.
- **Cross-origin session control requires HTTPS.** Session/asset authorization
  does not depend on third-party cookies. Put this app behind TLS in production.
- **Not implemented**: annotations, source-file download controls, and
  original flight-photo access. Pinned-version public shares are rejected
  until pinned-version asset resolution is implemented; `latest` works now.

### Cloudflare edge layout

Cloudflare Access authenticates staff on
`ops.ledgetopdroneservices.com` and authenticated customers on
`client.ledgetopdroneservices.com`. Do **not** put a blanket employee-login
Access policy over `viewer.ledgetopdroneservices.com`: an anonymous demo link
must also load the Viewer shell, hashed static bundles, public-share API, and
capability-protected model assets. Instead:

1. Publish external Nginx only through Cloudflare Tunnel; do not port-forward
   Viewer port `8088` from the Internet. Bind it to one reviewed LAN address
   with `VIEWER_BIND_ADDRESS` (or deliberately to all LAN interfaces only when
   host firewall rules require traffic to originate from Nginx).
2. Keep the Viewer hostname Cloudflare-proxied and apply normal zone WAF/rate
   limiting. There is no public administrator UI at that hostname.
3. Staff authorization flows from Access-protected Ops through HMAC-signed
   service requests. Authenticated staff/client tabs use Ops-issued short
   Viewer sessions; large assets still stream directly from Viewer/Nginx.
4. Demo viewers use an unguessable, revocable, optionally password-protected
   public-share token. Every API and asset request rechecks the live share or
   Viewer session.

If account-wide Access protection is enabled, create a narrowly scoped Viewer
exception/application for the public Viewer surface. Cloudflare documents that
path-specific Bypass disables Access enforcement and Access logging, so the
Viewer's own session/share checks remain mandatory. A separate public Viewer
hostname is preferable to a growing list of bypassed asset paths.

The supported production chain is Cloudflare/cloudflared → external Nginx →
Viewer. Nginx resolves the trusted Cloudflare client address, overwrites
`X-Forwarded-For`; therefore Viewer uses `TRUST_PROXY_HOPS=1`. Do not append
inbound forwarding headers. Exact Host enforcement is enabled immediately.
As a later coordinated hardening step, configure `PROXY_SHARED_SECRET` in both
Viewer and Nginx and optionally set `TRUSTED_PROXY_ADDRESSES` to Nginx's exact
socket-source IP/CIDR when Docker preserves it. `X_ACCEL_REDIRECT_PREFIX` stays
empty.

## Known limitations (by design, for this iteration)

- **Processing remains explicitly controllable.** This Compose deployment
  defaults `PROCESSING_PLATFORM_ENABLED` to true and always starts the durable
  worker. An explicit false override leaves the worker healthy but idle. Processing
  requires the writable managed storage
  volume, disk reserve, and an explicitly allowlisted NodeODM or ClusterODM
  provider. NodeODM 2.2.3 and ClusterODM 1.5.5 are tested baselines; other
  compatible versions are capability-probed and warned, not silently trusted.
- **Production derivatives come from ODM's native stages.** Provider
  capabilities must include `pc-ept`, `3d-tiles`, and `gltf`; the Viewer
  requests those outputs and verifies their manifests before review/publish.
  `LOCAL_DERIVATIVES_ENABLED` remains false because the stock image does not
  ship Entwine or Obj2Tiles. If explicitly enabled in a custom image, startup
  fails unless compatible executables are present.
- **Native 3D Tiles do not automatically prove lossless full detail.** The
  schema-v2 LOD audit must bind the exact full GLB, leaf geometry, material
  state, and texture bytes. If upstream tiling decimates, retriangulates, or
  repacks textures, the LOD claim fails closed and the full GLB remains the
  published close-range fallback.
- **WebODM migration is file-based.** Direct WebODM media import reads the
  mounted tree without credentials and never moves or deletes it. Exported
  task ZIPs and task folders can be adopted into Viewer-managed storage.
  The durable catalog scanner also discovers supported models under the
  approved Terra drop root. Administrators map each candidate to an existing
  or new LTDS project and either keep an explicit external reference or adopt
  the verified tree into managed storage. Repeat scans are fingerprinted and
  do not duplicate an unchanged mapping.
- **Existing published legacy models remain deliverable.** Removing live
  WebODM synchronization does not delete registry rows or mounted assets.
  Newly migrated outputs use immutable manifests and publication rules.
- **Original flight photos** (opening the full-res JPG behind a camera
  marker) aren't wired into migrated tasks yet — camera positions still show from
  `shots.geojson` when present, but clicking one is a no-op until a photo
  archive location is configured per project.
- Raw imagery, GCP files, provider archives, logs, and processing internals are
  administrative assets and are never client-shareable by default.
- Annotations and source-file download controls are not implemented. Legacy
  JSON and legacy Viewer routes remain only for compatibility while SQLite is
  the canonical registry.

## Versioned LTDS Ops API

Service routes require HMAC over method, exact path/query, timestamp, nonce,
and SHA-256 of the exact body bytes. Nonces are single-use. Configure one
`SERVICE_AUTH_KEY_ID` + `SERVICE_AUTH_SECRET`, or `SERVICE_AUTH_KEYS_JSON` as
a JSON object containing both current and previous keys during rotation.
For a simple two-key rollout, set the complete
`SERVICE_AUTH_PREVIOUS_KEY_ID`/`SERVICE_AUTH_PREVIOUS_SECRET` pair, deploy the
Viewer first, switch Ops to the new current key, then remove the previous pair.
Service mutations require `Idempotency-Key` (`428` when absent). Retries must
reuse that key with a fresh HMAC
nonce. The Viewer returns the original status/body for an identical retry and
returns `409` if the key is reused with a different method, path, or body.
Credential-bearing replay bodies are encrypted at rest and pruned after 24h.

- `GET /api/v1/models`; `GET /api/v1/models/:id`
- `POST /api/v1/models/:id/sessions`
- `DELETE /api/v1/published-sessions/source-authorization` requires
  `PUBLISHED_SESSION_SOURCE_REVOCATION_ENABLED=true` and the exact body
  `{ "sourceAuthorization": { "type": "model_association", "id": "<opaque>", "version": 1 } }`.
  It atomically tombstones that exact version, removes its unredeemed published
  grants, revokes its active published sessions, and writes a bounded audit.
  The `200` response is exactly `{ sourceAuthorization, revokedGrants,
  revokedSessions }`; a same-key/same-body retry replays that result, while a
  reused key with different bytes returns `409`. Raw grants and session tokens
  are never returned or audited by this route.
- `GET|POST /api/v1/models/:id/shares`; `DELETE /api/v1/shares/:id`
- Admin sessions: `POST /api/v1/admin-grants`; `POST /api/v1/admin-sessions/redeem`
- Catalog: `/api/v1/projects`, `/api/v1/datasets`, and `/api/v1/tasks`
- Resumable upload/finalize: `/api/v1/admin/uploads/...`; durable operation
  polling: `GET /api/v1/operations/:id`; preview cancellation:
  `POST /api/v1/operations/:id/cancel`
- Server import: durable `/api/v1/dataset-imports/preview` and
  `/api/v1/dataset-imports/adopt` operations
- WebODM task migration: durable `POST /api/v1/processing/webodm-task-imports`
  accepts a task folder or exported ZIP and reports detected asset capabilities
- Processing: `/api/v1/processing/providers`, `/presets`, task/attempt detail,
  cancel, retry, and publish routes
- Storage accounting/recovery: `/api/v1/storage`, `/storage/trash/...`, and
  `/storage/mutations/...`
- Browser: `POST /api/v1/sessions/redeem`; `GET /api/v1/sessions/current`
- Unpublished admin review: `POST /api/v1/attempts/:id/review-sessions` and
  subject-scoped `DELETE /api/v1/attempts/:id/review-sessions` require
  `viewer.processing.publish`. Review grants are short-lived, bind the exact
  review-ready attempt/model version, expose only integrity-checked derived
  assets, and never publish or create a public share.
- Public probes: `GET /api/v1/health`; `GET /api/v1/ready`

Session-grant responses are `Cache-Control: no-store`; the service secret is
never exposed to browser code. Required `authorizationExpiresAt` only shortens the
configured Viewer TTL, and `modelVersionId` prevents an authorization for one
version silently following a newly activated version. Iframe messages use
`version: 1` and the `ltds-viewer:ready`, `session-expiring`, `renew-session`,
`session-renewed`, and `session-renewal-failed` event types.

## Local development

Run the backend and the Vite dev server side by side:

```bash
# terminal 1 — backend (reads server/config.js env vars)
WEBODM_MEDIA_MOUNT=/path/to/webodm/media \
EMERGENCY_ADMIN_ENABLED=true ADMIN_PASSWORD=dev-only-password \
PORT=8090 npm run server

# terminal 2 — frontend, proxies /api and /assets to :8090 (see vite.config.js)
npm run dev
```

This legacy password shell is only a local-development harness; the production
Compose profile fixes `EMERGENCY_ADMIN_ENABLED=false`. `npm run dev` uses
Vite's own dev server for `/`, so it does not run the Express login gate.
`/view/:token` and `/embed/:token` behave the same in both, since their auth
is token-based via the API, not the login page.

`npm run build && npm run server` reproduces the production single-process
setup locally (serves the built `dist/` from the same Express server).

`serve-all.sh` is a legacy fallback from before the backend existed (four raw
`http-server` processes with hardcoded paths for one project) — prefer the
Docker/backend setup above for anything beyond quick local Draco/tileset
debugging.

## Files

- `main.js` — app: bootstrap/project config, tabs, layers, measurements,
  cameras, GeoTIFF streaming
- `earth-controls.js` — `EarthLikeControls`: LEFT-drag orbits around the surface
  point under the cursor (pivot stays in the scene, camera never recenters),
  RIGHT-drag pans along the ground plane, wheel zooms toward the cursor,
  touch: 1-finger orbit / 2-finger pan+pinch. Polar angle clamped, zero-roll.
- `public/pointcloud.html` — isolated Potree 1.8 iframe (EPT, EarthControls with
  the same left/right swap, EDL, budget/size/color toolbar); config (EPT URL,
  title, point count) comes from its query string, set by `main.js`.
- `server/` — API and durable worker: mounted/exported WebODM migration, dataset/import
  manifests, NodeODM/ClusterODM processing, derivative/review publication,
  lifecycle recovery, SQLite migrations, signed v1/legacy compatibility,
  session/share authorization, protected asset delivery, and auth primitives.
  See `server/config.js` for environment variables.
- `public/admin-login.html` — legacy local-development login shell; production
  redirects standalone administration to LTDS Ops.
- `serve-all.sh` — legacy local-dev-only asset server startup (see above).

## Georeferencing

Legacy published records may retain the per-project UTM origin (RTC) and zone
previously parsed from WebODM's `coords.txt` (`odm_georeferencing/coords.txt`), e.g.:

```
WGS84 UTM 16N
367257 4759982 0
```

- GLB/OBJ: parent rotated `-π/2` X (Z-up→Y-up), child offset `-C` (model bbox
  center; `{0,0,0}` unless a `viewer.json` override is present — see "Known
  limitations")
- 3D Tiles: `3d-tiles-renderer` already applies its own up-axis fix; parent is
  rotated `π` X with offset `(-C.x, -C.z, C.y)` so tiles land exactly on the GLB
- Cameras (`shots.geojson` translations are absolute UTM): position − RTC, then
  the same GLB frame; rotation = axis-angle negated (WebODM convention)
- Statusbar `worldToUtm()` converts back for live E/N/elevation readout

## Feature notes

- **LOD mesh** (when verified tile derivatives exist): hierarchical B3DM tiles,
  REPLACE refinement (root → intermediate LODs → LOD-0 full res as you zoom). Detail
  slider maps to `tilesRenderer.errorTarget` (26 − slider). The status bar says
  `LOD: full-detail` only when every visible tile is on the declared zero-error
  frontier. Invalid hierarchy or tile-load failures fail over to the independent
  GLB when it is available. Resize/orientation changes also refresh the render
  resolution used by the screen-space-error calculation.

  Zero geometric error verifies renderer convergence, not conversion provenance:
  the tiles match the full mesh only if the derivative pipeline generated every
  LOD-0 leaf from that exact source without decimation or reduced textures. Keep
  the source fingerprint and triangle/texture audit produced by the conversion
  job with the derivative set; mounted project assets are not stored in this repo,
  so filename conventions alone cannot prove equivalence.

  Production LOD sets therefore require `lod-provenance.json` beside
  `tileset.json`. Without a valid record, the viewer safely switches to the
  actual full mesh (or disables the invalid LOD layer if no full mesh exists):

  Generate the record with the offline equivalence audit; never hand-author it:

  ```bash
  npm run audit:lod -- /path/to/derivatives/project-task /path/to/derivatives/project-task/model.glb
  npm run validate:lod -- /path/to/derivatives/project-task /path/to/derivatives/project-task/model.glb
  ```

  The generated evidence has this versioned shape (artifact list abbreviated):

  ```json
  {
    "schemaVersion": 2,
    "sourceAsset": "model.glb",
    "sourceSha256": "<64 lowercase hex characters>",
    "geometry": "bounded-triangle-equivalence",
    "textures": "byte-identical-material-equivalence",
    "leafGeometricError": 0,
    "audit": {
      "algorithm": "ltds-glb-leaf-equivalence-v1",
      "coordinateTolerance": 0.000001,
      "maxNumericDelta": 0,
      "triangleCount": 123456,
      "equivalenceSha256": "<64 lowercase hex characters>",
      "artifacts": ["<tileset, leaf, and external-texture digest records>"]
    }
  }
  ```

  The generator parses the source GLB and all zero-error GLB/B3DM leaves,
  applies node/tile/JSON-RTC transforms, and compares winding-preserving
  triangles, vertex attributes, render material state, samplers, and exact
  texture bytes. It binds every tileset, leaf, and external texture by digest.
  During import validation the Viewer re-hashes the selected full GLB and every bound
  artifact before exposing the evidence. Otherwise the client automatically
  loads the actual full mesh. See [docs/LOD_PIPELINE.md](docs/LOD_PIPELINE.md)
  for the intentionally fail-closed supported subset and why a tiler that clips
  or retriangulates partition boundaries cannot receive an exact v1 proof.
- **Camera positions**: one `InstancedMesh` of view-frustum pyramids, gold
  highlight on hover, tooltip with filename. Size slider.
- **Measurements**: distance / area / volume with CSS2D labels pinned to the
  geometry. Imperial is the default; project/session/share state can select
  metric, and distance, elevation, area, and volume use one consistent unit
  formatter. Esc cancels, right-click or Enter or double-click finishes
  polygons, the tool auto-disarms, and finished measurements persist until
  Clear.
- **Ortho/DSM/DTM**: `GeoTIFF.fromUrl` HTTP range reads against the BigTIFF
  overview pyramid. A Leaflet `GridLayer` subclass reads windows per tile at
  the right overview level. Map auto-fits to the raster bounds over Esri World
  Imagery. DSM/DTM get viridis + hillshade, legend in ft, hover elevation
  readout.
- **Point cloud**: Potree in an iframe when an EPT dataset exists (its bundled
  Three r124 can't share the page with npm Three); otherwise a direct
  LAZ/LAS (via `@loaders.gl/las`) or PLY point cloud in the main three.js
  scene.

## Verification

Run `npm run check` before building an image. The suite covers direct LAS
Float64 decoding before UTM rebasing, point-cloud-only initialization, protected
EPT metadata/nodes with HTTP range and HEAD behavior, live share revocation,
LOD hierarchy/provenance/fallback policy, production health/readiness, the
model registry migration, service-request replay protection, resumable durable
dataset operations, provider fencing, asset manifests, and crash-consistent
trash/restore/purge recovery. The Docker build additionally asserts the exact
Potree, jQuery, Three.js, and LAS/LAZ runtime files requested by
`pointcloud.html`.

Before promoting a new project, stage it with the real mounted assets and
verify both the EPT view and close-range LOD frontier on representative desktop
and mobile hardware. Raw LAS/LAZ fallback is intentionally limited to LAS 1.3
and below and loads the whole file; large field clouds should use EPT.

## Pitfalls learned

- `3d-tiles-renderer@0.5.x`: use `addEventListener('load-tileset'|'load-model')`,
  NOT the removed `onLoadTileSet`/`onLoadModel` callbacks. Event `ev.scene`.
- Three r180+: `Vector3.subScaledVector` does not exist — use
  `addScaledVector(v, -s)`.
- Raycast picking on 8k-instance meshes / big tiles needs `three-mesh-bvh`
  (`firstHitOnly = true`); BVH build is queued one mesh per frame.
- BigTIFF + geotiff.js works with `fromUrl` range requests; DEM nodata is
  `-9999` (also guard `< -1000`).
- Point-cloud orbit/zoom must mirror `EarthLikeControls`' sign conventions
  exactly (negated drag deltas; wheel-zoom must dolly the camera position
  without ever calling `view.lookAt()`) — Potree's own `View.getSide()`
  confirms the `(cos(yaw), sin(yaw), 0)` right-vector approximation used in
  `pointcloud.html` is otherwise correct.
- When direct PLY/LAS positions are replaced after RTC localization, recompute
  both geometry bounds. PLYLoader's old absolute-UTM bounding sphere otherwise
  stays millions of metres away and Three.js frustum-culls the entire cloud,
  producing a black canvas even though decoding completed successfully.
- Headless CDP verification: connect websocket with `suppress_origin=True`,
  drive with Input.dispatchMouseEvent; vite HMR means always hard-navigate
  after editing main.js before measuring behavior.
