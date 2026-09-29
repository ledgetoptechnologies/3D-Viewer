# Remaining source-unit implementation

This is a current-source audit, not a completed feature or a claim about deployed workers.

## Explicit imported metadata

`webodmTaskImport.adoptWebodmTask` and `catalogImport.adoptCandidate` register hashed
DSM/DTM/EPT assets but do not persist explicit unit inspections. Add a shared
inspection after registration under the authoritative operation/lease boundary.
Reuse `resolveRasterVerticalUnits` and `resolveEptVerticalUnits`: both already
understand explicit feet and conflicts. Do not reuse the scheduled native-UTM
inspector unchanged; it intentionally reduces nonmetre units to `other`.

The registry currently accepts only metre evidence. Extend it with original unit,
factor, and a server-inspected explicit-metadata basis. Consumers must compare that
evidence with current encoded units; a foot record must never become a metre
override. Existing explicit metadata already informs calculation preflight; this
work adds persistent source-level evidence, not permission to ignore preflight.

## Native point cloud to generated EPT

The native ODM resolver supports LAZ but ingestion and registration do not persist
that proof. Add an independently inspected registered LAS/LAZ source binding.
`derivativeInputSnapshot` already freezes one hashed input and verifies its bytes.
`derivativeWorker` runs Entwine and hashes the output, but registration does not
record the exact accepted input-proof-to-output relationship. Its existing-output
resume path is not sufficient to infer that conversion occurred.

Record a server-owned conversion receipt: contract/version, job/attempt/model
version, exact registered input and manifest digest, accepted unit-proof digest,
converter identity and allowed no-reprojection invocation, output manifest and
ept.json hashes. Reverify input after conversion or use a pinned immutable copy.
Check output unit/CRS declarations for conflicts. Commit receipt and registration
under the existing lease transaction. Resume inheritance requires a matching
receipt; merely hashing an existing directory does not establish lineage.

## Historical archives and ODX

Import source snapshots and retained manifests bind archive/log/image/coordinate
bytes to an imported version. They do not prove fresh processing, full original
inputs, actual producer, or that adjacent products came from those logs. Do not
fabricate a fresh-task receipt. Missing metadata remains one-time staff review
unless a separately audited producer/import contract resolves it.

The actual ODX worker version remains unavailable because the known SSH endpoint
timed out. This is an unaudited producer path, not proof its units are unknowable.
Explicit metadata can resolve ODX products independently of producer inference.

## Required tests

- Metre/international-foot/US-survey-foot raster and compound-WKT EPT imports;
  conflicts, missing metadata, changed bytes, idempotent retries and staff precedence.
- Original unit/factor registry semantics and persisted-versus-encoded disagreement.
- Native LAZ inspection/proof binding and rejection of unknown or changed provenance.
- Conversion input/output substitution, unreceipted existing output, interrupted
  promotion, lease loss, exact retries, and output vertical-unit conflicts.

No Ops changes or live records were touched in this audit.

## Native metadata follow-up (not released)

The native LAS/LAZ inspector now reads bounded LAS 1.2–1.4 VLR/EVLR
metadata, binds its result to registered SHA-256/size and stable file identity,
and preserves explicit metre/international-foot/US-survey-foot units. A
horizontal-only CRS does not establish vertical units. This reader currently
supports WGS84 UTM; unvalidated GeoTIFF vertical CRS/datum authority keys and
unsupported declarations remain unresolved. It does not decode compressed
points or establish producer provenance.

Import/scheduled registration inspection now persists explicit native
`pointCloud` evidence through the shared registry. Unsupported or conflicting
metadata leaves the source available without unit evidence; changed bytes fail
inspection. Native evidence cannot be relabeled as EPT evidence, and this does
not expand staff-review or inferred-producer authorization. Twelve real LAS
import cases cover both catalog and WebODM import routes. The first test run
used an undiscovered fixture filename; corrected fixtures use the importer's
existing supported native-cloud filename, with no discovery-policy change.

The EPT worker now selects the exact registered source matching its immutable
input snapshot instead of the first point-cloud row, and rehashes its input
after conversion. These are prerequisites, not a completed conversion receipt:
unit inheritance into EPT and receipt-bound resume still need implementation.

Verification: nine native inspector tests pass. The derivative snapshot,
imported-delivery and policy suites pass 20 tests; the Linux automatic-safety
and native-inspector suites pass 42 tests. A Windows run of automatic-safety
failed because its Linux `/proc` descriptor fixtures are unavailable there;
the same suite passed in the isolated Linux container. No live worker was
contacted successfully, no processing job was started, and no deployment was
performed by this follow-up.

Final combined verification after the fixture correction: full Linux server
suite plus native inspector, 911 tests, 910 passed, one skipped, zero failures.
This checkpoint is eligible for branch publication, not a claim that conversion
inheritance, the ODX producer audit, deployment or live verification is complete.
