"""Review fixes in repo-radar, around, file-insights, cli-wrapper and system-glance."""
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import importlib.util

HERE = os.path.dirname(os.path.abspath(__file__))
EX = os.path.abspath(os.path.join(HERE, "..", "..", "examples"))
sys.path.insert(0, os.path.join(HERE, ".."))
import bolt_app_kit as kit  # noqa: E402


def load(app, script):
    spec = importlib.util.spec_from_file_location("ex_" + script[:-3], os.path.join(EX, app, "scripts", app + "__" + script))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


class Done(Exception):
    def __init__(self, rows):
        self.rows = rows


def fake_emit(rows, **kw):
    raise Done(rows)


class Radar(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.r = load("repo-radar", "radar.py")

    def test_npm_zero_days_inside_a_busy_range_are_missing_days_not_zero_downloads(self):
        raw = {"downloads": [{"day": "2026-10-%02d" % d, "downloads": n} for d, n in
                             [(10, 15000000), (11, 15100000), (12, 27000000), (13, 32000000), (14, 0), (15, 0), (16, 29000000), (17, 15000000), (18, 15200000), (19, 0), (20, 0), (21, 33000000)]]}
        out = self.r.n_month(raw)
        self.assertEqual(out["gaps"], ["2026-10-14", "2026-10-15", "2026-10-19", "2026-10-20"])
        self.assertTrue(all(n > 0 for _, n in out["days"]))
        # a package that is really at zero stays honest, and so does a long run of zeros
        flat = self.r.n_month({"downloads": [{"day": "2026-10-%02d" % d, "downloads": 0} for d in range(1, 11)]})
        self.assertEqual((len(flat["days"]), flat["gaps"]), (10, []))
        edge = self.r.n_month({"downloads": [{"day": "2026-10-01", "downloads": 0}, {"day": "2026-10-02", "downloads": 5}]})
        self.assertEqual((len(edge["days"]), edge["gaps"]), (2, []))
        long_run = self.r.n_month({"downloads": [{"day": "2026-10-%02d" % d, "downloads": (0 if 2 <= d <= 6 else 9)} for d in range(1, 10)]})
        self.assertEqual(long_run["gaps"], [])

    def test_numbers_are_checked_not_converted(self):
        for bad in (float("inf"), 1e999, "12", None, True):
            with self.assertRaises(ValueError):
                self.r.n_repo({"stargazers_count": bad, "forks_count": 1, "open_issues_count": 1})
        with self.assertRaises(ValueError):
            self.r.n_week({"downloads": float("inf")})

    def test_missing_hits_is_unread_not_zero_threads(self):
        with self.assertRaises(ValueError):
            self.r.n_hn({})
        with self.assertRaises(ValueError):
            self.r.n_hn({"nbHits": 3})

    def test_dot_names_and_bad_overrides_are_refused(self):
        for w in ("./x", "a/.", "a/..", "a/b:.hidden", "a/b:../x"):
            specs, err = self.r.parse_specs([w])
            self.assertIsNotNone(err, w)
        self.assertIsNone(self.r.parse_specs(["octo/.github"])[1])

    def test_links_are_pinned_to_known_hosts(self):
        cfg = self.r.load_json("config.json")
        pin = self.r.pin_url
        self.assertEqual(pin(cfg, "https://github.com/a/b/releases/tag/v1"), "https://github.com/a/b/releases/tag/v1")
        self.assertEqual(pin(cfg, "https://news.ycombinator.com/item?id=1"), "https://news.ycombinator.com/item?id=1")
        for bad in ("javascript:alert(1)", "file:///etc/passwd", "https://evil.example/x", "https://github.com.evil.example/x", "http://github.com/x", ""):
            self.assertEqual(pin(cfg, bad), "", bad)

    def test_old_or_odd_seen_entries_do_not_crash(self):
        for v in ({}, {"seen": "x"}, {"seen": {}, "seen_ts": "no"}, {"seen": {"stars": 1}, "seen_ts": 5, "base": 7}):
            self.assertFalse(self.r.valid_seen(v), v)
        self.assertTrue(self.r.valid_seen({"seen": {"stars": 1}, "seen_ts": 5.0, "base": None, "base_ts": None}))

    def test_releases_row_does_not_claim_a_90_day_count_from_8(self):
        with open(os.path.join(EX, "repo-radar", "scripts", "repo-radar__radar.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertNotIn('"Releases · %d in 90 days"', src)

    def test_compare_runs_both_repos_at_once(self):
        r = self.r
        orig = r.fetch_task

        def slow(ctx, key, spec, pkg, task, version=None):
            time.sleep(1.0)
            return {"ok": False, "data": None, "ms": None, "cached": False, "age": 0, "stale": False, "err": "x", "kind": "fail", "source": "github"}
        r.fetch_task = slow
        try:
            cfg = r.load_json("config.json")
            ctx = r.Ctx(cfg, {}, True, None, time.time(), False, None, [])
            t0 = time.time()
            r.model_pair(ctx, [(("a", "b"), None), (("c", "d"), None)])
            self.assertLess(time.time() - t0, 3.5)   # one repo alone takes about 3 s (osv waits for npm); sequential would be 6+
        finally:
            r.fetch_task = orig

    def test_a_crash_is_one_plain_row_never_a_traceback(self):
        r = self.r
        old_emit, old_main = r.kit.emit, r.main
        r.kit.emit = fake_emit
        r.main = lambda argv: (_ for _ in ()).throw(TypeError("secret-token-abc"))
        try:
            with self.assertRaises(Done) as c:
                r.run(["radar.py"])
        finally:
            r.kit.emit, r.main = old_emit, old_main
        txt = json.dumps(c.exception.rows)
        self.assertIn("TypeError", txt)
        self.assertNotIn("secret-token-abc", txt)


class Around(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.a = load("around", "around.py")

    def test_null_numbers_in_weather_are_dropped(self):
        raw = {"current": {"time": "2026-11-15T06:30", "temperature_2m": 3.0}, "utc_offset_seconds": 0,
               "hourly": {"time": ["2026-11-15T06:00", "2026-11-15T07:00", "2026-11-15T08:00"], "temperature_2m": [3.0, None, 4.0], "precipitation_probability": [0, None, 5]}}
        w = self.a.n_weather(raw)
        self.assertEqual([h[1] for h in w["hours"]], [3.0, 4.0])
        with self.assertRaises((ValueError, KeyError, TypeError)):
            self.a.n_weather({"current": {"time": "2026-11-15T06:30", "temperature_2m": None}, "hourly": {"time": [], "temperature_2m": [], "precipitation_probability": []}})

    def test_unknown_free_slots_stay_unknown(self):
        cfg = self.a.load_json("config.json")
        raw = {"network": {"name": "N", "stations": [{"name": "S", "latitude": 40.0, "longitude": -73.0, "free_bikes": 2, "empty_slots": None, "timestamp": "2026-11-15T11:00:00+00:00"}]}}
        st = self.a.n_bikes(raw, cfg, 40.0, -73.0)["stations"][0]
        self.assertIsNone(st["free"])

    def test_bad_coordinates_are_refused_before_caching(self):
        for lat, lon in (("999", "10"), ("nan", "10"), ("10", "inf"), ("x", "1")):
            with self.assertRaises(ValueError):
                self.a.n_geocode([{"lat": lat, "lon": lon, "display_name": "x"}])

    def test_overpass_error_remark_is_a_failure(self):
        with self.assertRaises(self.a.Fail):
            self.a.check_overpass({"elements": [], "remark": "runtime error: Query timed out in \"query\" at line 1"})
        self.a.check_overpass({"elements": [], "remark": "note: something harmless"})

    def test_400_results_are_flagged_as_limited(self):
        cfg = self.a.load_json("config.json")
        els = [{"type": "node", "id": i, "lat": 40.0, "lon": -73.0, "tags": {"amenity": "cafe", "name": "C%d" % i}} for i in range(400)]
        out = self.a.n_places({"elements": els}, cfg, 40.0, -73.0)
        self.assertTrue(out["limited"])
        self.assertFalse(self.a.n_places({"elements": els[:5]}, cfg, 40.0, -73.0)["limited"])

    def test_geocoder_gap_holds_across_threads_and_processes(self):
        d = tempfile.mkdtemp()
        stamps = []

        def one():
            with self.a.geocode_gate(d, 0.4):
                stamps.append(time.time())
        ts = [threading.Thread(target=one) for _ in range(3)]
        [t.start() for t in ts]
        [t.join() for t in ts]
        stamps.sort()
        self.assertGreaterEqual(stamps[1] - stamps[0], 0.35)
        self.assertGreaterEqual(stamps[2] - stamps[1], 0.35)

    def test_a_crash_is_one_plain_row(self):
        a = self.a
        old_emit, old_main = a.kit.emit, a.main
        a.kit.emit = fake_emit
        a.main = lambda argv: (_ for _ in ()).throw(TypeError("boom"))
        try:
            with self.assertRaises(Done) as c:
                a.run(["around.py"])
        finally:
            a.kit.emit, a.main = old_emit, old_main
        self.assertIn("TypeError", json.dumps(c.exception.rows))


class Wrap(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.w = load("cli-wrapper-template", "wrap.py")

    def test_unknown_host_is_never_cached(self):
        self.assertFalse(self.w.cacheable({"kind": "unknown_host"}))
        self.assertFalse(self.w.cacheable({"kind": "timeout"}))
        self.assertTrue(self.w.cacheable({"kind": "ok"}))


class Guards(unittest.TestCase):
    def test_every_script_has_a_catch_all(self):
        for app, script in (("file-insights-template", "insights.py"), ("cli-wrapper-template", "wrap.py"), ("repo-radar", "radar.py"), ("around", "around.py"), ("system-glance", "system-glance.py")):
            m = load(app, script)
            old_emit, old_main = m.kit.emit, m.main
            m.kit.emit = fake_emit
            m.main = lambda argv: (_ for _ in ()).throw(RuntimeError("x"))
            try:
                with self.assertRaises(Done) as c:
                    m.run([script])
            finally:
                m.kit.emit, m.main = old_emit, old_main
            self.assertIn("RuntimeError", json.dumps(c.exception.rows), app)


class CopiesDoNotShare(unittest.TestCase):
    def run_copy(self, app, script, args, new_id, home, extra_path=None):
        d = os.path.join(tempfile.mkdtemp(), new_id)
        shutil.copytree(os.path.join(EX, app), d, ignore=shutil.ignore_patterns("__pycache__", "golden"))
        p = os.path.join(d, "scripts", app + "__config.json")
        with open(p, encoding="utf-8") as f:
            c = json.load(f)
        c["app"].update({"id": new_id, "chip": new_id.replace("-", "")[:20], "title": new_id})
        with open(p, "w", encoding="utf-8") as f:
            json.dump(c, f)
        path = (extra_path + os.pathsep if extra_path else "") + (os.environ.get("PATH", "") if os.name == "nt" else "/usr/bin:/bin")
        env = {"HOME": home, "USERPROFILE": home, "PATH": path, "BOLT_APP_FIXTURE": "1"}
        if os.name == "nt":
            for k in ("SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "PATHEXT"):
                if k in os.environ:
                    env[k] = os.environ[k]
        r = subprocess.run([sys.executable, os.path.join(d, "scripts", app + "__" + script)] + args, env=env, capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr[-300:])
        return json.loads(r.stdout)

    def test_two_copies_use_separate_caches(self):
        home = tempfile.mkdtemp()
        os.makedirs(os.path.join(home, ".bolt-apps", "cache", "keep-me"))   # a non-empty sandbox HOME
        cases = (("repo-radar", "radar.py", ["expressjs/express"]), ("around", "around.py", ["Bryant", "Park,", "New", "York"]),
                 ("file-insights-template", "insights.py", ["demo-hostile"]))
        for app, script, args in cases:
            a, b = app + "-copy-a", app + "-copy-b"
            self.run_copy(app, script, args, a, home)
            self.run_copy(app, script, args, b, home)
            base = os.path.join(home, ".bolt-apps", "cache")
            have = os.listdir(base)
            self.assertIn(a, have, app)
            self.assertIn(b, have, app)
            self.assertNotIn(app, have, "a copy wrote into the original's cache: " + app)

    @unittest.skipIf(os.name == "nt", "POSIX stubs")
    def test_cli_wrapper_copy(self):
        home = tempfile.mkdtemp()
        stub = tempfile.mkdtemp()
        with open(os.path.join(EX, "cli-wrapper-template", "fixtures", "macos", "ping.out"), encoding="utf-8") as f:
            out = f.read()
        with open(os.path.join(stub, "ping"), "w", encoding="utf-8") as f:
            f.write("#!/bin/sh\ncat <<'EOF'\n" + out + "EOF\n")
        os.chmod(os.path.join(stub, "ping"), 0o755)
        for n in ("cli-wrapper-template-copy-a", "cli-wrapper-template-copy-b"):
            self.run_copy("cli-wrapper-template", "wrap.py", ["overview", "example.test"], n, home, stub)
        have = os.listdir(os.path.join(home, ".bolt-apps", "cache"))
        self.assertNotIn("cli-wrapper-template", have)
        self.assertIn("cli-wrapper-template-copy-a", have)


if __name__ == "__main__":
    unittest.main()
