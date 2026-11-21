"""Review fix: a command that never stops printing is cut and killed."""
import base64
import os
import stat
import sys
import tempfile
import time
import unittest
import urllib.parse

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import bolt_app_kit as k  # noqa: E402


class Runaway(unittest.TestCase):
    def test_endless_output_is_cut_and_killed(self):
        t0 = time.time()
        if os.name == "nt":
            cmd = [sys.executable, "-c", "import sys\nwhile True:\n sys.stdout.write('y'*4096)\n sys.stdout.flush()"]
        else:
            cmd = ["yes"]
        r = k.run(cmd, timeout=10, max_bytes=5000)
        self.assertFalse(r.ok)
        self.assertEqual(r.reason, "output too large")
        self.assertLess(time.time() - t0, 5)
        self.assertLessEqual(len(r.out), 5000)



if __name__ == "__main__":
    unittest.main()
