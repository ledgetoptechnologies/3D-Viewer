# Processing scale verification

Normal CI runs a real-filesystem synthetic case with 2,500 image files plus an
8 MiB streamed administrative file. It verifies finalization, per-file role
indexing, exact byte accounting, and the shared-filesystem processing-admission
calculation. This is regression coverage, not proof of production-scale
performance.

Before enabling a new TrueNAS production pool, run an opt-in rehearsal against
a disposable copy of the actual mount layout. Use at least 100,000
representative files and production-sized imagery, then exercise upload/import
finalization, index queries, storage accounting, low-space admission refusal,
restart/lease recovery, and cleanup. Record file count, total bytes, filesystem,
available/reserved space, elapsed time, peak worker memory, and Viewer image
digest. Never point the rehearsal at a live WebODM tree or an irreplaceable
dataset, and do not report it as passed unless the full run was actually
performed on the target storage class.

The repository intentionally does not enable this run in CI: creating 100,000
files is filesystem- and runner-dependent. A site-specific harness may build
on `test/processing-integrity-v16.test.js`, but production acceptance must keep
the test opt-in and credential-free.
