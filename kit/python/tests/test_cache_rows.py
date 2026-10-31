import json, os, stat, sys, tempfile, unittest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import bolt_app_kit as k
from bolt_app_kit.icons_data import ICONS

HERE = os.path.dirname(os.path.abspath(__file__))
SCHEMA_DIR = os.path.join(HERE, "..", "..", "schema")
shape = lambda v: isinstance(v, dict) and isinstance(v.get("n"), int)


class CacheTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.root = os.path.join(self.tmp, "c")
        self.t = [1000.0]
        self.mk = lambda **kw: k.Cache("t", kw.pop("ttl", 45), shape, root=self.root, clock=lambda: self.t[0], **kw)

    def test_round_trip_and_ttl(self):
        c = self.mk()
        self.assertTrue(c.put("a", {"n": 1}))
        self.assertEqual(c.get("a"), {"n": 1})
        self.t[0] += 46
        self.assertIsNone(c.get("a"))

    def test_never_caches_failure(self):  # defect 10 / 1
        c = self.mk()
        self.assertFalse(c.put("a", {"n": 1}, ok=False))
        self.assertFalse(c.put("a", None))
        self.assertIsNone(c.get("a"))

    def test_shape_checked_on_read(self):
        c = self.mk()
        c.put("a", {"n": 1})
        path = c._path("a")
        doc = json.load(open(path)); doc["value"] = {"n": "x"}
        json.dump(doc, open(path, "w"))
        self.assertIsNone(c.get("a"))
        self.assertFalse(c.put("b", {"n": "x"}))  # bad shape never written

    def test_garbage_and_future_ts_are_misses(self):
        c = self.mk(); c.put("a", {"n": 1})
        open(c._path("a"), "w").write("{not json")
        self.assertIsNone(c.get("a"))
        c.put("a", {"n": 1}); doc = json.load(open(c._path("a"))); doc["ts"] = 9e9; json.dump(doc, open(c._path("a"), "w"))
        self.assertIsNone(c.get("a"))

    @unittest.skipIf(os.name == "nt", "symlinks")
    def test_symlinked_dir_disables_cache(self):
        target = os.path.join(self.tmp, "elsewhere"); os.mkdir(target)
        os.symlink(target, self.root)
        c = self.mk()
        self.assertFalse(c.enabled); self.assertFalse(c.put("a", {"n": 1})); self.assertEqual(os.listdir(target), [])

    @unittest.skipIf(os.name == "nt", "symlinks")
    def test_symlinked_entry_not_followed(self):
        c = self.mk(); c.put("a", {"n": 1})
        secret = os.path.join(self.tmp, "secret.json"); open(secret, "w").write('{"v":1,"key":"a","ts":1000,"value":{"n":9}}')
        os.unlink(c._path("a")); os.symlink(secret, c._path("a"))
        self.assertIsNone(c.get("a"))

    @unittest.skipIf(os.name == "nt", "mode bits")
    def test_group_writable_dir_disables(self):
        os.makedirs(self.root, 0o700); os.chmod(self.root, 0o777)
        self.assertFalse(self.mk().enabled)

    def test_prune_caps_entries(self):
        c = self.mk(max_entries=3)
        for i in range(8):
            self.t[0] += 1; c.put("k%d" % i, {"n": i})
        self.assertLessEqual(len([n for n in os.listdir(self.root) if n.endswith(".json")]), 3)

    def test_needs_shape(self):
        with self.assertRaises(TypeError):
            k.Cache("t", 5, None, root=self.root)


class RowTests(unittest.TestCase):
    def test_non_numeric_tile_value_raises(self):  # defect 2
        for bad in ("12", "-", float("nan"), float("inf"), True, [1]):
            with self.assertRaises(k.KitError):
                k.tile("x", bad)

    def test_unread_value_gives_no_tile(self):
        r = k.row("x", tile=k.tile("Disk", None))
        self.assertEqual((r["kpi_label"], r["kpi_value"]), ("", ""))
        self.assertEqual(k.validate_rows([r]), [])

    def test_footer_limit_with_manifest_copy(self):  # defect 8
        a = lambda i: k.action_copy("a%d" % i, "L%d" % i, "x")
        k.row("x", actions=[a(1), a(2)])
        with self.assertRaises(k.KitError):
            k.row("x", actions=[a(1), a(2), a(3)])
        k.row("x", actions=[a(1), a(2), a(3)], manifest_actions=0)

    def test_label_limit(self):
        k.action_copy("a", "x" * 14, "t")
        with self.assertRaises(k.KitError):
            k.action_copy("a", "x" * 15, "t")

    def test_nav_row_has_no_actions(self):
        with self.assertRaises(k.KitError):
            k.row("x", nav={"back": True}, actions=[k.action_copy("a", "A", "t")])

    def test_unknown_icon_rejected(self):
        with self.assertRaises(k.KitError):
            k.row("x", icon="nope")

    def test_hostile_text_is_neutralised(self):  # defect 7
        r = k.row("na‮me {{evil}}\x00", "​sub\U000E0041", body="l1\n\n\n{{x}} y", note_field="a‮b")
        s = json.dumps(r, ensure_ascii=False)
        for ch in ("‮", "​", "\U000E0041", "\x00", " ", "{{", "}}"):
            self.assertNotIn(ch, s)

    def test_field_names_cannot_override(self):
        with self.assertRaises(k.KitError):
            k.row("x", **{"kpi_value": 5})
        with self.assertRaises(k.KitError):
            k.row("x", **{"Bad": 5})

    def test_headline_refuses_all_clear_when_unread(self):  # defect 3
        ok = k.Probe("a", True, 1); bad = k.Probe("b", False)
        h = k.headline({"a": ok, "b": bad}, findings=0)
        self.assertFalse(h.all_clear); self.assertIn("b", h.text); self.assertNotIn("clear", h.text.lower())
        self.assertTrue(k.headline({"a": ok}).all_clear)
        self.assertFalse(k.headline({"a": ok}, findings=2).all_clear)

    def test_empty_headline_is_not_all_clear(self):
        self.assertFalse(k.headline({}).all_clear)

    def test_brace_flood_stays_within_limit(self):
        r = k.row("{{" * 100)
        self.assertLessEqual(len(r["title"]), 160)
        self.assertEqual(k.validate_rows([r]), [])
        self.assertNotIn("{{", k.tile("x", 1, "{{")["unit"])

    def test_trailing_newline_tokens_rejected(self):
        for bad in ({"view": "disk\n"}, {"view": "disk", "arg": "a\n"}):
            with self.assertRaises(k.KitError):
                k.row("x", nav=bad)

    def test_validate_rows_has_the_tile_footer_nav_rules(self):
        self.assertTrue(k.validate_rows([{"title": "x", "kpi_label": "Disk", "kpi_value": ""}]))
        self.assertTrue(k.validate_rows([{"title": "x", "nav": {"back": True}, "actions": [k.action_copy("a", "A", "t")]}]))

    def test_url_with_bidi_or_braces_rejected(self):
        for u in ("https://a.com/\u202e", "https://a.com/{{x}}", "https://a.com/ b"):
            with self.assertRaises(k.KitError):
                k.row("x", url=u)

    def test_fmt_num_agrees_with_tile(self):  # defect 9
        for x in (0.25, 0.35, 1.45, 2.675):
            self.assertEqual(float(k.fmt_num(x, 1)), k.tile("x", x)["value"])

    def test_bytes_carry_and_time_overflow(self):
        self.assertEqual(k.fmt_bytes(1023.7 * 1024), "1 MB")
        self.assertEqual(k.fmt_time(1e20, mode="clock"), "unknown")

    def test_private_suffix_keeps_owner_label(self):
        h = k.host_label("https://login.paypal.com.secure-verify.github.io", 24)
        self.assertIn("secure-verify.github.io", h)
        self.assertEqual(k.host_label("https://xn--pypal-4ve.com", 30), "xn--pypal-4ve.com")

    def test_copy_text_strips_fillers(self):
        self.assertEqual(k.safe_text("a\u3164b"), "a b")

    def test_cache_name_cannot_traverse(self):
        with self.assertRaises(ValueError):
            k.Cache("../../x", 5, shape)

    def test_shape_that_raises_is_a_miss(self):
        c = k.Cache("t", 45, lambda v: v["missing"], root=os.path.join(tempfile.mkdtemp(), "c"))
        self.assertFalse(c.put("a", {"n": 1}))
        self.assertIsNone(c.get("a"))

    def test_emit_compact_valid(self):
        s = k.emit([k.row("x")], exit=False)
        self.assertNotIn(" ", s.replace('"', "")[:0]); self.assertEqual(json.loads(s)[0]["title"], "x")
        self.assertNotIn(": ", s)

    def test_emit_invalid_prints_error_row_and_fails(self):
        import subprocess
        code = "import sys; sys.path.insert(0, %r); import bolt_app_kit as k; k.emit([{'subtitle': 1}])" % os.path.join(HERE, "..")
        r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
        self.assertEqual(r.returncode, 3)
        self.assertEqual(k.validate_rows(json.loads(r.stdout)), [])

    def test_rounding_one_rule(self):  # defect 9
        self.assertEqual([k.rnd(x) for x in (0.5, 1.5, 2.5, -0.5)], [1, 2, 3, 0])
        self.assertEqual(k.fmt_pct(2.5), "3%")

    def test_origin_never_through_generic_truncation(self):  # defect 11
        h = k.host_label("https://login.example.com.attacker-domain.net/x", 22)
        self.assertTrue(h.endswith("attacker-domain.net")); self.assertTrue(h.startswith("…"))
        self.assertFalse(h.endswith("…"))
        self.assertEqual(k.host_label("https://example.com@evil.net"), "evil.net")

    def test_no_env_driven_hooks(self):  # defect 12
        import re
        pkg = os.path.join(HERE, "..", "bolt_app_kit")
        for f in os.listdir(pkg):
            if f.endswith(".py"):
                with open(os.path.join(pkg, f), encoding="utf-8") as fh:
                    src = fh.read()
                hits = re.findall(r"os\.environ\S*|os\.getenv|getenv\(", src)
                if f == "probe.py":  # PATH lookup and the parent-environment copy for the locale: no named variables
                    self.assertEqual(sorted(hits), ["os.environ)", "os.environ.get(\"PATH\","], hits)
                else:
                    self.assertEqual(hits, [], f)


class DriftTests(unittest.TestCase):
    def test_icons_match_schema_and_json(self):
        s = json.load(open(os.path.join(SCHEMA_DIR, "row.schema.json")))
        j = json.load(open(os.path.join(SCHEMA_DIR, "icons.json")))
        self.assertEqual(set(s["$defs"]["icon"]["enum"]), set(ICONS))
        self.assertEqual(set(j["icons"]), set(ICONS))

    def test_packaged_schema_is_the_schema(self):
        a = json.load(open(os.path.join(SCHEMA_DIR, "row.schema.json")))
        b = json.load(open(os.path.join(HERE, "..", "bolt_app_kit", "row_schema.json")))
        self.assertEqual(a, b)


if __name__ == "__main__":
    unittest.main()
