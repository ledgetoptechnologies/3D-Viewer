#!/usr/bin/env python3
"""Consistent, root-private evidence backup before the manual Viewer rollout."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess

ROOT = Path('/home/bkoltz/3d-viewer-staging')


def command(*args):
    return subprocess.check_output(args, text=True, timeout=30).strip()


def main():
    if os.geteuid() != 0 or command('hostname') != 'staging':
        raise SystemExit('Root on the explicitly identified staging host is required.')
    command('/usr/local/libexec/viewer-staging-storage-check')
    if command('systemctl', 'is-active', 'viewer-staging.service') != 'active':
        raise SystemExit('The supervised staging baseline must be active before backup.')
    if ROOT.resolve() != ROOT or not (ROOT / 'storage/data/viewer.sqlite').is_file():
        raise SystemExit('Expected staging database path is unavailable.')
    containers = []
    for service in ('viewer-api', 'viewer-worker', 'viewer-proxy'):
        item = json.loads(command('docker', 'inspect', f'viewer-staging-{service}-1'))[0]
        if item['State'].get('Health', {}).get('Status') != 'healthy':
            raise SystemExit(f'{service} is not a healthy baseline.')
        containers.append({'name': item['Name'], 'imageId': item['Image'],
                           'imageReference': item['Config']['Image'],
                           'revision': item['Config'].get('Labels', {}).get('org.opencontainers.image.revision'),
                           'mounts': item['Mounts'], 'state': item['State'],
                           'networks': item['NetworkSettings']['Networks']})
    os.umask(0o077)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    completed = ROOT / 'backups' / f'pre-provider-rollout-{stamp}'
    destination = completed.with_name(completed.name + '.partial')
    destination.mkdir(mode=0o700, parents=True, exist_ok=False)
    with sqlite3.connect(f'file:{ROOT}/storage/data/viewer.sqlite?mode=ro', uri=True) as live:
        checks = {'dataset_operations': "status IN ('queued','leased','awaiting_derivatives')",
                  'processing_attempts': "status NOT IN ('failed','cancelled','published','ready_for_review')",
                  'processing_jobs': "status IN ('pending','leased')",
                  'derivative_jobs': "status IN ('pending','leased')",
                  'upload_sessions': "status IN ('open','finalizing')",
                  'measurement_calculation_jobs': "status IN ('queued','running')",
                  'ephemeral_measurement_jobs': "status IN ('queued','running')"}
        for table, condition in checks.items():
            if live.execute(f'SELECT COUNT(*) FROM {table} WHERE {condition}').fetchone()[0]:
                raise SystemExit(f'Active {table} require separate coordination; refusing backup gate.')
        with sqlite3.connect(str(destination / 'viewer.sqlite')) as snapshot:
            live.backup(snapshot)
            if snapshot.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise SystemExit('Snapshot integrity failed.')
            schema = snapshot.execute('SELECT MAX(version) FROM schema_migrations').fetchone()[0]
    for relative, name in (('compose.yaml', 'compose.yaml'), ('config/viewer.env', 'viewer.env'),
                           ('config/nginx.conf', 'nginx.conf'), ('config/tls.crt', 'tls.crt'),
                           ('config/tls.key', 'tls.key'), ('config/staging-storage-guard.cjs', 'staging-storage-guard.cjs')):
        source = ROOT / relative
        if source.is_symlink() or not source.is_file():
            raise SystemExit('Configuration path is not a regular staging file.')
        shutil.copyfile(source, destination / name)
    captures = {'service-unit.txt': command('systemctl', 'cat', 'viewer-staging.service'),
                'ipv4-firewall.txt': command('iptables-save'),
                'ipv6-firewall.txt': command('ip6tables-save'),
                'asset-mount.txt': command('findmnt', '-n', '-o', 'TARGET,FSTYPE,SOURCE,OPTIONS', '-T', '/mnt/ViewerStaging/cache'),
                'local-data-mount.txt': command('findmnt', '-n', '-o', 'TARGET,FSTYPE,SOURCE', '-T', str(ROOT / 'storage/data')),
                'unrelated-containers.txt': command('docker', 'ps', '--format', '{{.Names}} {{.Status}}')}
    for name, body in captures.items():
        (destination / name).write_text(body + '\n')
    manifest = {'backupMethod': 'SQLite online backup API', 'integrity': 'ok', 'schemaVersion': schema,
                'createdAt': stamp, 'runtime': containers,
                'sha256': {entry.name: hashlib.sha256(entry.read_bytes()).hexdigest()
                           for entry in sorted(destination.iterdir())}}
    (destination / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    for entry in destination.iterdir():
        os.chmod(entry, 0o600)
    destination.rename(completed)
    # Only the location and integrity summary are emitted; backup contents stay private.
    print(json.dumps({'backupPath': str(completed), 'integrity': 'ok', 'schemaVersion': schema,
                      'fileCount': len(manifest['sha256'])}))


if __name__ == '__main__':
    main()
