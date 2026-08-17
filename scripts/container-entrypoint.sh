#!/bin/sh
set -eu

runtime_uid="${VIEWER_RUNTIME_UID:-1000}"
runtime_gid="${VIEWER_RUNTIME_GID:-1000}"

case "$runtime_uid" in
  ''|*[!0-9]*|0) echo "fatal: VIEWER_RUNTIME_UID must be a non-zero numeric UID" >&2; exit 1 ;;
esac
case "$runtime_gid" in
  ''|*[!0-9]*|0) echo "fatal: VIEWER_RUNTIME_GID must be a non-zero numeric GID" >&2; exit 1 ;;
esac

# TrueNAS host-path bind mounts commonly arrive owned by root even when there
# is no host passwd entry for the image's numeric service UID. Mirror Project
# Alpha's safe bootstrap: prepare only the fixed application-owned mount roots,
# then permanently drop privileges before starting Node. Never touch the
# read-only WebODM or legacy-derivative mounts.
for managed_root in \
  /app/data \
  /app/datasets \
  /app/models \
  /app/cache \
  /app/trash \
  /imports/datasets \
  /imports/terra
do
  if [ -L "$managed_root" ] || { [ -e "$managed_root" ] && [ ! -d "$managed_root" ]; }; then
    echo "fatal: managed mount root must be a real directory: $managed_root" >&2
    exit 1
  fi
  mkdir -p -- "$managed_root"
  chown "$runtime_uid:$runtime_gid" "$managed_root"
  chmod u+rwx "$managed_root"
done

# Database sidecars and legacy registry files are small, application-owned
# state. Repair their ownership after an interrupted/older root deployment
# without recursively traversing large dataset or model trees.
find /app/data -xdev -mindepth 1 -maxdepth 1 \( -type f -o -type d \) \
  -exec chown "$runtime_uid:$runtime_gid" {} +

exec setpriv \
  --reuid="$runtime_uid" \
  --regid="$runtime_gid" \
  --clear-groups \
  --bounding-set=-all \
  --inh-caps=-all \
  --ambient-caps=-all \
  -- "$@"
