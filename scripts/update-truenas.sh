#!/usr/bin/env bash
set -euo pipefail

compose_dir="${1:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
cd -- "$compose_dir"

docker compose pull
docker compose up -d --remove-orphans
docker compose ps
