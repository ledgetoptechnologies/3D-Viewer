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
session continuity. Desktop two-column options, remaining narrow-dialog actions,
and live acceptance remain separate gates.
