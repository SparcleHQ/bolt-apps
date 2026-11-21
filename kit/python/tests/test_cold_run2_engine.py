"""Cold run 2: a text-only lookup result draws no tile, scoped (@scope/name) queries are percent-encoded into the path, and the
field_sum / field_max stats. Runs on Python 3.9. Nothing here ran inside a real Bolt."""
import http.server
import json
import os
import sys
import threading
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from test_cold_run_engine import cfg_of, run, EX  # noqa: E402


class LookupTextOnly(unittest.TestCase):
    def test_lookup_template_widget_is_a_selected_row_preview_with_no_waiver(self):
        cfg = cfg_of("lookup-template")
        w = cfg["lookup"]["widget"]
        self.assertEqual((w["kind"], w["mode"]), ("entity_preview", "selected_row"))
        self.assertIn("tiles_above", w["bind"])
        with open(os.path.join(EX, "lookup-template", "check.json"), encoding="utf-8") as f:
            self.assertNotIn("known_empty_tiles", json.load(f))

    def test_rows_without_a_number_carry_no_tile_fields_and_have_a_body(self):
        r = run("lookup-template", ["New", "York"], env={"BOLT_APP_FIXTURE": "1"})
        self.assertEqual(r.returncode, 0, r.stderr)
        rows = [x for x in json.loads(r.stdout) if x.get("title") != "Sample data"]
        text_only = [x for x in rows if x.get("kpi_value") in (None, "")]
        self.assertTrue(text_only, "the template has text-only rows (Coordinates, forecast link)")
        for x in text_only:
            self.assertFalse([k for k in x if k.startswith("kpi_") and x[k] not in ("", None)], x["title"])
        for x in text_only:
            self.assertTrue(str(x.get("body", "")).strip(), "a text-only row gives the pane a body: " + x["title"])


class Scoped(http.server.BaseHTTPRequestHandler):
    seen = []

    def log_message(self, *a):
        pass

    def do_GET(self):
        Scoped.seen.append(self.path)
        body = json.dumps({"name": "@types/node", "version": "9.9.9"}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)


class ScopedNames(unittest.TestCase):
    def setUp(self):
        Scoped.seen = []
        self.srv = http.server.HTTPServer(("localhost", 0), Scoped)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.base = "http://localhost:%d" % self.srv.server_address[1]

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()

    def test_at_and_slash_are_percent_encoded_in_one_path_segment(self):
        cfg = cfg_of("lookup-template")
        cfg["api"].update(base_url=self.base, fixture_default=False, allowed_hosts=[])
        cfg["api"].pop("key_env", None)
        cfg["endpoints"] = {"latest": {"path": "/{query}/latest", "kind": "object", "data": "", "require": ["version"]}}
        cfg["lookup"] = {"steps": ["latest"], "rows": [{"title": "{latest.name} {latest.version}", "body": "ok"}], "widget": cfg["lookup"]["widget"]}
        r = run("lookup-template", ["@types/node"], cfg=cfg, env={"BOLT_APP_FIXTURE": "0"})
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)[0]["title"], "@types/node 9.9.9")
        self.assertEqual(Scoped.seen, ["/%40types%2Fnode/latest"])


class FieldStats(unittest.TestCase):
    def test_field_sum_and_field_max_with_where(self):
        cfg = cfg_of("portal-template")
        ep = "tickets"
        fx = {ep: [{"id": "a", "n": 3, "s": "x", "flag": True}, {"id": "b", "n": 9, "s": "y"}, {"id": "c", "n": "4", "s": "x"}, {"id": "d", "s": "x"}]}
        cfg["stats"] = {"total": {"endpoint": ep, "field_sum": "n"}, "biggest": {"endpoint": ep, "field_max": "n"},
                        "x_total": {"endpoint": ep, "where": {"s": ["x"]}, "field_sum": "n"}, "none": {"endpoint": ep, "where": {"s": ["zzz"]}, "field_max": "n"},
                        "flagged": {"endpoint": ep, "where": {"flag": True}}}
        cfg["overview"] = {"rows": [{"title": "Total {total}", "subtitle": "max {biggest}, x {x_total}, none {none}, flagged {flagged}"}]}
        cfg["app"]["noun"] = "thing"
        with open(os.path.join(EX, "portal-template", "scripts", "portal-template__fixtures.json"), encoding="utf-8") as f:
            fixtures = json.load(f)
        fixtures.update(fx)
        r = run("portal-template", ["overview"], cfg=cfg, fixtures=fixtures, env={"BOLT_APP_FIXTURE": "1"})
        self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
        row = [x for x in json.loads(r.stdout) if str(x["title"]).startswith("Total")]
        self.assertTrue(row, r.stdout)
        self.assertEqual(row[0]["title"], "Total 16")   # 3 + 9 + "4" (a numeric string counts), the row with no n is skipped
        self.assertIn("max 9", row[0]["subtitle"])
        self.assertIn("x 7", row[0]["subtitle"])
        self.assertIn("flagged 1", row[0]["subtitle"])   # a plain true in where means equals, so a boolean flag works
        self.assertNotIn("none 0", row[0]["subtitle"])   # a stat with nothing to total is left out, never 0


class Hardening(unittest.TestCase):
    def portal(self, stats, rows, rowtpl="{s}"):
        cfg = cfg_of("portal-template")
        cfg["stats"] = stats
        cfg["overview"] = {"rows": [{"title": "T " + rowtpl, "subtitle": "x"}]}
        with open(os.path.join(EX, "portal-template", "scripts", "portal-template__fixtures.json"), encoding="utf-8") as f:
            fx = json.load(f)
        fx["tickets"] = rows
        return run("portal-template", ["overview"], cfg=cfg, fixtures=fx, env={"BOLT_APP_FIXTURE": "1"})

    def test_non_finite_values_are_skipped_not_a_crash(self):
        rows = [{"n": x} for x in ("inf", "nan", "1e999", "-Infinity", "5", 7)] + [{"n": float("inf")}]
        r = self.portal({"s": {"endpoint": "tickets", "field_sum": "n"}, "m": {"endpoint": "tickets", "field_max": "n"}}, rows, "{s} {m}")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual([x for x in json.loads(r.stdout) if x["title"].startswith("T ")][0]["title"], "T 12 7")

    def test_huge_integers_and_an_overflowing_sum_are_left_out_not_a_crash(self):
        big = 10 ** 400
        rows = [{"n": big}, {"n": -big}, {"n": 4}, {"n": 6}]
        r = self.portal({"s": {"endpoint": "tickets", "field_sum": "n"}, "m": {"endpoint": "tickets", "field_max": "n"}}, rows, "{s} {m}")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual([x for x in json.loads(r.stdout) if x["title"].startswith("T ")][0]["title"], "T 10 6")
        for field in ("field_sum", "field_max"):
            r = self.portal({"s": {"endpoint": "tickets", field: "n"}}, [{"n": big}, {"n": -big}], "{s}")
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual([x for x in json.loads(r.stdout) if x["title"].startswith("T ")][0]["title"], "T unknown")
        r = self.portal({"s": {"endpoint": "tickets", "field_sum": "n"}}, [{"n": 1e308}, {"n": 1e308}], "{s}")
        self.assertEqual([x for x in json.loads(r.stdout) if x["title"].startswith("T ")][0]["title"], "T unknown")
        r = self.portal({"a": {"endpoint": "tickets", "field_sum": "n"}, "s": {"sum": ["a", "a"]}}, [{"n": 1e308}], "{s}")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual([x for x in json.loads(r.stdout) if x["title"].startswith("T ")][0]["title"], "T unknown")

    def test_unknown_where_comparison_is_a_config_error(self):
        r = self.portal({"s": {"endpoint": "tickets", "where": {"n": {"between": [1, 5]}}}}, [{"n": 3}])
        self.assertIn("unknown comparison", r.stdout)
        self.assertIn("gt, gte, lt, lte", r.stdout)

    def test_a_lone_dot_segment_query_is_percent_encoded(self):
        eng = __import__("test_cold_run_engine").load_engine()
        for q, want in (("..", "/%2E%2E/x"), (".", "/%2E/x"), ("a.b", "/a.b/x")):
            self.assertEqual(eng.fill_path("/{query}/x", {"query": q}), want)


class BackRowPane(unittest.TestCase):
    """The first row of a drilled list is selected on arrival: its Back row must give a field-binding pane something to draw."""

    def test_kit_back_refresh_and_note_rows(self):
        sys.path.insert(0, os.path.join(HERE, "..", "..", "python"))
        import bolt_app_kit as kit
        bare = kit.back_row("Back to the overview")
        self.assertNotIn("pane", bare)
        self.assertEqual(bare["body"], "")
        noted = kit.back_row("Back to the overview", view=kit.NOTE_VIEW)
        self.assertEqual((noted["pane"], noted["nav"]), ("note", {"back": True}))
        self.assertIn("Esc or Left", noted["body"])
        self.assertEqual(kit.refresh_row("items")["pane"], "items")
        r = kit.refresh_row("items", pane=kit.NOTE_VIEW)
        self.assertEqual((r["pane"], r["body"]), ("note", kit.REFRESH_BODY))
        n = kit.note_row("Not found", "no item with id 9")
        self.assertEqual((n["pane"], n["body"], n["copy_text"]), ("note", "no item with id 9", ""))

    def test_engine_back_row_in_a_detail_view_points_at_the_note_view(self):
        r = run("widget-gallery", ["detail"], env={"BOLT_APP_FIXTURE": "1"})
        self.assertEqual(r.returncode, 0, r.stderr)
        rows = json.loads(r.stdout)
        for x in rows:
            if (x.get("nav") or {}).get("back") or (x.get("nav") or {}).get("arg") == "refresh":
                self.assertEqual(x.get("pane"), "markdown", x["title"])   # widget-gallery has 8 views already: it reuses its markdown view as the note
                self.assertTrue(x["body"].strip(), x["title"])
        self.assertTrue([x for x in rows if (x.get("nav") or {}).get("back")])

    def test_engine_note_view_is_reused_or_skipped_at_the_8_view_limit(self):
        eng = __import__("test_cold_run_engine").load_engine()
        cfg = cfg_of("widget-gallery")
        self.assertEqual(eng.note_plan(cfg), ("markdown", False))
        cfg["views"] = [v for v in cfg["views"] if v["id"] != "markdown"]
        self.assertEqual(eng.note_plan(cfg), ("note", True))
        cfg["views"] = cfg["views"] + [dict(cfg["views"][0], id="x%d" % i) for i in range(2)]
        self.assertIsNone(eng.note_plan(cfg), "no room for a 9th view: no pane is invented")
        self.assertIsNone(eng.note_plan(cfg_of("places-list")), "entity_preview views bind the row title already")

    def test_engine_back_row_in_an_entity_preview_view_is_unchanged(self):
        r = run("places-list", ["places"], env={"BOLT_APP_FIXTURE": "1"})
        rows = json.loads(r.stdout)
        back = [x for x in rows if (x.get("nav") or {}).get("back")]
        self.assertTrue(back)
        self.assertNotEqual(back[0].get("pane"), "note")

    def test_apps_with_a_field_binding_pane_declare_the_note_view(self):
        for app in ("widget-gallery-2", "pipeline-board", "chart-template", "json-tree-browser", "around", "repo-radar", "script-template"):
            d = os.path.join(EX, app, "utilities")
            with open(os.path.join(d, [f for f in os.listdir(d) if f.endswith(".yaml")][0]), encoding="utf-8") as f:
                y = f.read()
            self.assertIn("\n    note:\n      right_widget:\n        kind: markdown\n        mode: selected_row\n", y, app)


class NotePlanNames(unittest.TestCase):
    def test_taken_note_name_falls_back_and_both_taken_gives_none(self):
        eng = __import__("test_cold_run_engine").load_engine()
        cfg = cfg_of("widget-gallery-2")
        self.assertEqual(eng.note_plan(cfg), ("note", True))
        cfg["views"] = cfg["views"] + [dict(cfg["views"][0], id="note")]
        self.assertEqual(eng.note_plan(cfg), ("back-note", True))
        cfg["views"] = cfg["views"] + [dict(cfg["views"][0], id="back-note")]
        self.assertIsNone(eng.note_plan(cfg))
        self.assertIn("    back-note:", "".join(l + "\n" for l in eng.note_lines("back-note")))


if __name__ == "__main__":
    unittest.main()
