"""Independent stdlib audit of native bundles and the real HTTP adapter."""
import hashlib
import http.client
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import sys
import tempfile
import time
import unittest
import zlib

CORE, SERVER = sys.argv[1:3]
del sys.argv[1:3]


def unpack(data, magic):
    assert data[:8] == magic
    length, count = struct.unpack_from('<II', data, 8)
    assert 0 < length <= 1024 * 1024
    manifest = json.loads(data[16:16 + length])
    assert manifest['version'] == 1
    assert len(manifest['files']) == count
    start = 16 + (length + 7) // 8 * 8
    assert not any(data[16 + length:start])
    files, cursor = {}, 0
    for entry in manifest['files']:
        name, offset, size = entry['name'], entry['offset'], entry['bytes']
        assert name not in files and '/' not in name and '\\' not in name
        assert offset == cursor and offset % 8 == 0 and size > 0
        body = data[start + offset:start + offset + size]
        assert len(body) == size and hashlib.sha256(body).hexdigest() == entry['sha256']
        files[name] = body
        cursor = (offset + size + 7) // 8 * 8
        assert not any(data[start + offset + size:start + cursor])
    assert len(data) == start + cursor
    return manifest, files


def multipart(fields):
    boundary = 'triastasis-synthetic-contract'
    result = bytearray()
    for key, value in fields.items():
        result.extend(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"'.encode())
        if key in ('image', 'generation_data', 'texture_option'):
            result.extend(b'; filename="synthetic.png"\r\nContent-Type: image/png')
        result.extend(b'\r\n\r\n' + (value if isinstance(value, bytes) else str(value).encode()) + b'\r\n')
    result.extend(f'--{boundary}--\r\n'.encode())
    return bytes(result), f'multipart/form-data; boundary={boundary}'


class Contract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='generation-data-contract-', dir=Path(CORE).resolve().parent)
        cls.root = Path(cls.temp.name)
        subprocess.run([CORE, str(cls.root)], check=True)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            cls.port = sock.getsockname()[1]
        cls.log = (cls.root / 'server.log').open('wb')
        native_temp = cls.root / 'native-temp'
        cls.native_temp = native_temp
        native_temp.mkdir()
        environment = dict(os.environ, TEMP=str(native_temp), TMP=str(native_temp))
        cls.server = subprocess.Popen([SERVER, '--port', str(cls.port), '--host', '127.0.0.1',
                                       '--res', '512', '--models', str(cls.root / 'models')],
                                      stdout=cls.log, stderr=cls.log, env=environment)
        try:
            last_error = ''
            for _ in range(100):
                try:
                    response = cls.request('GET', '/health')
                    if response[0] == 200:
                        return
                    last_error = repr(response)
                except OSError as error:
                    last_error = repr(error)
                if cls.server.poll() is not None:
                    raise RuntimeError('test server exited: ' + (cls.root / 'server.log').read_text())
                time.sleep(.05)
            raise RuntimeError('test server did not start: ' + last_error + '\n' + (cls.root / 'server.log').read_text())
        except BaseException:
            cls.tearDownClass()
            raise

    @classmethod
    def tearDownClass(cls):
        cls.server.terminate()
        cls.server.wait(timeout=10)
        cls.log.close()
        cls.temp.cleanup()

    @classmethod
    def request(cls, method, path, fields=None, headers=None, read_body=True):
        body, content_type = multipart(fields) if fields is not None else (None, None)
        connection = http.client.HTTPConnection('127.0.0.1', cls.port, timeout=30)
        try:
            request_headers = dict(headers or {})
            if content_type:
                request_headers['Content-Type'] = content_type
            connection.request(method, path, body=body, headers=request_headers)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read() if read_body else b''
        finally:
            connection.close()

    def test_bundle_round_trip_and_provenance(self):
        manifest, files = unpack((self.root / 'generation.trg').read_bytes(), b'TRGST001')
        self.assertEqual(manifest['profile'], 'textured-512-v1')
        self.assertEqual(manifest['generation_seed'], 42)
        self.assertEqual(manifest['hierarchy_counts'], [2, 4, 8, 16, 32])
        self.assertEqual(len(files), 11)
        self.assertEqual(manifest['array_order'], 'item-major')
        for name, digest in manifest['model_provenance'].items():
            self.assertEqual(digest, hashlib.sha256((self.root / 'models' / name).read_bytes()).hexdigest())
        self.assertEqual(manifest['source_glb_sha256'], hashlib.sha256((self.root / 'model.glb').read_bytes()).hexdigest())
        self.assertEqual(manifest['source_surface_sha256'], hashlib.sha256(files['surface.mesh']).hexdigest())
        self.assertEqual(manifest['numeric']['texture_flow_backend'], 'cpu')
        self.assertEqual(manifest['numeric']['texture_decode_backend'], 'cpu')
        # Column-major transform maps native (x,y,z) into glTF (x,z,-y).
        m = manifest['to_asset_transform']
        self.assertEqual(tuple(sum(m[col * 4 + row] * (1,2,3,1)[col] for col in range(4)) for row in range(4)), (1,3,-2,1))
        shape = struct.unpack('<64f', files['shape.norm.f32'])
        self.assertEqual(shape, tuple(i / 8 for i in range(64)))
        self.assertEqual(struct.unpack('<64f', files['original-noise.f32']), tuple(-i / 16 for i in range(64)))
        self.assertEqual(len(files['conditioning.f32']), 1029 * 1024 * 4)
        roots = list(struct.iter_unpack('<iii', files['roots.i32']))
        for level in range(4):
            mask = files[f'subdivision-{level}.u8']
            roots = [(x * 2 + (o & 1), y * 2 + ((o >> 1) & 1), z * 2 + ((o >> 2) & 1))
                     for p, (x, y, z) in enumerate(roots) for o in range(8) if mask[p * 8 + o]]
        reconstructed = b''.join(struct.pack('<iii', *c) for c in roots)
        self.assertEqual(manifest['coordinate_order_sha256'], hashlib.sha256(reconstructed).hexdigest())
        for name in ('surface.mesh', 'dense-snap.mesh'):
            vertices, faces = struct.unpack_from('<II', files[name])
            self.assertEqual((vertices, faces), (3, 1))
            self.assertAlmostEqual(struct.unpack_from('<f', files[name], 8)[0], -.6, places=6)
        # Independently decode the small PNG, including every alpha byte.
        png = files['cutout.png']; self.assertEqual(png[:8], b'\x89PNG\r\n\x1a\n')
        offset, compressed = 8, bytearray()
        while offset < len(png):
            size, kind = struct.unpack_from('>I4s', png, offset)
            content = png[offset + 8:offset + 8 + size]
            if kind == b'IHDR':
                self.assertEqual(struct.unpack('>IIBBBBB', content), (2, 2, 8, 6, 0, 0, 0))
            if kind == b'IDAT': compressed.extend(content)
            offset += 12 + size
        raw = zlib.decompress(compressed)
        expected = bytes([10,20,30,0,40,50,60,255,70,80,90,128,100,110,120,255])
        decoded = bytearray(); prior = bytes(8)
        for row in range(2):
            kind = raw[row * 9]; current = bytearray(raw[row * 9 + 1:row * 9 + 9])
            for i in range(8):
                a, b, c = (current[i - 4] if i >= 4 else 0), prior[i], (prior[i - 4] if i >= 4 else 0)
                p = a + b - c
                predictor = min((a,b,c), key=lambda v: abs(p - v))
                current[i] = (current[i] + [0, a, b, (a + b) // 2, predictor][kind]) % 256
            decoded.extend(current); prior = current
        self.assertEqual(decoded, expected)

    def test_package_and_unsupported_capture(self):
        _, files = unpack((self.root / 'generation.trgpk').read_bytes(), b'TRGPK001')
        self.assertEqual(files['generation.trg'], (self.root / 'generation.trg').read_bytes())
        manifest, files = unpack((self.root / 'unsupported.trgpk').read_bytes(), b'TRGPK001')
        self.assertEqual(set(files), {'model.glb'})
        self.assertEqual(manifest['generation_data_error']['code'], 'unsupported_capture_profile')

    def test_model_digest_cache_invalidated_between_runs(self):
        manifest, _ = unpack((self.root / 'changed-between-runs.trg').read_bytes(), b'TRGST001')
        self.assertEqual(manifest['model_provenance']['ss_dec.gguf'], hashlib.sha256(b'abcd').hexdigest())

    def test_capture_and_package_failures_keep_the_glb(self):
        status, _, body = self.request('POST', '/generate', {'image': 'invalid-shape', 'save_generation_data': 'on'})
        self.assertEqual(status, 200)
        manifest, files = unpack(body, b'TRGPK001')
        self.assertEqual(manifest['generation_data_error']['code'], 'generation_data_capture_failed')
        self.assertEqual(files['model.glb'], (self.root / 'model.glb').read_bytes())
        self.assertNotIn('generation.trg', files)
        status, headers, body = self.request('POST', '/generate', {'image': 'package-write-failure', 'save_generation_data': 'on'})
        self.assertEqual(status, 200)
        self.assertEqual(headers['Content-Type'], 'model/gltf-binary')
        self.assertEqual(headers['X-Triastasis-Generation-Data-Error'], 'generation_package_failed')
        self.assertEqual(body, (self.root / 'model.glb').read_bytes())

    def test_streamed_response_cleanup_including_disconnect(self):
        body, content_type = multipart({'image': 'synthetic', 'save_generation_data': 'on'})
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=30)
        try:
            connection.request('POST', '/generate', body=body, headers={'Content-Type': content_type})
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            response.read(16)
            response.close()
        finally:
            connection.close()
        for _ in range(100):
            if not list(self.native_temp.iterdir()):
                break
            time.sleep(.02)
        self.assertEqual(list(self.native_temp.iterdir()), [])

    def test_identity_describes_supported_routes(self):
        status, _, body = self.request('GET', '/identity')
        identity = json.loads(body)
        self.assertEqual(status, 200)
        self.assertEqual((identity['service'], identity['identityVersion']), ('trellis-server', 1))
        self.assertEqual(identity['generationDataVersions'], [1])
        self.assertEqual(identity['textureOptionsVersion'], 1)

    def test_texture_replay_and_selected_field_bake(self):
        bundle = (self.root / 'generation.trg').read_bytes()
        status, _, body = self.request('POST', '/retexture', {'generation_data': bundle, 'seed': 7, 'request_id': 'replay-contract'})
        self.assertEqual(status, 200)
        option, files = unpack(body, b'TROPT001')
        self.assertEqual(option['seed'], 7)
        self.assertEqual(option['generation_data_sha256'], hashlib.sha256(bundle).hexdigest())
        self.assertEqual(len(files['field.f32']), 32 * 6 * 4)
        status, headers, baked = self.request('POST', '/retexture/bake', {'generation_data': bundle, 'texture_option': body, 'atlas_size': 1024})
        self.assertEqual(status, 200)
        self.assertEqual(headers['Content-Type'], 'model/gltf-binary')
        self.assertEqual(baked, (self.root / 'model.glb').read_bytes())
        status, _, snapshot = self.request('GET', '/progress/replay-contract')
        self.assertEqual(json.loads(snapshot)['status'], 'succeeded')

    def test_invalid_replay_and_mismatched_selection_fail_before_inference(self):
        bundle = (self.root / 'generation.trg').read_bytes()
        for fields in [ {'generation_data': b'broken'}, {'generation_data': bundle, 'seed': 8, 'match_original_rng': 'on'} ]:
            status, _, body = self.request('POST', '/retexture', fields)
            self.assertEqual(status, 422)
            self.assertEqual(json.loads(body)['code'], 'generation_data_invalid')
        status, _, body = self.request('POST', '/retexture/bake', {'generation_data': (self.root / 'changed-between-runs.trg').read_bytes(), 'texture_option': (self.root / 'option.tropt').read_bytes()})
        self.assertEqual(status, 422)
        self.assertEqual(json.loads(body)['code'], 'generation_data_invalid')

    def test_old_client_response_unchanged(self):
        status, headers, body = self.request('POST', '/generate', {'image': 'synthetic', 'seed': 42})
        self.assertEqual(status, 200)
        self.assertEqual(headers['Content-Type'], 'model/gltf-binary')
        self.assertEqual(body, (self.root / 'model.glb').read_bytes())

    def test_opt_in_response_and_resolved_seed(self):
        status, headers, body = self.request('POST', '/generate', {'image': 'synthetic', 'seed': 0,
                                            'save_generation_data': 'on', 'request_id': 'capture-contract'})
        self.assertEqual(status, 200)
        self.assertEqual(headers['Content-Type'], 'application/vnd.triastasis.generation-package')
        _, files = unpack(body, b'TRGPK001')
        manifest, _ = unpack(files['generation.trg'], b'TRGST001')
        self.assertEqual(manifest['generation_seed'], 43)
        status, _, body = self.request('GET', '/progress/capture-contract')
        self.assertEqual(json.loads(body)['status'], 'succeeded')

    def test_unsupported_profiles_keep_the_glb(self):
        for field, value in [('resolution', 1024), ('texture', 'off')]:
            status, _, body = self.request('POST', '/generate', {'image': 'synthetic', 'save_generation_data': 'on', field: value})
            self.assertEqual(status, 200)
            manifest, files = unpack(body, b'TRGPK001')
            self.assertEqual(manifest['generation_data_error']['code'], 'unsupported_capture_profile')
            self.assertEqual(set(files), {'model.glb'})

    def test_validation_and_origin_checks_still_apply(self):
        status, _, _ = self.request('POST', '/generate', {'image': 'synthetic', 'save_generation_data': 'typo'})
        self.assertEqual(status, 400)
        status, _, _ = self.request('POST', '/generate', {'image': 'synthetic', 'save_generation_data': 'on'},
                                    {'Origin': 'https://unrelated.example'}, read_body=False)
        self.assertEqual(status, 403)


if __name__ == '__main__':
    unittest.main(verbosity=2)
