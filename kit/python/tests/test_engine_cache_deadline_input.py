"""Shared engine: a large answer keeps an old copy (the cache holds the rows as read, cut to the fields config.json names) and an answer
over the read limit says it is too large; the steps of a lookup chain share one deadline; the key row names its cause; an id
that is not a nav token still drills; --emit-yaml refuses a value with a line break. Runs on Python 3.9."""
import http.server
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from test_cold_run_engine import cfg_of, fixtures_of, load_engine, run, EX  # noqa: E402


def tickets(n, used=0, unused=0):
    """n tickets; `used` pads the summary (a field a row shows), `unused` adds a field no template reads."""
    out = []
    for i in range(n):
        t = {"id": "TK-%d" % i, "summary": "Ticket %d %s" % (i, "s" * used), "state": "open", "priority": 1, "projectId": "P-1", "assignee": {"name": "A"}}
        if unused:
            t["raw_html"] = "u" * unused
        out.append(t)
    return {"data": out}


class Server(http.server.BaseHTTPRequestHandler):
    """Answers by the last path segment: Server.status[name] is an HTTP status, Server.payload[name] the answer (default the sample answer)."""
    status = {}
    payload = {}

    def log_message(self, *a):
        pass

    def do_GET(self):
        name = self.path.split("?")[0].strip("/").split("/")[-1]
        code = Server.status.get(name, 200)
        body = json.dumps(Server.payload.get(name, {}) if code == 200 else {"message": "server error"}).encode()
        try:
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except OSError:
            pass   # the engine stops reading an answer that is too large


class LiveBase(unittest.TestCase):
    """The portal template against a loopback server with a key; HOME is the app folder, so the cache lives there between runs."""
    app = "portal-template"
    key = "abcdef123456"

    def setUp(self):
        self.srv = http.server.ThreadingHTTPServer(("localhost", 0), Server)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        Server.status = {}
        Server.payload = fixtures_of(self.app)
        self.cfg = cfg_of(self.app)
        self.cfg["api"].update({"base_url": "http://localhost:%d" % self.srv.server_address[1], "fixture_default": False, "on_missing_key": "setup"})
        self.dirs = []

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        for d in self.dirs:
            shutil.rmtree(d, ignore_errors=True)

    def folder(self):
        d = tempfile.mkdtemp()
        self.dirs.append(d)
        scripts = os.path.join(EX, self.app, "scripts")
        for f in os.listdir(scripts):
            if f.endswith((".py", ".json")):
                shutil.copy(os.path.join(scripts, f), os.path.join(d, f))
        with open(os.path.join(d, self.app + "__config.json"), "w") as f:
            json.dump(self.cfg, f)
        return d

    def run_engine(self, args, d, env=None):
        e = dict(os.environ)
        e.pop("BOLT_APP_FIXTURE", None)
        e.update({"HOME": d, "PYTHONDONTWRITEBYTECODE": "1", "BOLT_APP_FIXTURE": "0", "EXAMPLE_API_KEY": self.key})
        e.update(env or {})
        return subprocess.run([sys.executable, os.path.join(d, self.app + "__engine.py")] + args, env=e, capture_output=True, text=True, cwd=d)

    def rows(self, args, d=None, env=None):
        r = self.run_engine(args, d or self.folder(), env)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout)


class LargeAnswers(LiveBase):
    def test_an_answer_over_1_mb_keeps_an_old_copy_when_its_rows_fit(self):
        Server.payload = dict(Server.payload, tickets=tickets(1500, unused=1000))   # about 1.7 MB, the rows a view reads are far smaller
        d = self.folder()
        self.assertEqual(self.rows(["tickets"], d)[0]["subtitle"], "1500 tickets, showing the first 50")
        Server.status = {"account": 503, "tickets": 503}
        rows = self.rows(["tickets", "refresh"], d)
        text = json.dumps(rows)
        self.assertIn("is not answering. Showing data from", text, "the old copy is shown")
        self.assertEqual(rows[0]["subtitle"], "1500 tickets, showing the first 50")
        self.assertNotIn("Could not read tickets", text)

    def test_rows_from_the_cache_are_the_rows_from_the_answer(self):
        Server.payload = dict(Server.payload, tickets=dict(tickets(40, unused=50), data=fixtures_of(self.app)["tickets"]["data"] + tickets(40, unused=50)["data"]))
        for args in (["overview"], ["tickets"], ["tickets", "open"], ["projects"], ["projects", "P-1"]):
            d = self.folder()
            first = self.rows(args, d)    # the answer (and the cache is filled)
            again = self.rows(args, d)    # the cache, inside its ttl
            self.assertGreater(len(first), 3, args)
            no_age = lambda rows: [r for r in rows if r.get("kpi_badge") != "CACHED"]   # noqa: E731  (drawn only once the copy is 2 s old)
            self.assertEqual(no_age(again), no_age(first), args)

    def test_no_old_copy_says_the_last_answer_was_too_large_to_keep(self):
        Server.payload = dict(Server.payload, tickets=tickets(6000, used=200))   # the rows themselves are about 1.5 MB
        d = self.folder()
        self.rows(["tickets"], d)
        Server.status = {"account": 503, "tickets": 503}
        rows = self.rows(["tickets", "refresh"], d)
        notice = [r for r in rows if r["title"] == "Some data did not load: tickets"]
        self.assertEqual(len(notice), 1, json.dumps(rows)[:400])
        self.assertIn("No old copy of tickets: its last answer was over 1 MB", notice[0]["subtitle"])

    def test_an_answer_over_5_mb_is_too_large_not_an_error(self):
        Server.payload = dict(Server.payload, tickets=tickets(25000, used=200))   # about 6.2 MB
        rows = self.rows(["tickets"])
        text = json.dumps(rows)
        self.assertIn("Example Service sent more than 5 MB, more than this app reads", text)
        self.assertNotIn("returned an error", text)
        self.assertIn("Could not read tickets", text)

    def test_a_copy_kept_under_another_config_is_not_used(self):
        d = self.folder()
        self.rows(["tickets"], d)
        self.cfg["endpoints"]["tickets"]["map"]["title"] = "state"   # the cached rows were mapped for the old config
        with open(os.path.join(d, self.app + "__config.json"), "w") as f:
            json.dump(self.cfg, f)
        titles = [r["title"] for r in self.rows(["tickets"], d)]
        self.assertNotIn("Crash on startup", titles, "rows mapped for the old config are not reused")
        self.assertIn("open", titles)


class Slow(http.server.BaseHTTPRequestHandler):
    """lookup-template's sample answers, each after Slow.delay seconds."""
    delay = 0.0
    answers = {}

    def log_message(self, *a):
        pass

    def do_GET(self):
        name = {"search": "geocode", "forecast": "weather"}.get(self.path.split("?")[0].strip("/").split("/")[-1], "extra")
        time.sleep(Slow.delay)
        body = json.dumps(Slow.answers.get(name, {})).encode()
        try:
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except OSError:
            pass


# Runs the engine with a smaller TOTAL_BUDGET, so a chain can outlast it in a second instead of fourteen.
RUNNER = """import importlib.util, sys
spec = importlib.util.spec_from_file_location("eng", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
m.TOTAL_BUDGET = float(sys.argv[2])
m.main([sys.argv[1]] + sys.argv[3:])
"""


class ChainBudget(unittest.TestCase):
    """A lookup chain of three steps (geocode, weather, extra) shares one deadline."""

    def setUp(self):
        self.srv = http.server.ThreadingHTTPServer(("localhost", 0), Slow)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        Slow.answers = dict(fixtures_of("lookup-template"), extra={"note": "ok"})
        self.d = tempfile.mkdtemp()
        scripts = os.path.join(EX, "lookup-template", "scripts")
        for f in os.listdir(scripts):
            if f.endswith((".py", ".json")):
                shutil.copy(os.path.join(scripts, f), os.path.join(self.d, f))
        cfg = cfg_of("lookup-template")
        cfg["api"]["base_url"] = "http://localhost:%d" % self.srv.server_address[1]
        cfg["endpoints"]["geocode"]["path"] = "/v1/search?name={query}"
        cfg["endpoints"]["extra"] = {"path": "/v1/extra?lat={geocode.latitude}", "kind": "object", "data": ""}
        cfg["lookup"]["steps"].append("extra")
        with open(os.path.join(self.d, "lookup-template__config.json"), "w") as f:
            json.dump(cfg, f)
        with open(os.path.join(self.d, "runner.py"), "w") as f:
            f.write(RUNNER)

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        shutil.rmtree(self.d, ignore_errors=True)

    def lookup(self, budget, word):
        e = dict(os.environ)
        e.update({"HOME": self.d, "PYTHONDONTWRITEBYTECODE": "1", "BOLT_APP_FIXTURE": "0"})
        t0 = time.time()
        r = subprocess.run([sys.executable, os.path.join(self.d, "runner.py"), os.path.join(self.d, "lookup-template__engine.py"), str(budget), word, "-", "-"],
                           env=e, capture_output=True, text=True, cwd=self.d)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout), time.time() - t0

    def test_the_steps_together_stay_inside_one_budget(self):
        Slow.delay = 0.6   # each step alone fits in 1 s; three in a row do not
        rows, took = self.lookup(1.0, "Paris")
        self.assertEqual([r["title"] for r in rows], ["Open-Meteo did not answer in time (all calls together get 1 s)"])
        self.assertLess(took, 1.0 + 0.6 + 1.0, "the run ends near the budget, not after every step")

    def test_a_chain_inside_the_budget_answers(self):
        Slow.delay = 0.05
        rows, _ = self.lookup(5.0, "Paris")
        self.assertTrue(rows[0]["title"].startswith("New York"), rows[0]["title"])


class KeyAdvice(LiveBase):
    """The row for a key that is refused, or a key file that gives no key, names that cause and its fix."""
    FILE = "~/.config/portal-template/key.env.test"   # api.env_file: the rows name this path, not the default one

    def setUp(self):
        LiveBase.setUp(self)
        self.cfg["api"]["env_file"] = self.FILE
        self.d = self.folder()
        self.path = os.path.join(self.d, ".config", "portal-template", "key.env.test")
        os.makedirs(os.path.dirname(self.path), 0o700)

    def write(self, text, mode=0o600):
        with open(self.path, "w") as f:
            f.write(text)
        os.chmod(self.path, mode)

    def key_row(self, env_key=""):
        rows = self.rows(["tickets"], self.d, {"EXAMPLE_API_KEY": env_key})
        self.assertEqual(len(rows), 2, rows)
        self.assertEqual(rows[1]["kpi_badge"], "KEY")
        return rows[1]["title"], rows[1]["subtitle"]

    def test_a_short_key_is_not_told_to_chmod(self):
        title, sub = self.key_row("ab")
        self.assertEqual(title, "The EXAMPLE_API_KEY key is too short")
        self.assertNotIn("chmod", sub)

    def test_a_linked_key_file_is_not_told_to_chmod(self):
        real = os.path.join(self.d, "real.env.test")
        with open(real, "w") as f:
            f.write("EXAMPLE_API_KEY=abcdef123\n")
        os.chmod(real, 0o600)
        os.symlink(real, self.path)
        title, sub = self.key_row()
        self.assertEqual(title, "The key file is a link")
        self.assertIn("~/.config/portal-template/key.env.test is a link", sub)
        self.assertNotIn("chmod", sub)

    def test_a_key_file_others_can_read_names_its_own_path(self):
        self.write("EXAMPLE_API_KEY=abcdef123\n", 0o644)
        self.assertEqual(self.key_row(), ("Tighten the permissions on the key file",
                                          "Run chmod 600 on ~/.config/portal-template/key.env.test so other users cannot read the key, then press Enter"))

    @unittest.skipIf(hasattr(os, "getuid") and os.getuid() == 0, "root reads any file")
    def test_a_key_file_you_cannot_read(self):
        self.write("EXAMPLE_API_KEY=abcdef123\n", 0o000)
        title, sub = self.key_row()
        self.assertEqual(title, "The key file cannot be read")
        self.assertIn("run chmod 600 on it", sub)

    def test_an_empty_key_line(self):
        self.write("EXAMPLE_API_KEY=\n")
        self.assertEqual(self.key_row()[0], "The EXAMPLE_API_KEY line is empty")

    def test_a_key_line_in_another_form(self):
        self.write("EXAMPLE_API_KEY = abcdef123\n")
        title, sub = self.key_row()
        self.assertEqual(title, "The EXAMPLE_API_KEY line is not in the form EXAMPLE_API_KEY=<key>")
        self.assertIn("no space before the = sign", sub)

    def test_a_key_file_without_the_key_line(self):
        self.write("example_api_key=abcdef123\n")
        title, sub = self.key_row()
        self.assertEqual(title, "No EXAMPLE_API_KEY line in the key file")
        self.assertIn("case sensitive", sub)

    def test_no_key_file_keeps_the_setup_row(self):
        self.assertEqual(self.key_row()[0], "Add your Example Service API key")


class KeyAdviceWords(unittest.TestCase):
    """Each reason the kit gives for refusing a key gets its own fix; a reason it does not know is shown as it is."""

    @classmethod
    def setUpClass(cls):
        cls.m = load_engine()   # any copy: they are the same file

    def advice(self, problem):
        return self.m.key_advice({"id": "demo-app"}, {"key_env": "DEMO_KEY", "env_file": "/nowhere/demo.env.test"}, problem)

    def test_every_kit_reason_has_its_fix(self):
        self.assertEqual(self.advice("/nowhere/demo.env.test is not owned by you")[0], "The key file belongs to another user")
        self.assertEqual(self.advice("/nowhere/demo.env.test is a link, which is not followed")[0], "The key file is a link")
        self.assertEqual(self.advice("/nowhere/demo.env.test can be read by other users")[0], "Tighten the permissions on the key file")
        self.assertEqual(self.advice("the key DEMO_KEY is shorter than 3 characters, so it cannot be hidden from API answers; use a real key")[0],
                         "The DEMO_KEY key is too short")

    def test_an_unknown_reason_is_shown(self):
        self.assertEqual(self.advice("the keychain is locked"), ("The DEMO_KEY key was not used", "the keychain is locked; fix that, then press Enter"))

    def test_the_kit_reasons_are_the_ones_matched(self):
        """If the kit rewords a reason, this fails before a person sees the general row."""
        with open(os.path.join(HERE, "..", "bolt_app_kit", "secrets.py")) as f:
            src = f.read()
        for words, _, _ in self.m.KEY_FIXES:
            self.assertIn(words, src)


class OtherIds(LiveBase):
    """Ids that are not nav tokens (an accent, another script, a slash, more than 64 characters) still drill, each to its own item."""
    IDS = {"P-1": "café", "P-2": "cafè", "P-3": "東京", "P-4": "a/b " + "x" * 80}

    def setUp(self):
        LiveBase.setUp(self)
        fx = json.loads(json.dumps(Server.payload))
        for p in fx["projects"]["data"]:
            p["id"] = self.IDS[p["id"]]
        for t in fx["tickets"]["data"]:
            t["projectId"] = self.IDS.get(t["projectId"], t["projectId"])
        Server.payload = fx

    def test_every_id_drills_to_its_own_item(self):
        d = self.folder()
        items = [r for r in self.rows(["projects"], d) if r.get("kpi_label") == "Progress"]
        self.assertEqual(len(items), 4)
        args = [(r.get("nav") or {}).get("arg") for r in items]
        self.assertTrue(all(args), "every project row drills: %r" % args)
        self.assertEqual(len(set(args)), 4, "no two ids share a nav arg: %r" % args)
        for r in items:
            rows = self.rows(["projects", r["nav"]["arg"]], d)
            self.assertEqual([x["title"] for x in rows if x.get("kpi_label") == "Progress"], [r["title"]], "Enter opens that project")
            self.assertTrue(rows[0]["subtitle"].startswith("Back to projects"))
            self.assertEqual(rows[-1]["nav"], {"view": "projects", "arg": "refresh." + r["nav"]["arg"]}, "its refresh keeps the detail")

    def test_a_plain_id_keeps_its_arg(self):
        self.assertEqual(load_engine().item_id({}, {"id": "P-1"}), "P-1")
        self.assertEqual(load_engine().item_id({}, {"id": "TK_12.3"}), "TK_12.3")

class OneLineYaml(unittest.TestCase):
    """--emit-yaml refuses a value with a line break, names the config key, writes nothing and exits 1."""

    def emit(self, app, change):
        cfg = cfg_of(app)
        change(cfg)
        return run(app, ["--emit-yaml"], cfg=cfg)

    def assert_refused(self, r, where):
        self.assertEqual(r.returncode, 1, r.stdout[:200])
        self.assertEqual(r.stdout, "")
        self.assertIn("config.json: %s holds a line break" % where, r.stderr)

    def test_a_line_break_in_the_description(self):
        self.assert_refused(self.emit("portal-template", lambda c: c["app"].update(description="Line one\nline two")), "app.description")

    def test_a_line_break_in_a_field_label(self):
        self.assert_refused(self.emit("portal-template", lambda c: c["views"][0]["item"]["fields"][1].update(label="Lead\r\nperson")),
                            "views[0].item.fields[1].label")

    def test_a_line_break_in_a_lookup_example(self):
        self.assert_refused(self.emit("lookup-template", lambda c: c["lookup"]["examples"].append("New York")), "lookup.examples[3]")

    def test_a_line_break_in_a_widget_bind(self):
        self.assert_refused(self.emit("lookup-template", lambda c: c["lookup"]["widget"]["bind"].update(body="## Weather\n{{row.body}}")),
                            "lookup.widget.bind.body")

    def test_a_body_template_with_line_breaks_is_fine(self):
        r = self.emit("portal-template", lambda c: None)   # item bodies hold \n: they are row text, not app file values
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(r.stdout.startswith("# Generated by"))


ENGINE_APPS = sorted(a for a in os.listdir(EX) if os.path.exists(os.path.join(EX, a, "scripts", a + "__engine.py")))


class FixtureAnswers(http.server.BaseHTTPRequestHandler):
    """Every endpoint of one app answers its sample answer at /ep/<name>; a hydrated endpoint answers its ids there and each item at
    /ep/<name>/item/<id>. hits counts the requests."""
    answers, hydrated, hits = {}, set(), []

    def log_message(self, *a):
        pass

    def do_GET(self):
        FixtureAnswers.hits.append(self.path)
        parts = self.path.split("?")[0].strip("/").split("/")
        ans = FixtureAnswers.answers.get(parts[1]) if len(parts) > 1 else None
        body = None
        if len(parts) == 2 and ans is not None:
            body = [x.get("id") for x in ans] if parts[1] in FixtureAnswers.hydrated else ans
        elif len(parts) == 4 and isinstance(ans, list):
            body = next((x for x in ans if str(x.get("id")) == parts[3]), None)
        data = json.dumps(body).encode()
        try:
            self.send_response(200 if body is not None else 404)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except OSError:
            pass


class WideServer(http.server.ThreadingHTTPServer):
    request_queue_size = 64   # an app reads up to nine endpoints at once; the default backlog of 5 refuses some of them on macOS


class CacheRowsInEveryApp(unittest.TestCase):
    """For every app built on the engine, with its own config.json and fixtures.json served live: the rows of a second run, read from
    the cache (cut to the fields config.json names), equal the rows of the first run, read from the answers. Views mode: the overview,
    each view and the detail of the first item each drilling view lists. Lookup: the first example. Form: a plain run."""

    def setUp(self):
        self.srv = WideServer(("localhost", 0), FixtureAnswers)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.dirs = []

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        for d in self.dirs:
            shutil.rmtree(d, ignore_errors=True)

    def live(self, app):
        cfg, fx = cfg_of(app), fixtures_of(app)
        cfg["api"] = dict(cfg.get("api") or {}, base_url="http://localhost:%d" % self.srv.server_address[1], fixture_default=False, on_missing_key="setup")
        for n, ep in (cfg.get("endpoints") or {}).items():
            ep["path"] = "/ep/" + n
            if ep.get("hydrate"):
                ep["hydrate"]["path"] = "/ep/%s/item/{id}" % n
        FixtureAnswers.answers = fx
        FixtureAnswers.hydrated = set(n for n, ep in (cfg.get("endpoints") or {}).items() if ep.get("hydrate"))
        return cfg

    def run_twice(self, app, cfg, args):
        """(rows read from the answers, rows read from the cache, requests the second run made)"""
        d = tempfile.mkdtemp()
        self.dirs.append(d)
        scripts = os.path.join(EX, app, "scripts")
        for f in os.listdir(scripts):
            if f.endswith((".py", ".json")):
                shutil.copy(os.path.join(scripts, f), os.path.join(d, f))
        with open(os.path.join(d, app + "__config.json"), "w") as f:
            json.dump(cfg, f)
        e = dict(os.environ)
        e.update({"HOME": d, "PYTHONDONTWRITEBYTECODE": "1", "BOLT_APP_FIXTURE": "0"})
        if cfg["api"].get("key_env"):
            e[cfg["api"]["key_env"]] = "abcdef123456"
        out = []
        for _ in range(2):
            del FixtureAnswers.hits[:]
            r = subprocess.run([sys.executable, os.path.join(d, app + "__engine.py")] + args, env=e, capture_output=True, text=True, cwd=d)
            self.assertEqual(r.returncode, 0, "%s %s: %s" % (app, args, r.stderr[-300:]))
            out.append([x for x in json.loads(r.stdout) if x.get("kpi_badge") != "CACHED"])   # the cache row is drawn once the copy is 2 s old
        return out[0], out[1], list(FixtureAnswers.hits)

    def cases(self, app, cfg):
        mode = cfg.get("mode", "views")
        if mode == "form":
            return [[]]
        if mode == "lookup":
            return [(cfg["lookup"].get("examples") or ["demo"])[0].split()[:3]]
        out = [["overview"]] + [[v["id"]] for v in cfg["views"]]
        for v in cfg["views"]:
            if v.get("children"):
                rows = self.run_twice(app, cfg, [v["id"]])[0]
                arg = next(((r.get("nav") or {}).get("arg") for r in rows if (r.get("nav") or {}).get("view") == v["id"]
                            and not str((r.get("nav") or {}).get("arg", "refresh")).startswith("refresh")), None)
                self.assertTrue(arg, "%s: view %s lists an item that drills" % (app, v["id"]))
                out.append([v["id"], arg])
        return out

    def test_rows_from_the_cache_equal_rows_from_the_answers(self):
        self.assertEqual(len(ENGINE_APPS), 14)
        ran = []
        for app in ENGINE_APPS:
            cfg = self.live(app)
            for args in self.cases(app, cfg):
                with self.subTest(app=app, args=args):
                    first, again, hits = self.run_twice(app, cfg, args)
                    self.assertGreater(len(first), 0)
                    self.assertNotIn("not set up correctly", json.dumps(first))
                    failed = ("Some data did not load", "Could not read", "is not answering", "Could not connect", "returned an error", "did not answer")
                    self.assertEqual([r["title"] for r in first if any(w in r["title"] for w in failed)], [], "every answer loaded")
                    ran.append((app, args))
                    if cfg.get("mode", "views") != "form":
                        self.assertEqual(hits, [], "the second run reads everything from the cache")
                    self.assertEqual(again, first)
        self.assertEqual(sorted(set(a for a, _ in ran)), ENGINE_APPS)
        sys.stderr.write("\n%d runs compared\n" % len(ran))


if __name__ == "__main__":
    unittest.main()
