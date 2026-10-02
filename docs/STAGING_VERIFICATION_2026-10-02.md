# Shared staging verification — 2026-10-02

This records completed checks, not release acceptance. Production was not changed.

## Verified

- Windows passwordless SSH to `bkoltz@192.168.50.90` succeeds.
- Actual desktop MCP send/receive/claim/ack succeeds against the staging bus. A delivery receipt was claimed and acknowledged using the Codex credential only.
- The user configuration contains exactly one bus table. Both CLI installations parse it outside the sandbox. The sandbox's empty configuration view must not trigger appending another table.
- Shared-file upload/download hash verification succeeded for a synthetic connectivity artifact.
- Staging's supervised baseline is healthy: revision `d3797ca9`, schema 38. Assets use the verified CIFS staging share; SQLite/WAL is on local ext4. Project Alpha and node-exporter were left untouched.
- The first dev release passed full CI and exact-image verification: run `37031331596`, revision `842e93fab18c3b7610279f690e72e41c0e6c27e4`, digest `sha256:99350e85cc36b0b76a5517bea3caa7420128091bcec28ab55f45328adcf110f5`. Staging pulled that exact digest successfully; it is not the UI candidate.
- The staging-only SMB policy passed 18 focused tests and a read-only check on the real mounted share. The default refuses unavailable inode figures; the explicit staging policy admits only verified SMB unavailable figures, preserving byte checks. No service exception is activated yet.
- UI candidate `008568b7dae1cac684c9989aab1a79aa93e1f156` was pushed to dev only. Independent build and focused tests passed: 73 passed, one expected Windows skip, zero failures.
- A consistent online SQLite backup and protected compose/config snapshot was created at `/home/bkoltz/3d-viewer-staging/backups/pre-schema39-20261002T163942Z`. Snapshot integrity is `ok`; SHA256 is `c7264c3a5f4453450278b29a920b4debd0d25a575da5ae358e2a00e4b8042ef0`. Take a final stopped-service snapshot immediately before rollout as well.

## Not yet accepted

- UI candidate CI run `37034964915` failed one stale dev-policy schema assertion: 2,093 passed, one failed, 15 skipped. The assertion was corrected to require both schema 39 workflow expectations. No image was published by the failed run; no deployment success is claimed.
- Schema 39 manual supervised deployment and post-rollout runtime/auth/UI checks remain.
- The in-app browser rejects the private IP certificate. The user's reverse proxy at `192.168.10.80` now provides a valid certificate for `viewer-staging.ledgetopdroneservices.com`; a normal-verification `curl --resolve` reached Viewer with status 421, proving the remaining service hostname mismatch. Public DNS routing awaits the user's firewall redirect. No certificate-validation weakening was performed. The exact staging hostname tuple was added to the deployment policy, with 25 tests passing; mixed tuples and production remain refused.
- Windows watcher still targets the old bus. Keep it inactive until Hermes confirms queue cutover and pending-message handling; do not run two independent active queues.
- Repo-scoped read-token installation remains pending Hermes coordination. Do not replace it with the registry credential.
- Representative Terra acceptance awaits the user's export. Operations silent renewal and internal client portal remain owned by the other agent.

Use `STAGING_RELEASE_CHECKLIST.md` for remaining acceptance. Keep credentials and launch capability URLs out of evidence.
