import os, stat, sys, tempfile, time, unittest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import bolt_app_kit as k
import importlib
P = importlib.import_module("bolt_app_kit.probe")

SH = "/bin/sh"


def stub(d, name, body):
    p = os.path.join(d, name)
    with open(p, "w") as f:
        f.write("#!/bin/sh\n" + body + "\n")
    os.chmod(p, 0o755)
    return p


@unittest.skipIf(os.name == "nt", "POSIX stubs")
class RunTests(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.addCleanup(lambda: __import__("shutil").rmtree(self.d, ignore_errors=True))

    def test_ok_and_output(self):
        stub(self.d, "hi", "echo hello")
        ok, rc, out = k.run(["hi"], dirs=[self.d])
        self.assertEqual((ok, rc, out), (True, 0, "hello\n"))

    def test_missing_program_does_not_raise(self):
        r = k.run(["no-such-prog-xyz"], dirs=[self.d])
        self.assertFalse(r.ok); self.assertTrue(r.missing); self.assertIsNone(r.rc)

    def test_string_command_is_a_bug(self):
        with self.assertRaises(TypeError):
            k.run("ls -l")

    def test_nonzero_exit_with_no_output_is_not_success(self):  # defect 4
        stub(self.d, "bad", "exit 2")
        self.assertFalse(k.run(["bad"], dirs=[self.d]).ok)

    def test_nonzero_exit_with_output_is_still_failure(self):
        stub(self.d, "bad", "echo partial; exit 2")
        self.assertFalse(k.run(["bad"], dirs=[self.d]).ok)

    def test_legit_exit_one_with_nothing_to_list(self):  # defect 4, lsof / defaults read
        stub(self.d, "lsof", "exit 1")
        self.assertTrue(k.run(["lsof"], dirs=[self.d], empty_ok_rcs=(1,)).ok)
        stub(self.d, "lsof2", "echo error text; exit 1")
        self.assertFalse(k.run(["lsof2"], dirs=[self.d], empty_ok_rcs=(1,)).ok)

    def test_timeout_never_raises_and_is_not_ok(self):  # defect 1, 6
        stub(self.d, "hang", "sleep 30")
        t0 = time.monotonic()
        r = k.run(["hang"], dirs=[self.d], timeout=0.5)
        self.assertFalse(r.ok); self.assertTrue(r.timed_out)
        self.assertLess(time.monotonic() - t0, 5)

    def test_timeout_kills_the_whole_tree(self):
        marker = os.path.join(self.d, "child-alive")
        stub(self.d, "tree", "(sleep 3; echo x > %s) &\nsleep 30" % marker)
        k.run(["tree"], dirs=[self.d], timeout=0.4)
        time.sleep(3.5)
        self.assertFalse(os.path.exists(marker), "grandchild survived the timeout")

    def test_shared_deadline_bounds_total_time(self):  # defect 6
        stub(self.d, "hang", "sleep 30")
        dl = k.Deadline(1.0)
        t0 = time.monotonic()
        rs = [k.run(["hang"], dirs=[self.d], deadline=dl) for _ in range(5)]
        self.assertLess(time.monotonic() - t0, 4)
        self.assertTrue(all(not r.ok and r.timed_out for r in rs))

    def test_expired_deadline_does_not_start(self):
        stub(self.d, "x", "touch %s/ran" % self.d)
        dl = k.Deadline(0.0)
        r = k.run(["x"], dirs=[self.d], deadline=dl)
        self.assertTrue(r.timed_out); self.assertFalse(os.path.exists(os.path.join(self.d, "ran")))

    def test_dirs_option_ignores_path(self):
        stub(self.d, "onlyhere", "echo a")
        self.assertIsNone(k.which("onlyhere", dirs=["/nonexistent"]))
        self.assertTrue(k.which("onlyhere", dirs=[self.d]))

    def test_empty_env_works(self):  # defect 5: no PATH assumed beyond the controlled one
        stub(self.d, "e", 'echo "[$HOME]"')
        r = k.run(["e"], dirs=[self.d], env={})
        self.assertTrue(r.ok); self.assertEqual(r.out.strip(), "[]")

    def test_windows_branch_uses_taskkill_tree(self):
        log = os.path.join(self.d, "taskkill.log")
        stub(self.d, "taskkill", 'echo "$@" > %s' % log)
        stub(self.d, "hang", "sleep 30")
        old = os.environ["PATH"]
        os.environ["PATH"] = self.d + os.pathsep + old
        try:
            proc = P.subprocess.Popen([os.path.join(self.d, "hang")], start_new_session=True)
            P._kill_tree(proc, "windows")
            proc.wait(timeout=5)
        finally:
            os.environ["PATH"] = old
        self.assertEqual(open(log).read().split(), ["/PID", str(proc.pid), "/T", "/F"])


class ProbeTests(unittest.TestCase):
    def test_failed_probe_is_unread_not_zero(self):  # defect 1
        p = k.probe("n", fn=lambda: None)
        self.assertTrue(p.unread); self.assertIsNone(p.value); self.assertEqual(p.get(7), 7)

    def test_parser_error_is_unread(self):
        d = tempfile.mkdtemp()
        stub(d, "c", "echo abc")
        p = k.probe("n", ["c"], parse=int, dirs=[d])
        self.assertTrue(p.unread)

    def test_empty_output_unread_when_required(self):
        d = tempfile.mkdtemp()
        stub(d, "c", "true")
        self.assertTrue(k.probe("n", ["c"], dirs=[d], require_output=True).unread)
        self.assertTrue(k.probe("n", ["c"], dirs=[d], require_output=False).ok)

    def test_run_parallel_marks_slow_task_unread(self):
        dl = k.Deadline(0.5)
        res = k.run_parallel({"fast": lambda: k.Probe("fast", True, 1), "slow": lambda: (time.sleep(5), k.Probe("slow", True, 2))[1]}, dl)
        self.assertTrue(res["fast"].ok); self.assertTrue(res["slow"].unread and res["slow"].timed_out)

    def test_empty_output_is_unread_by_default(self):  # a clean zero from nothing
        d = tempfile.mkdtemp(); stub(d, "c", "true")
        self.assertTrue(k.probe("n", ["c"], parse=lambda t: len(t.splitlines()), dirs=[d]).unread)

    def test_parser_type_error_is_unread_not_a_crash(self):
        d = tempfile.mkdtemp(); stub(d, "c", "x")
        self.assertTrue(k.probe("n", ["c"], parse=lambda t: int(None), dirs=[d]).unread)

    def test_oversize_output_is_not_ok(self):
        d = tempfile.mkdtemp(); stub(d, "c", "yes | head -c 5000")
        self.assertFalse(k.run(["c"], dirs=[d], max_bytes=100).ok)

    def test_no_deadline_still_bounded(self):
        import inspect
        self.assertEqual(P.DEFAULT_BUDGET, 14.0)
        self.assertIn("DEFAULT_BUDGET", inspect.getsource(P.run))

    def test_os_name(self):
        self.assertIn(k.os_name(), ("macos", "linux", "windows", "other"))


if __name__ == "__main__":
    unittest.main()
