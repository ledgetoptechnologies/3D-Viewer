#!/usr/bin/env python3
"""Rotate only the staging Viewer↔Nginx proxy shared secret, without printing it."""

from __future__ import annotations

import os
import re
import secrets
import stat
import tempfile
from pathlib import Path

ENV_PATH = Path("/home/bkoltz/3d-viewer-staging/config/viewer.env")
NGINX_PATH = Path("/home/bkoltz/3d-viewer-staging/config/nginx.conf")
ENV_RE = re.compile(r"(?m)^(PROXY_SHARED_SECRET=)([^\r\n]*)(\r?\n|$)")
NGINX_RE = re.compile(r"(?m)^(\s*proxy_set_header X-Viewer-Proxy-Secret )([^;\r\n]+)(;\s*)$")


def read_pair() -> tuple[str, str]:
    env_text = ENV_PATH.read_text(encoding="utf-8")
    nginx_text = NGINX_PATH.read_text(encoding="utf-8")
    env_matches = list(ENV_RE.finditer(env_text))
    nginx_matches = list(NGINX_RE.finditer(nginx_text))
    if len(env_matches) != 1 or len(nginx_matches) != 1:
        raise SystemExit("refusing rotation: expected exactly one proxy secret in both staging files")
    old_env, old_nginx = env_matches[0].group(2), nginx_matches[0].group(2).strip()
    if not old_env or old_env != old_nginx:
        raise SystemExit("refusing rotation: current staging proxy secrets do not match")
    return env_text, nginx_text


def atomic_write(path: Path, text: str) -> None:
    metadata = path.stat(follow_symlinks=False)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.chown(tmp_name, metadata.st_uid, metadata.st_gid)
        os.chmod(tmp_name, stat.S_IMODE(metadata.st_mode))
        os.replace(tmp_name, path)
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        try:
            os.unlink(tmp_name)
        except FileNotFoundError:
            pass


def main() -> None:
    if os.geteuid() != 0:
        raise SystemExit("run with sudo on the staging host")
    env_text, nginx_text = read_pair()
    secret = secrets.token_hex(32)
    env_new = ENV_RE.sub(lambda m: f"{m.group(1)}{secret}{m.group(3)}", env_text, count=1)
    nginx_new = NGINX_RE.sub(lambda m: f"{m.group(1)}{secret}{m.group(3)}", nginx_text, count=1)
    try:
        atomic_write(ENV_PATH, env_new)
        atomic_write(NGINX_PATH, nginx_new)
        # Validate the committed pair without emitting either value.
        _, _ = read_pair()
    except BaseException:
        # Best-effort all-or-nothing recovery if the second replacement or
        # validation fails. The pre-change root-only backup remains available.
        atomic_write(ENV_PATH, env_text)
        atomic_write(NGINX_PATH, nginx_text)
        raise
    print("staging proxy secret rotated; value not displayed")


if __name__ == "__main__":
    main()
