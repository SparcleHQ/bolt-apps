"""Round 2: an API that echoes the key must never get it into the cache or a row; hydrate, date tokens, query-parameter keys, flattened feeds."""
import http.server
import importlib.util
import json
import os
import re
import shutil
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", "examples", "portal-template", "scripts"))
SHARED_ENGINE = os.path.abspath(os.path.join(HERE, "..", "bolt_app_engine.py"))   # the engine is kept once; the example app holds only a thin entry
sys.path.insert(0, os.path.join(HERE, ".."))
import bolt_app_kit as kit  # noqa: E402

KEY = "DEMO_KEY_abc123"


class Done(Exception):
    def __init__(self, rows):
        self.rows = rows


def fake_emit(rows, **kw):
    raise Done(rows)


class Echo(http.server.BaseHTTPRequestHandler):
    hits = []

    def log_message(self, *a):
        pass

    def send(self, obj):
        b = json.dumps(obj).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(b)

    def do_GET(self):
        Echo.hits.append(self.path)
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        k = (q.get("api_key") or [""])[0]
        if u.path == "/feed":
            self.send({"links": {"self": "http://x/feed?api_key=%s&end=1" % k}, "message": "ok for %s" % k,
                       "objs": {"2026-11-14": [{"name": "A", "link": "https://x/a?api_key=%s" % k}], "2026-11-13": [{"name": "B", "link": "https://x/b?api_key=%s" % k}]}})
        elif u.path == "/top.json":
            self.send([1, "..", ".", "", 2, 3, 4, 5])
        elif u.path.startswith("/item/"):
            i = int(re.search(r"(\d+)", u.path).group(1))
            self.send({"id": i, "title": "Story %d" % i})
        else:
            self.send_response(404); self.end_headers()


class Round2(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp()
        self._env = dict(os.environ)
        os.environ.update({"HOME": self.home, "USERPROFILE": self.home, "BOLT_APP_TEST": "1", "ECHO_KEY": KEY})
        os.environ.pop("BOLT_APP_FIXTURE", None)
        Echo.hits = []
        self.srv = http.server.HTTPServer(("localhost", 0), Echo)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        cfg = {"app": {"id": "echo-app", "chip": "echo", "title": "Echo", "service": "Echo"},
               "api": {"base_url": "http://localhost:%d" % self.srv.server_port, "key_env": "ECHO_KEY", "auth_in": "query", "auth_param": "api_key", "fixture_default": False},
               "cache": {"ttl": 60, "stale_max": 3600},
               "endpoints": {"feed": {"path": "/feed?start={today-7d}&end={today}", "data": "objs", "flatten": "date"},
                             "top": {"path": "/top.json", "hydrate": {"path": "/item/{id}.json", "limit": 3}}},
               "overview": {"rows": [{"title": "Feed", "view": "feed"}]},
               "views": [{"id": "feed", "endpoint": "feed", "item": {"title": "{name}", "subtitle": "{date}", "url": "{link}"}},
                         {"id": "top", "endpoint": "top", "item": {"title": "{title}"}}]}
        self.cfg_path = os.path.join(self.home, "config.json")
        with open(self.cfg_path, "w", encoding="utf-8") as f:
            json.dump(cfg, f)
        spec = importlib.util.spec_from_file_location("eng_r2", SHARED_ENGINE)
        self.eng = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.eng)
        self._emit, kit.emit = kit.emit, fake_emit

    def tearDown(self):
        kit.emit = self._emit
        self.srv.shutdown()
        os.environ.clear(); os.environ.update(self._env)
        shutil.rmtree(self.home, ignore_errors=True)

    def rows(self, *args):
        try:
            self.eng.run(["engine.py", "--config=" + self.cfg_path] + list(args))
        except Done as d:
            return d.rows
        self.fail("no rows")

    def test_echoed_key_never_reaches_the_cache_or_a_row(self):
        r = self.rows("feed")
        self.assertEqual([x["title"] for x in r if x["title"] in ("A", "B")], ["B", "A"])   # flattened, in key order
        self.assertTrue(any("api_key=" + KEY in h for h in Echo.hits), "the key was sent as a query parameter")
        self.assertNotIn(KEY, json.dumps(r))
        found = []
        for root, _, files in os.walk(self.home):
            for f in files:
                if f == "config.json":
                    continue
                with open(os.path.join(root, f), "rb") as fh:
                    if KEY.encode() in fh.read():
                        found.append(os.path.join(root, f))
        self.assertEqual(found, [], "the key was written to disk")
        self.assertTrue([f for _, _, fs in os.walk(self.home) for f in fs if f != "config.json"], "something was cached")

    def test_stale_copy_has_no_key_either(self):
        self.rows("feed")
        self.srv.shutdown()
        r = self.rows("feed", "refresh")
        self.assertNotIn(KEY, json.dumps(r))

    def test_date_tokens_are_local_dates(self):
        self.rows("feed")
        h = [x for x in Echo.hits if x.startswith("/feed")][0]
        today, week = time.strftime("%Y-%m-%d"), time.strftime("%Y-%m-%d", time.localtime(time.time() - 7 * 86400))
        self.assertIn("start=" + week, h)
        self.assertIn("end=" + today, h)

    def test_hydrate_fetches_each_id_up_to_the_limit(self):
        r = self.rows("top")
        self.assertEqual([x["title"] for x in r if x["title"].startswith("Story")], ["Story 1", "Story 2", "Story 3"])
        self.assertEqual(len([h for h in Echo.hits if h.startswith("/item/")]), 3)   # "..", "." and "" are dropped before the limit

    def test_config_problems_are_named(self):
        with open(self.cfg_path, encoding="utf-8") as f:
            cfg = json.load(f)
        cfg["api"]["auth_in"] = "cookie"
        cfg["endpoints"]["top"]["hydrate"] = {"path": "/item/x.json"}
        probs = self.eng.validate_config(cfg)
        self.assertTrue([p for p in probs if "auth_in" in p]); self.assertTrue([p for p in probs if "hydrate" in p])


if __name__ == "__main__":
    unittest.main()
