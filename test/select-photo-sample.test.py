"""Isolated stdlib tests; run with python3 test/select-photo-sample.test.py."""
import contextlib
import hashlib
import importlib.util
import io
import json
import struct
import sys
import tempfile
import unittest
import zipfile
from datetime import datetime, timedelta
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / 'deploy/staging/select-photo-sample.py'
SPEC = importlib.util.spec_from_file_location('select_photo_sample', SCRIPT)
SELECTOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SELECTOR)
BASE_TIME = datetime(2026, 10, 4, 12, 0, 0)


def photo(index, endian='<'):
    """Minimal JPEG APP1 with Model and Exif DateTimeOriginal TIFF entries."""
    model = b'DJI M4E\x00'
    date = (BASE_TIME + timedelta(seconds=index)).strftime('%Y:%m:%d %H:%M:%S').encode() + b'\x00'
    entry = lambda tag, kind, count, value: struct.pack(endian + 'HHII', tag, kind, count, value)
    tiff = (b'II' if endian == '<' else b'MM') + struct.pack(endian + 'HI', 42, 8)
    tiff += struct.pack(endian + 'H', 2)
    tiff += entry(0x0110, 2, len(model), 38) + entry(0x8769, 4, 1, 46)
    tiff += struct.pack(endian + 'I', 0) + model
    tiff += struct.pack(endian + 'H', 1) + entry(0x9003, 2, len(date), 64)
    tiff += struct.pack(endian + 'I', 0) + date
    app1 = b'Exif\x00\x00' + tiff
    return b'\xff\xd8\xff\xe1' + struct.pack('>H', len(app1) + 2) + app1 + bytes([index]) + b'\xff\xd9'


def invoke(archive, output, count):
    stdout = io.StringIO()
    argv = [str(SCRIPT), '--archive', str(archive), '--output', str(output), '--count', str(count)]
    with mock.patch.object(sys, 'argv', argv), contextlib.redirect_stdout(stdout):
        SELECTOR.main()
    return json.loads(stdout.getvalue())


class PhotoSampleTests(unittest.TestCase):
    def test_extracts_exact_count_and_matching_hashes_for_every_allowed_count(self):
        for count in range(10, 16):
            with self.subTest(count=count), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                archive, output = root / 'photos.zip', root / 'selected'
                bodies = {}
                with zipfile.ZipFile(archive, 'w') as bundle:
                    # Reverse insertion proves selection uses capture time, not ZIP order.
                    for index in reversed(range(17)):
                        name = f'flight/images/survey/photo-{index:02d}.JPG'
                        bodies[name] = photo(index)
                        bundle.writestr(name, bodies[name])
                    bundle.writestr('other/not-selected.jpg', photo(0))
                receipt = invoke(archive, output, count)
                self.assertEqual(receipt['count'], count)
                self.assertEqual(len(receipt['files']), count)
                self.assertEqual(len(list(output.glob('*.JPG'))), count)
                self.assertEqual(json.loads((output / 'sample-receipt.json').read_text()), receipt)
                for index, entry in enumerate(receipt['files']):
                    expected_name = f'flight/images/survey/photo-{index:02d}.JPG'
                    self.assertEqual(entry['archivePath'], expected_name)
                    self.assertEqual(entry['capturedAt'], (BASE_TIME + timedelta(seconds=index)).isoformat())
                    self.assertEqual(entry['cameraModel'], 'DJI M4E')
                    self.assertEqual(entry['byteSize'], len(bodies[expected_name]))
                    self.assertEqual((output / entry['name']).read_bytes(), bodies[expected_name])
                    self.assertEqual(entry['sha256'], hashlib.sha256(bodies[expected_name]).hexdigest())

    def test_duplicate_and_case_colliding_names_refused_before_output_creation(self):
        for second_name in ('same.JPG', 'SAME.jpg'):
            with self.subTest(second_name=second_name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                archive, output = root / 'photos.zip', root / 'not-created'
                with zipfile.ZipFile(archive, 'w') as bundle:
                    for index in range(10):
                        name = 'same.JPG' if index == 0 else second_name if index == 1 else f'photo-{index}.JPG'
                        bundle.writestr(f'flight-{index}/images/survey/{name}', photo(index))
                with self.assertRaisesRegex(SystemExit, 'duplicate destination names'):
                    invoke(archive, output, 10)
                self.assertFalse(output.exists())

    def test_per_image_and_total_limits_refused_without_extraction(self):
        # Advertised sizes are mocked so this guard test allocates no large files.
        for sizes in ([64 * 1024 * 1024 + 1] + [100] * 9, [52 * 1024 * 1024] * 10):
            with self.subTest(sizes=sizes), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                output = root / 'not-created'
                members, bodies = [], {}
                for index, size in enumerate(sizes):
                    item = zipfile.ZipInfo(f'flight/images/survey/photo-{index}.JPG')
                    item.file_size = size
                    members.append(item)
                    bodies[item.filename] = photo(index)
                bundle = mock.MagicMock()
                bundle.__enter__.return_value = bundle
                bundle.infolist.return_value = members
                bundle.open.side_effect = lambda item: io.BytesIO(bodies[item.filename])
                with mock.patch.object(SELECTOR.zipfile, 'ZipFile', return_value=bundle):
                    with self.assertRaisesRegex(SystemExit, 'bounded extraction size'):
                        invoke(root / 'mock.zip', output, 10)
                self.assertFalse(output.exists())
                bundle.read.assert_not_called()

    def test_valid_exif_both_byte_orders(self):
        for endian in ('<', '>'):
            with self.subTest(endian=endian):
                self.assertEqual(SELECTOR.capture_time(photo(1, endian)), (BASE_TIME + timedelta(seconds=1), 'DJI M4E'))

    def test_malformed_exif_returns_none(self):
        cases = [
            b'', b'not EXIF', b'Exif\x00\x00XX', b'Exif\x00\x00II',
            b'Exif\x00\x00II' + struct.pack('<HI', 42, 999999),
            b'Exif\x00\x00MM' + struct.pack('>HIH', 42, 8, 1),
            b'Exif\x00\x00II' + struct.pack('<HIH', 42, 8, 65535),
            photo(0).replace(b'2026:10:04', b'2026:99:04'),
            photo(0)[:40],
        ]
        for index, header in enumerate(cases):
            with self.subTest(index=index):
                self.assertIsNone(SELECTOR.capture_time(header))


if __name__ == '__main__':
    unittest.main()
