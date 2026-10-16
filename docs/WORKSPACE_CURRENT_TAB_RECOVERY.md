# Explicit current-tab workspace recovery

The normal recovery popup and its same-origin BroadcastChannel/opener exchange
remain the preferred path because the working document stays mounted. Browsers
that cannot open that popup can offer an explicit current-tab action through
`createWorkspaceRecovery`'s `onPopupBlocked` callback. The callback receives
`continueInCurrentTab` and `navigationState`; no automatic navigation occurs.
`recovery.navigationState()` also reports whether recovery is paused.

The workspace supplies current section/project/task hints and new-task state
(`pendingUpload`, `selectedFileCount`, `unsavedTaskDraft`). A UI may present these
facts before invoking `continueInCurrentTab()`. Existing pending-upload
`beforeunload` handlers remain registered; recovery does not bypass them or
dispose a pending upload. A browser-cancelled navigation leaves recovery paused.
The callback's copy/button layout is a separate UI integration.

The action uses only the already validated Operations origin and existing fixed
`/viewer/reauthorize` path. It records a five-minute nonce, previous session ID and
subject, exact Viewer/Operations origins and validated non-secret view hints in
this tab's sessionStorage. No extra bearer, grant or permission is persisted.
Operations echoes the explicit `recoveryMode=same-tab` alongside the nonce in the
validated Viewer return fragment. Deploy this small Ops counterpart before
offering the Viewer action; an older return fails closed rather than being
relayed to a workspace that no longer exists.

At startup, `resumeCurrentTabWorkspaceRecovery` runs before initial redemption
or popup relay. It consumes and deletes the nonce and strips the capability URL
before any network request. It redeems the fresh one-use grant using the existing
browser bearer and verifies unchanged session ID, subject, bearer and controller
origin before installing the returned envelope. Unknown/expired/replayed state,
wrong origins or modes, redirects, revocation, switched identity and late timed
out responses install nothing. The popup path remains unchanged. No CORS flag,
Access grant, new permission or server authentication route is introduced.

## What survives navigation

Server-saved projects, tasks, uploads already committed server-side and saved
measurements remain on the server. Current section/project/task hints and
existing non-secret model-controller routing descriptors remain in this browser
tab. Routing is restored only after the same server-authenticated subject is
validated; routing metadata never grants access.

Unsent selected photo File objects/handles, active browser promises, unsaved
new-task form fields, unsaved GCP edits and measurement drafts in the navigated
document do not survive a full navigation. They are not silently serialized or
replayed. Files may need to be selected again. An in-flight upload or mutation
can have an uncertain server outcome after navigation; inspect its current
server state before starting another operation.

Already open separate model tabs keep their own in-memory camera/drafts while
they remain open, but renewal may pause while the workspace owner is absent.
They reconnect only through the authenticated restored controller; this does
not promise server persistence of unsaved drafts. Inner-model current-tab
launch/iframe fallback is outside this change.
