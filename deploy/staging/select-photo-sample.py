#!/usr/bin/env python3
"""Inspect JPEG EXIF headers; extract only an explicitly selected small sample."""
import argparse
import hashlib
import json
import re
import struct
import zipfile
from datetime import datetime
from pathlib import Path


def capture_time(header):
    offset = header.find(b'Exif\x00\x00')
    if offset < 0:
        return None
    data = header[offset + 6:]
    if data[:2] not in (b'II', b'MM'):
        return None
    endian = '<' if data[:2] == b'II' else '>'
    def number(fmt, position):
        return struct.unpack_from(endian + fmt, data, position)[0]
    def directory(position):
        result = {}
        for index in range(min(number('H', position), 1024)):
            entry = position + 2 + index * 12
            tag, kind = number('H', entry), number('H', entry + 2)
            count = number('I', entry + 4)
            value = entry + 8 if count <= 4 else number('I', entry + 8)
            if kind == 2:
                result[tag] = data[value:value + min(count, 1024)].rstrip(b'\x00').decode('ascii', errors='replace')
            elif kind == 4 and count == 1:
                result[tag] = number('I', entry + 8)
        return result
    try:
        tags = directory(number('I', 4))
        exif = directory(tags[0x8769]) if 0x8769 in tags else {}
        raw = exif.get(0x9003)
        if not raw or not re.fullmatch(r'\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}', raw):
            return None
        return datetime.strptime(raw, '%Y:%m:%d %H:%M:%S'), str(tags.get(0x110, 'unknown'))
    except (ValueError, KeyError, struct.error):
        return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--archive', required=True)
    parser.add_argument('--output')
    parser.add_argument('--count', type=int, default=15, choices=range(10, 16))
    args = parser.parse_args()
    with zipfile.ZipFile(args.archive) as archive:
        candidates = []
        for item in archive.infolist():
            if 'images/survey/' not in item.filename.lower() or not item.filename.lower().endswith(('.jpg', '.jpeg')):
                continue
            with archive.open(item) as stream:
                timestamp = capture_time(stream.read(128 * 1024))
            if timestamp:
                candidates.append((*timestamp, item))
        candidates.sort(key=lambda row: (row[0], row[2].filename))
        selected = None
        for start in range(len(candidates) - args.count + 1):
            group = candidates[start:start + args.count]
            gaps = [(b[0] - a[0]).total_seconds() for a, b in zip(group, group[1:])]
            if len({row[1] for row in group}) == 1 and all(0 < gap <= 10 for gap in gaps):
                selected = group
                break
        if selected is None:
            raise SystemExit('No consecutive capture-time sample found; do not upload arbitrary hashed entries.')
        names = [Path(row[2].filename).name for row in selected]
        if len({name.casefold() for name in names}) != len(names):
            raise SystemExit('Selected sample has duplicate destination names; no files were extracted.')
        if any(row[2].file_size > 64 * 1024 * 1024 for row in selected) or sum(row[2].file_size for row in selected) > 512 * 1024 * 1024:
            raise SystemExit('Selected sample exceeds bounded extraction size; no files were extracted.')
        receipt = {'archive': str(Path(args.archive).resolve()), 'count': args.count,
                   'selection': 'consecutive EXIF DateTimeOriginal; visual overlap still requires review', 'files': []}
        output = Path(args.output).resolve() if args.output else None
        if output:
            output.mkdir(parents=True, exist_ok=False)
        for at, model, item in selected:
            entry = {'archivePath': item.filename, 'name': Path(item.filename).name,
                     'capturedAt': at.isoformat(), 'cameraModel': model, 'byteSize': item.file_size}
            if output:
                body = archive.read(item)
                entry['sha256'] = hashlib.sha256(body).hexdigest()
                (output / entry['name']).write_bytes(body)
            receipt['files'].append(entry)
        if output:
            (output / 'sample-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
        print(json.dumps(receipt, indent=2))


if __name__ == '__main__':
    main()
