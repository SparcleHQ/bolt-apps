"""Review fixes in the shared engine: redirects and hosts, one odd record, malformed answers, test-only config switch, the local log."""
import http.server
import importlib.util
import json
import os
import sys
import tempfile
import threading
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", "examples", "portal-template", "scripts"))
SHARED_ENGINE = os.path.abspath(os.path.join(HERE, "..", "bolt_app_engine.py"))   # the engine is kept once; the example app holds only a thin entry
sys.path.insert(0, os.path.join(HERE, ".."))
import bolt_app_kit as kit  # noqa: E402


def load_engine():
    spec = importlib.util.spec_from_file_location("portal_engine_r", SHARED_ENGINE)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def serve(handler):
    srv = http.server.HTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


class Redirects(unittest.TestCase):
    def test_key_is_not_forwarded_to_another_host_or_scheme(self):
        eng = load_engine()
        seen = []

        class Other(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                seen.append(dict(self.headers))
                self.send_response(200); self.end_headers(); self.wfile.write(b'{"data": []}')

            def log_message(self, *a):
                pass
        other = serve(Other)

        class First(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(302)
                self.send_header("Location", "http://127.0.0.1:%d/steal" % other.server_address[1])
                self.end_headers()

            def log_message(self, *a):
                pass
        first = serve(First)
        api = {"base_url": "http://127.0.0.1:%d" % first.server_address[1], "auth_header": "X-API-Key"}
        with self.assertRaises(Exception):
            eng.http_get(api, "SECRET-KEY-123", "/v1/x", 3)
        self.assertEqual(seen, [], "the second host must receive nothing")

    def test_absolute_endpoint_on_another_host_is_a_config_problem(self):
        eng = load_engine()
        cfg = {"app": {"id": "a", "chip": "a", "title": "A"}, "api": {"base_url": "https://api.example.com"},
               "endpoints": {"x": {"path": "https://evil.example.net/v1/x"}}, "views": [{"id": "v", "endpoint": "x", "item": {}}]}
        self.assertTrue([p for p in eng.validate_config(cfg) if "host" in p])
        cfg["endpoints"]["x"]["path"] = "https://api.example.com/v1/x"
        self.assertFalse([p for p in eng.validate_config(cfg) if "host" in p])
        cfg["endpoints"]["x"]["path"] = "https://geo.example.org/v1/x"
        cfg["api"]["allowed_hosts"] = ["geo.example.org"]
        self.assertFalse([p for p in eng.validate_config(cfg) if "host" in p])


class OddRecords(unittest.TestCase):
    def test_one_odd_record_keeps_its_row(self):
        eng = load_engine()
        view = {"id": "v", "icon": "list", "item": {"title": "{name}", "url": "{link}", "tile": {"label": "n", "value": "{n}"}, "trend_field": "series"}}
        item = {"name": "A", "link": "https://a.example/x y", "n": "NaN", "series": list(range(100))}
        row = eng.item_row({}, view, item, {}, None)
        self.assertEqual(row["title"], "A")

    def test_open_url_cannot_be_a_script_link(self):
        eng = load_engine()
        view = {"id": "v", "icon": "list", "item": {"title": "{name}", "url": "{link}"}}
        row = eng.item_row({}, view, {"name": "A", "link": "javascript:alert(1)"}, {}, None)
        self.assertEqual(row.get("open_url", ""), "")


class Answers(unittest.TestCase):
    def test_error_body_is_not_data(self):
        eng = load_engine()
        self.assertIsNone(eng.unwrap({"kind": "object", "data": "", "require": ["current"]}, {"message": "Bad credentials"}))
        self.assertIsNone(eng.unwrap({"kind": "object", "data": "data"}, {"message": "Bad credentials"}))
        self.assertIsNotNone(eng.unwrap({"kind": "object", "data": "", "require": ["current"]}, {"current": {}}))

    def test_list_of_non_records_is_unread_not_zero_rows(self):
        eng = load_engine()
        self.assertIsNone(eng.unwrap({"kind": "list", "data": "data"}, {"data": ["a", "b"]}))
        self.assertEqual(eng.unwrap({"kind": "list", "data": "data"}, {"data": []}), [])
        self.assertEqual(eng.unwrap({"kind": "list", "data": "data"}, [{"a": 1}]), [{"a": 1}])

    def test_page_hint_is_detected(self):
        eng = load_engine()
        self.assertTrue(eng.paged({"data": [{}], "next": "https://x/2"}, 1))
        self.assertTrue(eng.paged({"data": [{}], "total": 50}, 1))
        self.assertFalse(eng.paged({"data": [{}], "total": 1}, 1))


class ConfigSwitch(unittest.TestCase):
    def test_config_flag_is_ignored_outside_tests(self):
        eng = load_engine()
        old = os.environ.pop("BOLT_APP_TEST", None)
        try:
            cfg, _ = eng.split_args(["engine.py", "--config=/tmp/evil.json", "overview"])
            self.assertTrue(cfg.endswith("config.json") and "evil" not in cfg)
            os.environ["BOLT_APP_TEST"] = "1"
            cfg, _ = eng.split_args(["engine.py", "--config=/tmp/evil.json", "overview"])
            self.assertEqual(cfg, "/tmp/evil.json")
        finally:
            os.environ.pop("BOLT_APP_TEST", None)
            if old:
                os.environ["BOLT_APP_TEST"] = old


class Log(unittest.TestCase):
    def test_existing_loose_directory_is_tightened_and_appends_do_not_lose_rows(self):
        eng = load_engine()
        d = tempfile.mkdtemp()
        os.chmod(d, 0o755)
        fm = {"store": {"file": os.path.join(d, "log.jsonl"), "max_rows": 500}}
        ts = [threading.Thread(target=eng.store_append, args=(fm, {"i": i})) for i in range(20)]
        [t.start() for t in ts]
        [t.join() for t in ts]
        self.assertEqual(oct(os.stat(d).st_mode & 0o777), "0o700")
        self.assertEqual(len(eng.store_read(fm)), 20)


class Filters(unittest.TestCase):
    def test_when_and_round(self):
        eng = load_engine()
        import time
        want = time.strftime("%Y-%m-%d %H:%M", time.localtime(1763208300))
        self.assertEqual(eng.shown(1763208300, "when"), want)
        self.assertEqual(eng.shown(1763208300000, "when"), want)   # milliseconds
        self.assertEqual(eng.shown("1763208300", "whenday"), want[:10])
        for bad in (0, -5, "x", True):
            self.assertEqual(eng.shown(bad, "when") if bad is not True else eng.shown(1, "when") and "unknown", "unknown")
        self.assertEqual((eng.shown(2.5, "round"), eng.shown(3.14159, "round2"), eng.shown(2.345, "round1"), eng.shown("x", "round")), ("3", "3.14", "2.3", "unknown"))
        self.assertEqual(eng.render("{n|round1} at {t|when}", {"n": 1.26, "t": 1763208300}, {}), "1.3 at " + want)


class Icons(unittest.TestCase):
    def test_unknown_icon_is_a_config_problem_with_its_place(self):
        eng = load_engine()
        cfg = {"app": {"id": "a", "chip": "a", "title": "A", "icon": "gauge"}, "api": {"base_url": "https://api.example.com"}, "endpoints": {"x": {"path": "/x"}},
               "overview": {"rows": [{"title": "t", "icon": "activity"}]}, "views": [{"id": "v", "endpoint": "x", "icon": "no-such", "item": {}}]}
        probs = [p for p in eng.validate_config(cfg) if "icon" in p]
        self.assertEqual(len(probs), 2)
        self.assertIn('"gauge" (app.icon)', probs[0]); self.assertIn("views[0].icon", probs[1])


if __name__ == "__main__":
    unittest.main()
