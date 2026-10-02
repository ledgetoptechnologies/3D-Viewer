# Private staging release checklist

This checklist is an acceptance plan, not evidence that deployment or testing has completed. Keep staging private on the server VLAN; a public reverse proxy or production Operations integration is not required for standalone Viewer testing.

## Codex and shared agent bus

- [ ] Confirm exactly one `[mcp_servers.internal-agent-message-bus]` table exists in the Windows user configuration. Update the existing table in place; do not append another copy. Refuse ambiguous duplicates and preserve a recoverable backup before any edit.
- [ ] Validate the repaired configuration with `codex mcp get internal-agent-message-bus` outside the execution sandbox. A sandbox reporting no servers is not sufficient evidence that the Windows user registration is missing.
- [ ] Verify authenticated Windows-client send, receive, claim, and acknowledgement using harmless test messages and only Codex's own credential. Never include credentials in evidence or messages.
- [ ] Coordinate the watcher endpoint change with Hermes. Inventory pending messages before cutover; do not operate the old and staging buses as two independent active queues.
- [ ] Verify shared-file upload/download integrity and persistence. Shared context must be explicitly retrieved; it is not automatic memory injection.

## Verified dev image

- [ ] Publish only after the full CI checks and runtime verification succeed. Record source revision, workflow run, immutable image digest, and checksum-verified attestation.
- [ ] Pull and deploy the verified immutable dev digest. Never substitute production `latest` if `dev` is unavailable.
- [ ] Preserve production `main` publishing and the production deployment. Do not bypass unresolved updater gates or claim a schema-changing image is migration-free.

## Supervised manual staging rollout

- [ ] Read the host, Viewer, storage, and updater runbooks before changing deployment state.
- [ ] Record the current image digest, schema version, and configuration needed for recovery. Make a consistent SQLite backup using the documented backup/quiescence procedure; copying a live database without accounting for WAL is not sufficient.
- [ ] Review the candidate schema migration before rollout. Keep SQLite/WAL on local storage and assets on the verified NAS mount. A schema-changing release requires manual, coordinated rollout rather than enabling the migration-free updater.
- [ ] Change only the staging image/configuration necessary for the candidate. Manage Viewer through `viewer-staging.service`; preserve systemd supervision, NAS startup guards, mount/sentinel checks, and the documented recovery procedure. Do not restart containers directly to bypass supervision.
- [ ] Leave the SMB unavailable-inode exception default OFF. Enable it only for the explicitly identified staging deployment and verified SMB storage. Byte capacity, reservations, input bounds, mount, and authentication checks must remain intact.
- [ ] Preserve the fenced Project Alpha replica, node-exporter, and existing monitoring. Do not enable processing or remove outbound/cron restrictions without separate coordination.
- [ ] Verify private TLS and authenticated launch. If the browser needs local certificate trust or an operator sign-in step, provide a clear user handoff rather than disabling certificate validation or authentication globally.
- [ ] Verify health, runtime revision/schema identity, storage guards, and rollback readiness after the supervised restart.

## UI acceptance on staging

- [ ] Test the current/default mouse profile and Todd's alternate button mapping in both mesh and point-cloud views. Switching profiles must not reset the camera or leave a stuck drag.
- [ ] Test measurement rename, repeated clicks, save, cancel, and retry. Preserve typed text during pending requests; ensure only one editor opens.
- [ ] Test sidebar collapse/reopen, keyboard access, and smaller screens. Keep dataset/view buttons in their current location.
- [ ] Verify signed-in preferences persist for the intended account, without leaking between accounts. Public links must start with the default profile and must not persist personal measurements or preferences to an account.
- [ ] Confirm the public measurement notice explains that measurements disappear when the page is refreshed or closed.
- [ ] Inspect zoom quality and point-cloud diagnostics at far, medium, and close views after loading settles. Record actual loading, visible points, budgets, and frame rate before attributing sparse detail to source density or changing memory limits.

## Deferred acceptance

- Representative Terra import: deferred until the user selects and supplies an export. Do not copy production datasets as an unapproved substitute.
- Operations client portal/internal sharing and silent session refresh: deferred pending the other agent's integration. Keep those dependencies separate from standalone staging UI acceptance.

Return a concise evidence summary distinguishing completed checks, failures, and deferred work. Do not include tokens, credential contents, or public capability links.
