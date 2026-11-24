"""store_append on the Windows branch (no fcntl, msvcrt.locking), exercised with a fake msvcrt so it runs on Linux CI."""
import errno
import importlib.util
import os
import sys
import tempfile
import types
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", "examples", "portal-template", "scripts"))
SHARED_ENGINE = os.path.abspath(os.path.join(HERE, "..", "bolt_app_engine.py"))   # the engine is kept once; the example app holds only a thin entry


def load_engine():
    spec = importlib.util.spec_from_file_location("portal_engine_win", SHARED_ENGINE)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def fake_msvcrt(fail_first=0, err=errno.EDEADLK, always=False):
    m = types.SimpleNamespace(LK_LOCK=1, LK_UNLCK=0, calls=[])

    def locking(fd, mode, nbytes):
        m.calls.append(mode)
        if mode == m.LK_LOCK and (always or m.calls.count(m.LK_LOCK) <= fail_first):
            raise OSError(err, "locked")
    m.locking = locking
    return m


class WindowsBranch(unittest.TestCase):
    def setUp(self):
        self.eng = load_engine()
        self.fm = {"store": {"file": os.path.join(tempfile.mkdtemp(), "log.jsonl"), "max_rows": 50}}
        self.sleep = mock.patch.object(self.eng.time, "sleep")
        self.sleep.start()
        self.addCleanup(self.sleep.stop)

    def run_with(self, ms):
        with mock.patch.dict(sys.modules, {"fcntl": None, "msvcrt": ms}):
            self.eng.store_append(self.fm, {"i": 1})

    def test_lock_is_taken_and_released(self):
        ms = fake_msvcrt()
        self.run_with(ms)
        self.assertEqual(ms.calls, [ms.LK_LOCK, ms.LK_UNLCK])
        self.assertEqual(self.eng.store_read(self.fm), [{"i": 1}])

    def test_contention_is_retried_then_succeeds(self):
        ms = fake_msvcrt(fail_first=2, err=errno.EACCES)
        self.run_with(ms)
        self.assertEqual(ms.calls, [ms.LK_LOCK] * 3 + [ms.LK_UNLCK])
        self.assertEqual(self.eng.store_read(self.fm), [{"i": 1}])

    def test_persistent_failure_raises_and_saves_nothing(self):
        ms = fake_msvcrt(always=True)
        with self.assertRaises(OSError):
            self.run_with(ms)
        self.assertEqual(ms.calls.count(ms.LK_LOCK), 5)
        self.assertNotIn(ms.LK_UNLCK, ms.calls)
        self.assertEqual(self.eng.store_read(self.fm), [])

    def test_permission_error_on_replace_is_retried(self):
        ms = fake_msvcrt()
        real = os.replace
        n = {"c": 0}

        def flaky(a, b):
            n["c"] += 1
            if n["c"] < 3:
                raise PermissionError(errno.EACCES, "in use")
            return real(a, b)
        with mock.patch.object(self.eng.os, "replace", flaky):
            self.run_with(ms)
        self.assertEqual(n["c"], 3)
        self.assertEqual(ms.calls, [ms.LK_LOCK, ms.LK_UNLCK])
        self.assertEqual(self.eng.store_read(self.fm), [{"i": 1}])

    def test_permission_error_on_replace_persists_raises(self):
        ms = fake_msvcrt()

        def never(a, b):
            raise PermissionError(errno.EACCES, "in use")
        with mock.patch.object(self.eng.os, "replace", never):
            with self.assertRaises(PermissionError):
                self.run_with(ms)
        self.assertEqual(ms.calls, [ms.LK_LOCK, ms.LK_UNLCK])


if __name__ == "__main__":
    unittest.main()
