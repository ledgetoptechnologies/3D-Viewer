# Workspace renewal and model-controller continuity

## Verified failure mechanisms

- A workspace without its original Operations opener has no proactive workspace-grant transport. At expiry it intentionally navigates through Operations `/viewer/reauthorize` and returns with a fresh one-time grant. This is the visible sign-in/return navigation, not a model rendering fault.
- Model renewal channels were tracked only in workspace memory. A reload or the reauthorization round trip lost those records while model tabs kept their old random BroadcastChannel names. Posting to a channel with no listener succeeds; the model then times out and retries rather than receiving a new grant.
- Workspace grant redemption cleared its request marker and watchdog before the network/body read completed. Focus could start a second request. A late completion after controller disposal could install a session callback and schedule new timers.

These mechanisms were reproduced against the actual controller classes using controlled timers/transports. They do not prove that every observed production stall has this cause.

## Viewer-side changes

- Keep at most the last 32 non-secret model-channel descriptors in this workspace tab's sessionStorage, retained for up to 24 hours since successful controller activity. This limits reload continuity, not the number of models that may be opened during the active workspace lifetime. Fields are the random channel, immutable model/version/review-or-published context, timestamp and authenticated Operations subject. No bearer, grant, capability URL, or permissions are stored in these descriptors.
- Restore descriptors only after the workspace server authenticates the same subject. A surviving model's first correlated expiry request reconnects its controller state. Browser metadata grants no access: the current authenticated server endpoint must issue a fresh grant, and the existing response checks must match the exact mode/model/version/attempt context.
- Known workspace expiry can preserve routing across reauthorization. Explicit sign-out/revocation, subject change and authoritative model renewal denial clear routing. Duplicate authorization-clear callbacks cannot create multiple redirects or erase an already-preserved expiry handoff.
- Workspace grant redemption remains single-flight, has a bounded abort deadline, and ignores late disposed/timed-out generations. Active model resources and camera state are not recreated by these changes.

## Authorization boundaries unchanged

Workspace grants still originate from Operations authorization. `/api/v1/admin-grants` requires the server-to-server authorized HMAC path; `/api/v1/admin-sessions/redeem` requires a fresh one-time grant, enforces subject continuity and caps expiry by Operations authorization. Model grants are issued by the existing authenticated review/published endpoints, enforce immutable output scope and remain capped by the current workspace authorization. Nothing extends token lifetimes or suppresses terminal denial.

This patch does **not** implement silent grant issuance for an openerless workspace. That needs an Operations-authorized transport with its session/CSRF/origin contract explicitly supported by Operations. The Viewer must not invent such an endpoint, silently embed a sign-in page, or convert an expired Viewer bearer into fresh Operations authorization.

## Verification / remaining checks

Focused tests cover same-subject restoration, wrong subject, explicit disposal, authoritative denial, malformed/aged descriptors, early and foreign requests, exact version rejection, published/review contexts, pending redemption timeout, duplicate focus, and late disposed responses. A strict same-channel/model controller-ready advisory accelerates an already-due renewal after workspace restoration. It grants no access, does not interrupt an in-flight redemption, and never clears authoritative denial. Older open model tabs without this handler still reconnect on their existing retry schedule. Real production token-lifetime and cross-tab reauthorization soak tests remain necessary.
