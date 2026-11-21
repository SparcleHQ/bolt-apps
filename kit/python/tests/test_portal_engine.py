"""The portal-template engine against a local HTTP server: key handling, TTL cache, stale fallback, error rows.
The check harness cannot reach the network, so the live path is tested here."""
import http.server
import importlib.util
import json
import os
import shutil
import stat
import sys
import tempfile
import threading
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", "examples", "portal-template", "scripts"))
sys.path.insert(0, os.path.join(HERE, ".."))
import bolt_app_kit as kit  # noqa: E402


os.environ["BOLT_APP_TEST"] = "1"   # the engine honours --config only under test


class Done(Exception):
    def __init__(self, rows):
        self.rows = rows


def fake_emit(rows, **kw):
    raise Done(rows)


def load_engine():
    spec = importlib.util.spec_from_file_location("portal_engine", os.path.join(ROOT, "portal-template__engine.py"))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


class Handler(http.server.BaseHTTPRequestHandler):
    status = 200
    hits = []
    seen_keys = []

    def log_message(self, *a):
        pass

    def do_GET(self):
        Handler.hits.append(self.path)
        Handler.seen_keys.append(self.headers.get("Authorization"))
        if Handler.status != 200:
            self.send_response(Handler.status)
            self.end_headers()
            return
        with open(os.path.join(ROOT, "portal-template__fixtures.json"), encoding="utf-8") as f:
            fx = json.load(f)
        name = self.path.strip("/").split("/")[-1]
        body = json.dumps(fx["account" if name == "account" else name]).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)


class EngineLive(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp()
        self._env = dict(os.environ)
        os.environ["HOME"] = self.home
        os.environ["USERPROFILE"] = self.home
        os.environ.pop("EXAMPLE_API_KEY", None)
        os.environ.pop("BOLT_APP_FIXTURE", None)
        self.srv = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        Handler.status, Handler.hits, Handler.seen_keys = 200, [], []
        with open(os.path.join(ROOT, "portal-template__config.json"), encoding="utf-8") as f:
            cfg = json.load(f)
        cfg["api"]["base_url"] = "http://127.0.0.1:%d" % self.srv.server_port
        cfg["api"]["fixture_default"] = False
        cfg["api"]["on_missing_key"] = "setup"   # these tests are about the real-app path: a missing key is one setup row
        cfg["api"]["env_file"] = os.path.join(self.home, "key.env")
        self.cfg_path = os.path.join(self.home, "config.json")
        with open(self.cfg_path, "w", encoding="utf-8") as f:
            json.dump(cfg, f)
        self.eng = load_engine()
        self._emit = kit.emit
        kit.emit = fake_emit

    def tearDown(self):
        kit.emit = self._emit
        self.srv.shutdown()
        os.environ.clear()
        os.environ.update(self._env)
        shutil.rmtree(self.home, ignore_errors=True)

    def rows(self, *args):
        try:
            self.eng.run(["engine.py", "--config=" + self.cfg_path] + list(args))
        except Done as d:
            return d.rows
        self.fail("no rows emitted")

    def text(self, rows):
        return json.dumps(rows)

    def write_env(self, mode=0o600):
        p = os.path.join(self.home, "key.env")
        with open(p, "w", encoding="utf-8") as f:
            f.write("EXAMPLE_API_KEY=sekret-value-123\n")
        os.chmod(p, mode)

    def test_no_key_row_and_no_request(self):
        r = self.rows("overview")
        self.assertIn("Add your Example Service API key", r[0]["title"])
        self.assertEqual(Handler.hits, [])

    def test_key_from_env_file_is_sent_and_never_shown(self):
        self.write_env()
        r = self.rows("overview")
        self.assertTrue(Handler.hits)
        self.assertTrue(all(k == "Bearer sekret-value-123" for k in Handler.seen_keys))
        self.assertNotIn("sekret-value-123", self.text(r))
        for root, _, files in os.walk(self.home):
            for f in files:
                if f.startswith("key.env") or f == "config.json":
                    continue
                with open(os.path.join(root, f), "rb") as fh:
                    self.assertNotIn(b"sekret-value-123", fh.read(), f)

    def test_environment_key_beats_file(self):
        os.environ["EXAMPLE_API_KEY"] = "from-env"
        self.rows("overview")
        self.assertTrue(all(k == "Bearer from-env" for k in Handler.seen_keys))

    @unittest.skipIf(os.name == "nt", "mode bits")
    def test_loose_env_file_permissions_are_refused_with_the_fix(self):
        self.write_env(0o644)
        r = self.rows("overview")
        self.assertIn("Tighten the permissions", r[0]["title"])
        self.assertEqual(Handler.hits, [])

    def test_second_run_inside_ttl_uses_the_cache_and_refresh_skips_it(self):
        self.write_env()
        self.rows("overview")
        n = len(Handler.hits)
        r = self.rows("overview")
        self.assertEqual(len(Handler.hits), n)
        self.rows("overview", "refresh")
        self.assertGreater(len(Handler.hits), n)

    def test_failure_is_not_cached_and_old_copy_is_shown_stale(self):
        self.write_env()
        self.rows("tasks" if False else "tickets")           # fills the cache
        # expire the fresh copy only: age the files past the ttl
        fresh = os.path.join(self.home, ".bolt-apps", "cache", "portal-template")
        for f in os.listdir(fresh):
            os.utime(os.path.join(fresh, f), (1, 1))
        for f in os.listdir(fresh):
            p = os.path.join(fresh, f)
            with open(p, encoding="utf-8") as fh:
                doc = json.load(fh)
            doc["ts"] = 1
            with open(p, "w", encoding="utf-8") as fh:
                json.dump(doc, fh)
        Handler.status = 500
        r = self.rows("tickets")
        t = self.text(r)
        self.assertIn("STALE", t)
        self.assertIn("Crash on startup", t)
        # the failure left nothing new in the fresh cache
        Handler.status = 500
        self.assertIn("STALE", self.text(self.rows("tickets")))

    def test_failure_with_no_copy_is_one_retry_row(self):
        self.write_env()
        Handler.status = 500
        r = self.rows("tickets")
        self.assertEqual(r[0]["nav"], {"back": True})
        self.assertIn("returned an error", r[1]["title"])
        self.assertEqual(r[1]["nav"]["arg"], "refresh")

    def test_401_says_the_key_was_rejected(self):
        self.write_env()
        Handler.status = 401
        r = self.rows("overview")
        self.assertIn("rejected the API key", r[0]["title"])
        self.assertNotIn("sekret-value-123", self.text(r))

    def test_unreachable_server_is_offline(self):
        self.write_env()
        self.srv.shutdown()
        self.srv.server_close()
        r = self.rows("overview")
        self.assertIn("Could not connect", r[0]["title"])

    def test_http_to_a_remote_host_is_refused(self):
        with open(self.cfg_path, encoding="utf-8") as f:
            cfg = json.load(f)
        cfg["api"]["base_url"] = "http://api.example.com"
        with open(self.cfg_path, "w", encoding="utf-8") as f:
            json.dump(cfg, f)
        self.write_env()
        with self.assertRaises(self.eng.ConfigError):
            self.rows("overview")

    def test_hostile_text_from_the_api_is_neutralised(self):
        e = self.eng
        item = {"title": "a‮b​c{{x}}d", "status": "open"}
        view = {"id": "tickets", "item": {"title": "{title}", "subtitle": "{status}"}}
        r = e.item_row({}, view, item, {}, None)
        self.assertNotIn("‮", r["title"])
        self.assertNotIn("{{", r["title"])


if __name__ == "__main__":
    unittest.main()
