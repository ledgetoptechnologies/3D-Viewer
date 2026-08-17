# Processing scale verification

Normal CI runs real-filesystem cases with a bounded file count. They verify the
same full-content scan/fingerprint, adoption, dataset finalization, indexing,
storage accounting, database reopen, injected low-space refusal, and guarded
cleanup used by the opt-in harness. This is regression coverage, not proof of
production-scale performance.

`scripts/processing-scale-rehearsal.js` is credential-free and never contacts a
provider. It requires an explicit existing root and creates a randomized direct
child named `ltds-viewer-scale-<UUID>`. Cleanup occurs only after the real target
and exact per-run sentinel are revalidated. The script does not delete or alter
any sibling in the supplied root, and its JSON report omits the root path.

## TrueNAS production rehearsal

Use a dedicated empty directory on the same storage class intended for Viewer.
Do not use the Viewer data volume, a live WebODM tree, or an irreplaceable
dataset. Replace the two `REPLACE_...` values with the reviewed image digest and
its exact 40-character source commit.

```bash
sudo install -d -o 568 -g 568 -m 0700 /mnt/Plugins/App_Data/Model-Viewer/Scale-Rehearsal

VIEWER_IMAGE='ghcr.io/ledgetoptechnologies/3d-viewer@sha256:REPLACE_WITH_64_HEX_IMAGE_DIGEST'
SOURCE_COMMIT='REPLACE_WITH_40_HEX_GIT_COMMIT'

docker run --rm \
  --user 568:568 \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=256m \
  --mount type=bind,src=/mnt/Plugins/App_Data/Model-Viewer/Scale-Rehearsal,dst=/rehearsal \
  "$VIEWER_IMAGE" \
  node scripts/processing-scale-rehearsal.js \
    --root /rehearsal \
    --files 100000 \
    --bytes-per-file 1048576 \
    --production \
    --image "$VIEWER_IMAGE" \
    --source-commit "$SOURCE_COMMIT"
```

The example creates about 100 GiB of disposable input and performs multiple
full reads, so schedule it accordingly. Lower `--bytes-per-file` only when the
goal is inode/index scale rather than representative throughput. Production
mode rejects counts below 100,000; development mode supports small local runs.

A passing report includes per-phase elapsed milliseconds, total bytes, peak
RSS, filesystem/device statistics, generated/preview/finalized/reopened counts,
the full tree and manifest hashes, image/source commit inputs, a confirmed
low-space refusal, and `cleanup.verified=true`. Save that JSON with the release
record. Do not claim real-scale proof from the normal CI test or from a run on a
different storage class.
