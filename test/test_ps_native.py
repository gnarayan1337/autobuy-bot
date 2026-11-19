import io
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import ps_native as host


class NativeBridge(unittest.TestCase):
    def test_stale_or_conflicting_attempt(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(host, 'WORK', Path(tmp)):
            Path(tmp, 'state.json').write_text(json.dumps(dict(phase='alerted', stock='available', sku=host.SKU, checkedAt='new')))
            self.assertFalse(host.claim('old'))
            self.assertTrue(host.claim('new'))
            self.assertFalse(host.claim('new'))
            self.assertEqual(json.loads(Path(tmp, 'cart-attempt.json').read_text())['sku'], host.SKU)

    def test_same_sku_unavailable_is_not_a_trigger(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(host, 'WORK', Path(tmp)):
            Path(tmp, 'state.json').write_text(json.dumps(dict(phase='watching', stock='unavailable', sku=host.SKU, checkedAt='now')))
            self.assertFalse(host.claim('now'))

    def test_chrome_framing_and_claim_sequence(self):
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, 'state.json').write_text(json.dumps(dict(phase='alerted',stock='available',sku=host.SKU,checkedAt='drop')))
            cmd = [sys.executable, '-B', '-c', 'import ps_native as h,sys; from pathlib import Path; h.WORK=Path(sys.argv[1]);h.bridge()', tmp]
            requests = [json.dumps(dict(type='claim',id=str(i),checkedAt='drop')).encode() for i in range(2)]
            out = subprocess.run(cmd, cwd=host.ROOT/'src', input=b''.join(host.FRAME.pack(len(b))+b for b in requests),
                                 timeout=5, capture_output=True, check=True).stdout
            stream=io.BytesIO(out)
            msgs=[]
            while prefix:=stream.read(4):
                msgs.append(json.loads(stream.read(struct.unpack('=I',prefix)[0])))
            self.assertEqual(msgs[0]['type'],'stock')
            self.assertEqual([m['ok'] for m in msgs[1:]],[True,False])

    def test_rejects_other_origin(self):
        proc=subprocess.run([sys.executable,'-B',host.__file__,'chrome-extension://wrong/'],capture_output=True)
        self.assertNotEqual(proc.returncode,0)
        self.assertEqual(proc.stdout,b'')
