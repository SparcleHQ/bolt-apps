"""Cold-run fixes in the shared engine: a 404 is "No such <noun>", sample text is for end users, a sample-only app draws no Refresh row,
whenday reads ISO dates, and the thousands filter. Runs on Python 3.9."""
import http.server
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
EX = os.path.abspath(os.path.join(HERE, "..", "..", "examples"))
sys.path.insert(0, os.path.join(HERE, ".."))
os.environ["BOLT_APP_TEST"] = "1"


def engine_path(app):
    return os.path.join(EX, app, "scripts", app + "__engine.py")


def load_engine(app="lookup-template"):
    spec = importlib.util.spec_from_file_location("eng_" + app.replace("-", "_"), engine_path(app))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def run(app, args, cfg=None, env=None, fixtures=None):
    """Run an engine copy as a subprocess, optionally with a replaced config/fixtures (written next to a copy of the script)."""
    d = tempfile.mkdtemp()
    scripts = os.path.join(EX, app, "scripts")
    for f in os.listdir(scripts):
        if f.endswith(".py"):
            with open(os.path.join(scripts, f), encoding="utf-8") as src, open(os.path.join(d, f), "w", encoding="utf-8") as dst:
                dst.write(src.read())
    for f in os.listdir(scripts):
        if f.endswith((".json",)):
            with open(os.path.join(scripts, f), encoding="utf-8") as src:
                data = src.read()
            if cfg is not None and f.endswith("__config.json"):
                data = json.dumps(cfg)
            if fixtures is not None and f.endswith("__fixtures.json"):
                data = json.dumps(fixtures)
            with open(os.path.join(d, f), "w", encoding="utf-8") as dst:
                dst.write(data)
    e = dict(os.environ)
    e.update({"HOME": d, "USERPROFILE": d, "PYTHONDONTWRITEBYTECODE": "1"})
    e.pop("BOLT_APP_FIXTURE", None)
    e.update(env or {})
    r = subprocess.run([sys.executable, os.path.join(d, app + "__engine.py")] + args, env=e, capture_output=True, text=True, cwd=d)
    return r


def fixtures_of(app):
    with open(os.path.join(EX, app, "scripts", app + "__fixtures.json"), encoding="utf-8") as f:
        return json.load(f)


def cfg_of(app):
    with open(os.path.join(EX, app, "scripts", app + "__config.json"), encoding="utf-8") as f:
        return json.load(f)


class Four04(http.server.BaseHTTPRequestHandler):
    status = 404

    def log_message(self, *a):
        pass

    def do_GET(self):
        self.send_response(Four04.status)
        self.end_headers()


class NotFoundRow(unittest.TestCase):
    def setUp(self):
        self.srv = http.server.HTTPServer(("127.0.0.1", 0), Four04)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.base = "http://127.0.0.1:%d" % self.srv.server_address[1]

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()

    def lookup_cfg(self):
        cfg = cfg_of("lookup-template")
        cfg["api"]["base_url"] = self.base
        cfg["api"]["fixture_default"] = False
        cfg["api"].pop("key_env", None)
        # one keyless endpoint, single-endpoint lookup, so the 404 is on the typed word
        name = list(cfg["endpoints"])[0]
        cfg["endpoints"] = {name: {"path": "/crates/{query}", "kind": "object"}}
        cfg["lookup"] = {"steps": [name], "rows": [{"title": "{%s.id}" % name}], "widget": cfg["lookup"]["widget"]}
        return cfg

    def test_404_is_no_such_noun_not_offline(self):
        cfg = self.lookup_cfg()
        cfg["app"]["noun"] = "crate"
        r = run("lookup-template", ["nopesuchcrate"], cfg=cfg, env={"BOLT_APP_FIXTURE": "0"})
        self.assertEqual(r.returncode, 0, r.stderr)
        rows = json.loads(r.stdout)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["title"], "No such crate")
        self.assertIn("nopesuchcrate", rows[0]["subtitle"])
        self.assertNotIn("OFFLINE", json.dumps(rows))
        self.assertNotIn("error", rows[0]["title"].lower())
        self.assertFalse(rows[0].get("nav"), "nothing to retry")

    def test_404_without_a_noun_says_no_match(self):
        r = run("lookup-template", ["zzz"], cfg=self.lookup_cfg(), env={"BOLT_APP_FIXTURE": "0"})
        self.assertEqual(json.loads(r.stdout)[0]["title"], "No match")

    def test_500_is_still_an_error_row(self):
        Four04.status = 500
        try:
            r = run("lookup-template", ["zzz"], cfg=self.lookup_cfg(), env={"BOLT_APP_FIXTURE": "0"})
        finally:
            Four04.status = 404
        t = json.loads(r.stdout)[0]
        self.assertIn("returned an error", t["title"])

    def test_demo_notfound_previews_the_row_in_sample_mode(self):
        cfg = cfg_of("portal-template")
        cfg["app"]["noun"] = "ticket"
        r = run("portal-template", ["tickets", "demo-notfound"], cfg=cfg, env={"BOLT_APP_FIXTURE": "1"})
        self.assertEqual(json.loads(r.stdout)[-1]["title"], "No such ticket")


class Plan(http.server.BaseHTTPRequestHandler):
    """Answers by path: Plan.status[name] is an HTTP status (default 200 with the example's recorded answer)."""
    status = {}
    payload = {}

    def log_message(self, *a):
        pass

    def do_GET(self):
        name = self.path.split("?")[0].strip("/").split("/")[-1]
        code = Plan.status.get(name, 200)
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        if code == 200:
            self.wfile.write(json.dumps(Plan.payload.get(name, {})).encode())


class PartialAnd404(unittest.TestCase):
    def setUp(self):
        self.srv = http.server.HTTPServer(("localhost", 0), Plan)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.base = "http://localhost:%d" % self.srv.server_address[1]
        Plan.status = {}
        Plan.payload = fixtures_of("portal-template")

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()

    def portal(self, args, noun=None):
        cfg = cfg_of("portal-template")
        cfg["api"]["base_url"] = self.base
        cfg["api"]["fixture_default"] = False
        cfg["api"]["on_missing_key"] = "setup"
        if noun:
            cfg["app"]["noun"] = noun
        r = run("portal-template", args, cfg=cfg, env={"BOLT_APP_FIXTURE": "0", "EXAMPLE_API_KEY": "abcdef123456"})
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout)

    def test_one_404_among_good_calls_keeps_the_data(self):
        Plan.status = {"projects": 404}
        rows = self.portal([])
        text = json.dumps(rows)
        self.assertIn("Some data did not load: projects", text)
        self.assertIn("projects answered 404", text)
        self.assertNotIn("No such", text)
        self.assertNotIn("The service answered 404", text)
        self.assertTrue(any("open tickets" in (r.get("subtitle") or "") or "Open tickets" in r["title"] for r in rows), "the good data is still drawn")
        rows = self.portal(["tickets"])
        self.assertTrue(any("Crash on startup" in r["title"] for r in rows) or any(r.get("nav") for r in rows))

    def test_all_404_is_no_such_with_noun_and_a_plain_404_row_without(self):
        Plan.status = {"projects": 404, "tickets": 404, "account": 404}
        rows = self.portal([], noun="workspace")
        self.assertEqual([r["title"] for r in rows if "No such" in r["title"]], ["No such workspace"])
        rows = self.portal([])
        self.assertEqual(len(rows), 1)
        self.assertTrue(rows[0]["title"].startswith("The service answered 404 for "), rows[0]["title"])
        self.assertNotIn("No match", rows[0]["title"])
        self.assertNotIn("OFFLINE", json.dumps(rows))

    def test_404_plus_500_shows_the_other_failure(self):
        Plan.status = {"projects": 404, "tickets": 404, "account": 500}
        rows = self.portal([], noun="workspace")
        self.assertIn("returned an error", rows[0]["title"])
        self.assertNotIn("No such", json.dumps(rows))

    def test_lookup_chain_only_the_first_step_may_say_no_such(self):
        cfg = cfg_of("lookup-template")
        cfg["api"].update({"base_url": self.base, "fixture_default": False})
        cfg["api"].pop("allowed_hosts", None)
        cfg["app"]["noun"] = "place"
        cfg["endpoints"] = {"geocode": {"path": "/geo?name={query}", "data": "results"},
                            "weather": {"path": "/wx?lat={geocode.latitude}", "kind": "object", "data": ""}}
        Plan.payload = {"geo": {"results": [{"latitude": 1, "longitude": 2}]}, "wx": {"current": {}}}
        env = {"BOLT_APP_FIXTURE": "0"}
        Plan.status = {"geo": 404}
        self.assertEqual(json.loads(run("lookup-template", ["nowhere"], cfg=cfg, env=env).stdout)[0]["title"], "No such place")
        Plan.status = {"wx": 404}
        t = json.loads(run("lookup-template", ["paris"], cfg=cfg, env=env).stdout)[0]["title"]
        self.assertEqual(t, "Found it, but the next lookup answered 404")


class SampleText(unittest.TestCase):
    def test_banner_is_for_end_users(self):
        cfg = cfg_of("portal-template")
        cfg["api"]["fixture_default"] = True
        cfg["api"]["fixture_banner"] = True
        cfg["api"]["on_missing_key"] = "setup"
        r = run("portal-template", ["projects"], cfg=cfg)
        text = r.stdout
        self.assertIn("This is sample data.", text)
        for dev in ("fixture_default", "config.json", "Fixture mode", "no key and no network"):
            self.assertNotIn(dev, text)

    def test_tile_hint_for_end_users(self):
        cfg = cfg_of("portal-template")
        cfg["api"]["fixture_default"] = True
        cfg["api"]["fixture_banner"] = True
        r = run("portal-template", [], cfg=cfg)
        for dev in ("fixture_default", "config.json", "no key and no network"):
            self.assertNotIn(dev, r.stdout)

    def test_sample_only_app_draws_no_refresh_row(self):
        cfg = cfg_of("portal-template")
        cfg["api"]["fixture_default"] = True
        for args in ([], ["projects"], ["projects", "P-1"], ["tickets"]):
            r = run("portal-template", args, cfg=cfg)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertNotIn('"Refresh"', r.stdout, args)
        # a live-capable app still has it (sample mode is only for tests there)
        live = cfg_of("portal-template")
        r = run("portal-template", ["projects"], cfg=live, env={"BOLT_APP_FIXTURE": "1"})
        self.assertIn('"Refresh"', r.stdout)

    def test_no_api_section_is_sample_only(self):
        cfg = cfg_of("portal-template")
        del cfg["api"]
        for args in ([], ["projects"]):
            r = run("portal-template", args, cfg=cfg, fixtures=fixtures_of("portal-template"))
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertNotIn("not set up correctly", r.stdout)
            self.assertNotIn('"Refresh"', r.stdout)

    def test_sample_only_needs_no_base_url_but_live_does(self):
        cfg = cfg_of("portal-template")
        cfg["api"].pop("base_url")
        cfg["api"]["fixture_default"] = True
        self.assertEqual(run("portal-template", [], cfg=cfg).returncode, 0)
        cfg["api"]["fixture_default"] = False
        self.assertIn("api.base_url is required", run("portal-template", [], cfg=cfg).stdout)


class Filters(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.m = load_engine()

    def test_whenday_and_when_read_iso_dates_and_epochs(self):
        s = self.m.shown
        self.assertEqual(s("2026-07-18T09:30:00Z", "whenday"), "2026-07-18")
        self.assertEqual(s("2026-07-18T09:30:00Z", "when"), "2026-07-18 09:30")
        self.assertEqual(s("2026-07-18", "when"), "2026-07-18")
        self.assertEqual(s("2026-07-18 09:30", "when"), "2026-07-18 09:30")
        self.assertEqual(s(1700000000, "whenday"), self.m.time.strftime("%Y-%m-%d", self.m.time.localtime(1700000000)))
        self.assertEqual(s("1700000000000", "whenday"), s(1700000000, "whenday"))
        self.assertEqual(s("not a date", "whenday"), "unknown")
        self.assertEqual(s("20260718", "when"), "unknown")   # eight digits are neither an epoch nor an ISO date
        self.assertEqual(s("20260718", "whenday"), "unknown")
        for bad in ("2026-13-45", "2026-02-30", "2026-00-10", "2026-07-18T25:00:00Z", "2026-07-18T09:75"):
            self.assertEqual(s(bad, "whenday"), "unknown", bad) if "T" not in bad else self.assertEqual(s(bad, "when"), "unknown", bad)
        self.assertEqual(s("2024-02-29", "whenday"), "2024-02-29")
        self.assertEqual(s("2026-02-29", "whenday"), "unknown")

    def test_day_and_yes(self):
        s = self.m.shown
        self.assertEqual(s("2026-07-18T09:30:00Z", "day"), "2026-07-18")
        self.assertEqual(s(True, "yes"), "Yes")
        self.assertEqual(s(False, "yes"), "No")

    def test_thousands(self):
        s = self.m.shown
        self.assertEqual(s(1720732933, "thousands"), "1,720,732,933")
        self.assertEqual(s("437591178", "thousands"), "437,591,178")
        self.assertEqual(s(1234.5, "thousands"), "1,234.50")
        self.assertEqual(s(-1234567, "thousands"), "-1,234,567")
        self.assertEqual(s(0, "thousands"), "0")
        self.assertEqual(s("n/a", "thousands"), "unknown")
        self.assertEqual(s(float("inf"), "thousands"), "unknown")
        self.assertEqual(self.m.render("{n|thousands} downloads", {"n": 1000}, {}), "1,000 downloads")


class Identical(unittest.TestCase):
    def test_all_engine_copies_are_byte_identical(self):
        bodies = set()
        for app in os.listdir(EX):
            p = engine_path(app)
            if os.path.exists(p):
                with open(p, "rb") as f:
                    bodies.add(f.read())
        self.assertEqual(len(bodies), 1)


if __name__ == "__main__":
    unittest.main()
