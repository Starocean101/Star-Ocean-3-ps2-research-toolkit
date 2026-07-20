#!/usr/bin/env python3
import hashlib, importlib.util, json, pathlib, tempfile, zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('hybrid', ROOT / '02_SOURCE' / 'so3_hybrid_bundle.py')
hybrid = importlib.util.module_from_spec(spec); spec.loader.exec_module(hybrid)
payload = b'original guest bytes\0\1\2'
digest = hashlib.sha256(payload).hexdigest()
report = {'format': hybrid.RESPONSE, 'request': {'request_id': 'fixture'}, 'members': [{'path': 'iso_ranges/a.bin', 'size': len(payload), 'sha256': digest}], 'total_payload_bytes': len(payload), 'errors': [], 'complete': True}
report_bytes = json.dumps(report).encode()
with tempfile.TemporaryDirectory() as td:
    path = pathlib.Path(td) / 'response.zip'
    with zipfile.ZipFile(path, 'w') as z:
        z.writestr('iso_ranges/a.bin', payload)
        z.writestr('SO3_HYBRID_DATA_RESPONSE.json', report_bytes)
        z.writestr('SHA256SUMS.txt', f'{digest}  iso_ranges/a.bin\n{hashlib.sha256(report_bytes).hexdigest()}  SO3_HYBRID_DATA_RESPONSE.json\n')
    result = hybrid.validate(path, pathlib.Path(td) / 'out')
    assert result['status'] == 'PASS' and result['complete'] and result['members'] == 1
print('V5.12.8 hybrid response validation: PASS')
