#!/usr/bin/env bash
set -euo pipefail

compose_dir="${1:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
viewer_config="${VIEWER_ENV_FILE:-/mnt/Plugins/App_Data/Model-Viewer/Config/viewer.env}"
profile="${2:-}"
cd -- "$compose_dir"

compose_args=(--env-file "$viewer_config")
if [[ "$profile" == "processing" ]]; then
  compose_args+=(--profile processing)
elif [[ -n "$profile" ]]; then
  echo "usage: $0 [compose-directory] [processing]" >&2
  exit 2
fi

docker compose "${compose_args[@]}" pull
docker compose "${compose_args[@]}" up -d --remove-orphans
docker compose "${compose_args[@]}" ps
