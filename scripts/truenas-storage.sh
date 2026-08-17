#!/usr/bin/env bash
set -euo pipefail

command_name="${1:-}"
target="${2:-}"
confirmation="${3:-}"
compose_dir="${COMPOSE_DIR:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
viewer_config="${VIEWER_ENV_FILE:-/mnt/Plugins/App_Data/Model-Viewer/Config/viewer.env}"
volume_name=ltds-viewer-storage
cd -- "$compose_dir"

fail() { echo "viewer storage: $*" >&2; exit 1; }
[[ -r "$viewer_config" ]] || fail "cannot read $viewer_config"
compose_args=(--env-file "$viewer_config")
mapfile -t images < <(docker compose "${compose_args[@]}" config --images | sort -u)
[[ "${#images[@]}" -eq 1 ]] || fail "Compose must resolve exactly one Viewer image"
viewer_image="${images[0]}"
docker volume inspect "$volume_name" >/dev/null 2>&1 || fail "Docker volume $volume_name does not exist"

api_was_running="$(docker compose "${compose_args[@]}" ps -q viewer-api 2>/dev/null || true)"
worker_was_running="$(docker compose "${compose_args[@]}" --profile processing ps -q viewer-worker 2>/dev/null || true)"
restart_previous() {
  [[ -n "$api_was_running" ]] || return 0
  local args=(--env-file "$viewer_config")
  [[ -n "$worker_was_running" ]] && args+=(--profile processing)
  docker compose "${args[@]}" up -d --wait --wait-timeout 180
}
stop_for_consistency() {
  docker compose "${compose_args[@]}" --profile processing stop -t 120 viewer-worker viewer-api
}

case "$command_name" in
  diagnose)
    docker volume inspect "$volume_name" --format 'volume={{.Name}} mountpoint={{.Mountpoint}}'
    docker run --rm --read-only --user 568:568 --cap-drop ALL --security-opt no-new-privileges \
      -v "$volume_name:/app/storage" --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
      "$viewer_image" sh -ceu 'for path in data datasets models cache trash; do test -d "/app/storage/$path" && test -r "/app/storage/$path" && test -w "/app/storage/$path"; done; marker=/app/storage/data/.uid-568-write-test; : > "$marker"; rm -f "$marker"; stat -c "storage uid=%u gid=%g mode=%a" /app/storage'
    ;;
  repair-ownership)
    [[ "$target" == CONFIRM_UID_568 ]] || fail "repair requires: $0 repair-ownership CONFIRM_UID_568"
    stop_for_consistency
    if ! docker run --rm --read-only --user 0:0 --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --security-opt no-new-privileges \
      -v "$volume_name:/app/storage" "$viewer_image" \
      sh -ceu 'chown -R 568:568 /app/storage; find /app/storage -type d -exec chmod u+rwx {} +; find /app/storage -type f -exec chmod u+rw {} +'; then
      restart_previous || true
      fail "ownership repair failed"
    fi
    restart_previous
    echo "repaired $volume_name ownership for uid/gid 568"
    ;;
  backup)
    [[ "$target" == /* ]] || fail "backup target must be an absolute .tar.gz path"
    [[ "$target" == *.tar.gz ]] || fail "backup target must end in .tar.gz"
    backup_dir="$(dirname -- "$target")"; backup_file="$(basename -- "$target")"
    if [[ ! -d "$backup_dir" ]]; then install -d -m 700 -o 568 -g 568 -- "$backup_dir"; fi
    [[ ! -e "$target" ]] || fail "backup target already exists: $target"
    stop_for_consistency
    if ! docker run --rm --read-only --user 568:568 --cap-drop ALL --security-opt no-new-privileges \
      -v "$volume_name:/app/storage:ro" -v "$backup_dir:/backup" "$viewer_image" \
      sh -ceu 'cd /app/storage; tar -czf "/backup/$1" .' sh "$backup_file"; then
      restart_previous || true
      fail "backup failed"
    fi
    if ! (cd -- "$backup_dir" && sha256sum -- "$backup_file" > "$backup_file.sha256") || \
       ! chmod 600 -- "$target" "$target.sha256"; then
      restart_previous || true
      fail "backup archive was created, but checksum or permission finalization failed"
    fi
    restart_previous
    echo "backup complete: $target"
    ;;
  restore)
    [[ "$confirmation" == CONFIRM_RESTORE ]] || fail "restore requires: $0 restore /absolute/backup.tar.gz CONFIRM_RESTORE"
    [[ "$target" == /* && "$target" == *.tar.gz && -r "$target" ]] || fail "restore archive must be a readable absolute .tar.gz path"
    [[ -r "$target.sha256" ]] || fail "missing checksum file: $target.sha256"
    (cd -- "$(dirname -- "$target")" && sha256sum -c -- "$(basename -- "$target").sha256")
    restore_dir="$(dirname -- "$target")"; restore_file="$(basename -- "$target")"
    stop_for_consistency
    if ! docker run --rm --read-only --user 0:0 --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --security-opt no-new-privileges \
      -v "$volume_name:/app/storage" -v "$restore_dir:/backup:ro" "$viewer_image" \
      sh -ceu '
        tar -tzf "/backup/$1" | while IFS= read -r item; do case "$item" in /*|../*|*/../*) echo "unsafe archive path: $item" >&2; exit 4;; esac; done
        find /app/storage -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
        tar -xzf "/backup/$1" -C /app/storage --no-same-owner
        chown -R 568:568 /app/storage
      ' sh "$restore_file"; then
      fail "restore failed; services remain stopped for operator inspection"
    fi
    restart_previous
    echo "restore complete: $target"
    ;;
  *) fail "usage: $0 diagnose | repair-ownership CONFIRM_UID_568 | backup /absolute/file.tar.gz | restore /absolute/file.tar.gz CONFIRM_RESTORE" ;;
esac
