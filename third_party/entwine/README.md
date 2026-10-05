# Native Entwine runtime

Entwine 3.2.1 is installed using its upstream-supported conda-forge distribution:
https://entwine.io/en/latest/quickstart.html
https://github.com/connormanning/entwine

`amd64.lock` and `arm64.lock` are independent `@EXPLICIT` native package closures
resolved for Entwine alone (not the large `pdal` Python/plugin metapackage).
Every package URL has a SHA256 fragment, enforced by micromamba during download.
The pinned multi-platform micromamba image is build-only. No solver, package
manager, Python, or service is added to the Viewer runtime.

Lock SHA256 values are also pinned in `scripts/verify-entwine-runtime.mjs` and
unit-tested against the checked-in bytes. Preserve LF line endings. Updating a
closure requires review of both locks, verifier constants, runtime conversion
checks, and upstream dependency license/security changes.

The runtime retains conda-meta records and the package-provided license/about/
index notices under `/opt/entwine/third-party-notices`, plus installed upstream
notices under `share/licenses`. Entwine is LGPL-2.1; the complete closure has
additional licenses, including GPL-marked libspatialite. Redistribution must
review those individual notices; do not describe the whole bundle as LGPL-only.
Upstream package recipe/source metadata is retained with the notices.

`/opt/entwine/build-info.json` records architecture, version, exact lock hash,
and native executable hash. The worker invokes the actual native executable,
not a wrapper; no global LD_LIBRARY_PATH overrides the existing mesh converters.
The exact published candidate is gated with non-root, offline, read-only-root
LAS and LAZ conversion tests. Tests verify input sealing, point count, projected
CRS, XYZ, RGB, classification and hierarchy. ARM64 has a native locked closure;
staging AMD64 results do not imply ARM64 runtime acceptance.
