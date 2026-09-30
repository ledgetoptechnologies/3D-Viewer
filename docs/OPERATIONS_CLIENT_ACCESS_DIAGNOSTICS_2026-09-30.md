# Operations client access: post-restart diagnostic handoff

## Observed state

After nginx recovered on September 30 (approximately 04:17–04:19 UTC), a fresh
Operations page launched an authenticated Viewer workspace successfully. Viewer
health identified revision `9b2a6d790afbf2c790be356c23d8bb78180607af`, schema 38.
Hickory Grove task sharing defaults to Internal client, but its panel reports:

> Operations client access could not be loaded. Close and reopen Share to retry.

The Public link panel now loads normally. The existing link's Copy action reported
`Link copied`; Open loaded the public model; Edit settings displayed the stored
password, expiry, views and features. No link settings, client grants or saved
client measurements were changed. A page-only public distance cleared on reload.

This is not the earlier public-share creation/owner-permission issue. It is also
not proof that the same nginx outage caused the remaining client-access failure.
The visible error does not identify its HTTP status or root cause.

## Exact request contract

Viewer's `server/clientGrantProxy.js` implements:

- Local authenticated GET `/api/v1/workspace/client-grants`.
- Required local permission: `viewer.client_grants.manage`.
- Server-to-server POST `/api/viewer/workspace/client-grants` to the configured
  Operations automation origin, using the existing Viewer event signature.
- Read-only JSON envelope: `{ "subject": "ops:<staff ID>", "action": "list" }`.
- Successful snapshot requires `grants`, `projects` and `associations` arrays.

The proxy does not forward a browser bearer to Operations. Do not retrieve or
share browser credentials to reproduce this request.

The inspected Operations source at
`apps/operations/src/worker/viewer-processing.ts` gates the remote route on
`viewerIntegrationEnabled(env)` and `CLIENT_VIEWER_SESSION_ISSUER_ENABLED=true`.
It verifies the machine signature, rate limit, nonce and active staff subject.
`listViewerClientGrantWorkspace` in `viewer-integration.ts` additionally requires
the canonical `viewer.manage` authority and reads current client/project/model
associations. These are source-code findings, not evidence of deployed flag values
or a permission denial for this user.

## Read-only checks requested

1. Find the fresh local GET in Viewer request/error logs. Return timestamp, HTTP
   status and safe error code; do not include Authorization headers, cookies,
   machine-signature headers, event secrets or bearer URLs.
2. If the local request reached the proxy, correlate the remote Operations POST.
   Report its status and safe error category: route disabled/not deployed,
   machine signature rejected, staff identity/authority denied, rate limited,
   invalid snapshot, or database/service failure. Do not guess from the UI text.
3. Confirm the deployed Operations revision and whether its integration and
   session-issuer gates are intentionally enabled for client access. Do not
   enable flags or broaden permissions as a diagnostic workaround.
4. If authority is denied, test effective protected-owner permissions on both
   sides using trusted server identity. Ordinary staff/client restrictions must
   remain unchanged; never infer owner authority from a browser label or email.
5. If successful, verify a bounded snapshot with all three array fields. An empty
   authorized list should render an empty state, not a generic load failure.

Viewer maps rejected upstream requests to `operations_request_failed` and
transport/invalid-response failures to `operations_unavailable`; a 5xx upstream
response maps to local 502. Those codes alone cannot identify the upstream cause.

## Acceptance and coordination boundary

After the responsible fix or configuration rollout, open a fresh workspace from
Operations and inspect Internal client sharing for both a project and a task.
Reading existing clients/grants requires no new grant, public exposure or job.
Test grant mutations only with explicit authorization and a designated fixture.
Keep Operations silent-renewal deployment as a separate, user-deferred check.

This handoff does not authorize cross-agent messaging, credential disclosure,
production role changes, flag changes, or unrelated Operations edits. The user
can forward it to Hermes or the Operations agent.
