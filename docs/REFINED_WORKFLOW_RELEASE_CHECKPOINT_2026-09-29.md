# Refined Viewer workflow — candidate checkpoint

## Implemented locally

- Stable in-place workspace renewal, including the Operations credentialed CORS
  challenge/grant path when an opener is absent or unresponsive. No Viewer bearer
  is sent to Operations; session identity and origin remain pinned.
- Internal/Public task sharing, existing-link recovery/editing/revocation, view
  restrictions, password and expiry updates, and server-side permission checks.
  New public project sharing is disabled; existing project links are preserved.
- Direct typed task/preset controls and node preset management with fresh capability
  checks and explicit preset saves.
- Source-bound persistent unit evidence: staff review, audited fresh ODM inference,
  and physical explicit DSM/DTM/EPT metadata on imports and processing results.
  Feet remain feet with an explicit factor; units do not prove datum or accuracy.
- Verified point-grid cache, phase timing and profile request coalescing with a
  last-good chart while a replacement is pending.

## Verification at this checkpoint

- Schema-38 checkpoint (`6646032`): Linux server suite, 936 tests,
  935 passed, one skipped, zero failures.
- Non-browser frontend suite: 998 tests, 988 passed, ten skipped, zero failures.
- Production build passes (existing LAZ module/chunk-size warnings remain).
- Synthetic desktop browser QA covered direct preset editing and link creation,
  re-copy after reload, password changes, permissions, per-view restrictions and
  project-versus-task sharing. It found and fixed two CSS visibility/style issues.
- Windows-native import tests are not an applicable gate: storage mount identity
  checks require Linux `/proc`. Those suites passed in the isolated Linux image.

## Deployment and unresolved checks

This document does not attest to a deployed release. The current working-tree
migration target is schema 38: immutable EPT conversion receipts. Back up the
database before deployment. Historical EPT outputs receive no invented receipts;
only a successful, verified local conversion can establish inherited unit evidence.
Preserve the configured session secret: encrypted public-link recovery uses a
domain-separated key derived from it. Existing hash-only links without recoverable
receipt data are left active and reported unrecoverable, never silently replaced.

Operations renewal requires its own endpoint release/feature flag and Access/CORS
configuration. No Operations code is changed in this checkpoint. Verify live expiry
with uploads/drafts/camera/edit state and genuine signed-out recovery after deploy.

The native LAZ-to-derived EPT proof chain is implemented with immutable conversion
receipts and synthetic worker recovery tests. Verification against the installed
real converter remains outstanding; synthetic tests do not establish that result.

Remaining goal work: audited ODX worker versions/provenance; historical untagged
import policy; mobile UI QA; live point-cloud
zoom density and real profile/session performance. Do not treat these gaps as done
because the local test suite is green. No live client data or jobs were changed.

Draft PR: https://github.com/ledgetoptechnologies/3D-Viewer/pull/4.
The PR runs the candidate image checks without merging, publishing release tags,
or deploying. Its checks must be inspected separately from these local results.

## PR candidate CI result

[Run 36629496980](https://github.com/ledgetoptechnologies/3D-Viewer/actions/runs/36629496980)
completed successfully for source checkpoint `6646032` on September 29:

- Full check suite: 2,032 tests; 2,017 passed, 15 skipped, zero failures.
- Logs confirm execution of 390px and 320px workspace/project browser cases.
  This is not complete visual acceptance of the new task-link editor and preset
  layout; existing assertions do not cover every new control at those widths.
- Candidate image built and exact-image runtime verification passed: 138 tests,
  138 passed, zero skipped. Schema 38 and source identity checks passed.
- Release-tag promotion and release-attestation publication were skipped as
  intended for a pull request. No production deployment is established.

## Narrow-layout follow-up

The in-app browser exercised production-built assets in a loopback-only synthetic
workspace using 390px and 320px iframe viewports (layout QA, not touch emulation).
At 390px the standalone preset editor showed one-column resolved options and a
reachable Create preset footer. At 320px the task share dialog defaulted to
Internal client; Public link creation, saved-link password changes, disabling
camera positions, and Copy link succeeded against the synthetic API. The edit
dialog's Save link settings button was visible and reachable. Clipboard contents
and a real public-link destination were not independently verified in this pass.

Visual QA found and corrected two narrow-layout defects: header actions extending
beyond the viewport, and public-link create inputs exceeding their card's content
width. Rebuilt screenshots confirm the wrapped header and contained inputs at
320px. These checks neither mutate client data nor prove live authorization or
session continuity. Remaining narrow-dialog actions and live acceptance remain
separate gates.

At 1200px, subsequent synthetic browser QA confirmed the standalone preset
editor's two-column layout and node option order. Numeric zero and boolean edits
showed Modified state; Reset returned both controls to their node defaults and
disabled their reset buttons. Search reduced the visible options to the matching
feature-quality control. No preset was saved and no task was submitted in that
pass. This adds rendered editor evidence, not real-node schema compatibility.

Follow-up 320px synthetic QA exercised the public-link revoke confirmation and
confirmed project sharing exposes authenticated client access only. The client
grant form had the same intrinsic input-width overflow as public sharing; the
scoped width constraint now covers both forms. A rebuilt screenshot confirms the
project selector, expiry and grant button fit within the card. No real link was
revoked and no client grant was created. Focused sharing/preset tests: 48 passed,
zero skipped; production build passed. Live node inspection remains blocked by
the unauthenticated Viewer shell; the previous cluster address must not be used.

## Live worker identity check — September 29

Read-only SSH access to the user-confirmed cluster PC `192.168.50.89` succeeded
with the existing ed25519 identity selected explicitly. Container metadata reports
ClusterODX 1.5.9, image `webodm/clusterodx`, revision
`818f50bbbfcab107c41fcf4a7101e2bfcbce87e5`, digest
`sha256:b303d24a1f28d0cfa8a6626a9ce0826fc20e586398bd4279a2a70bedfbcc4afd`.
The local `node-odx-gpu` container uses `opendronemap/nodeodm:gpu`, digest
`sha256:214fe6a4421fe5283648400e9ce455457bb866c87a20a325fddfd494e4ad482a`.
Its physical `/code/VERSION` and read-only `/info` agree on ODM 3.5.6;
NodeODM reports 2.2.4. This identifies the installed engine version, but does not
retroactively establish source-bound producer receipts for historical outputs.

ClusterODX's registered workers are `node-odx-gpu:3000` and
`192.168.50.88:3004`. The latter returned `EHOSTUNREACH` when queried from the
cluster, so its engine version remains unverified. Tokens were kept inside the
container and excluded from outputs. No task or container was changed. Viewer
authentication, live renewal, real converter verification and release/deployment
remain outstanding.

The live ClusterODX `/info` response advertises API 1.5.3 (distinct from its
package version 1.5.9), ODM 3.5.6, unlimited images (`null`) and the documented
cluster resource sentinels. Its `/options` and the local worker both return 81
ordered options beginning with end-with, rerun-from, min-num-features and
feature-type. These responses match the adapter's existing detection contract.

Read-only probing found Entwine 2.2.0 in the local worker. Its `--version` exits
zero with a native usage banner, which the original identity parser rejected.
The parser now recognizes that bounded banner and stores `Entwine 2.2.0` while
retaining executable hash/stability checks and rejecting unrelated multiline
responses. In-memory execution of the corrected identity module against the
actual binary succeeded; executable SHA-256 was
`f19d354ded7796a577d68963ab60718a9aa920b0ef8b19ee4fd047b78a21417c`.
The focused Linux identity/receipt/recovery tests passed: 31 tests, zero skipped.
Subsequent real-binary QA converted the repository's 64-point synthetic LAZ with
the fixed `build -i INPUT -o OUTPUT` command. PDAL 2.4.3 read all input and output
points independently; sorted XYZ tuples were exactly equal, with all 64 points
retained. The measured build took 1,042 ms. Unique temporary test directories were
removed. This verifies that worker's conversion command on this synthetic source;
it does not verify the Viewer host's converter, historical provenance, CRS/unit
metadata propagation or performance on a client model.

Cross-repository renewal inspection at Operations `68ca140` identified required
session correlation absent from the Viewer transport. Viewer now sends and
validates the exact echoed session ID with the existing request ID and subject
checks. Forty-one focused renewal/recovery/upload-continuity tests and the
production build passed. The Operations handoff documents the existing Viewer
caller and its current strict request/response contract. Operations still gates
its endpoint to staging; production rollout and live browser acceptance remain
external release gates.
