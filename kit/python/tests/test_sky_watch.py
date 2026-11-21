"""sky-watch: the Launch Library list shape, the first FUTURE launch, old-copy labels on every row, flaky sources, view words, port and clock rules."""
import http.client
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import unittest
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
EX = os.path.abspath(os.path.join(HERE, "..", "..", "examples", "sky-watch", "scripts"))
sys.path.insert(0, os.path.join(HERE, ".."))
import bolt_app_kit as kit  # noqa: E402


def load():
    spec = importlib.util.spec_from_file_location("sky_watch_t", os.path.join(EX, "sky-watch__sky-watch.py"))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


class SkyWatch(unittest.TestCase):
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

    def ctx(self, fixture=True, force=False):
        return self.m.Ctx(self.cfg, self.fx, fixture, self.fx["_now"] if fixture else 1794765600, force)

    def test_list_mode_launches_read_flat_fields_and_never_print_none(self):
        rows = self.m.launch_rows(self.ctx(), self.fx["launches"], 5)
        text = json.dumps(rows)
        self.assertNotIn("None", text)
        self.assertNotIn(", ,", text)
        self.assertIn("Space Launch Complex 4E", text)
        self.assertIn("Vandenberg SFB, CA, USA", text)
        self.assertIn("SpaceX", text)
        # the detail shape reads too
        detail = {"results": [{"name": "X | Y", "net": "2026-11-20T11:00:00Z", "status": {"abbrev": "Go", "name": "Go for Launch"}, "launch_service_provider": {"name": "Acme"},
                               "pad": {"name": "Pad 1", "location": {"name": "Somewhere"}}, "url": "https://ll.thespacedevs.com/2.2.0/launch/x/"}]}
        t2 = json.dumps(self.m.launch_rows(self.ctx(), detail, 5))
        self.assertIn("Pad 1", t2); self.assertIn("Somewhere", t2); self.assertIn("Acme", t2); self.assertNotIn("None", t2)
        # a launch with nothing but a name is still a row, with no empty parts
        bare = json.dumps(self.m.launch_rows(self.ctx(), {"results": [{"name": "Bare", "net": "2026-11-20T11:00:00Z"}]}, 5))
        self.assertNotIn("None", bare); self.assertNotIn(", ,", bare); self.assertIn("no more detail listed", bare)

    def test_the_next_launch_is_the_first_future_one_not_a_launch_that_just_flew(self):
        up = self.m.upcoming(self.ctx(), self.fx["launches"])
        self.assertTrue(up and "Vulcan" not in up[0]["name"])
        self.assertEqual(up[0]["name"].split(" |")[0], "Long March 2D")
        rows = self.m.overview(self.ctx())
        tile = [r for r in rows if r.get("kpi_label") == "Days to next launch"][0]
        self.assertGreater(tile["kpi_value"], 3.0)
        self.assertLess(tile["kpi_value"], 4.0)   # 2026-11-18T22:50 from 2026-11-15T18:00

    def test_every_row_type_says_old_copy_when_the_network_is_dead(self):
        m = self.m
        calls = {"n": 0}

        def good(cfg, url, budget):
            calls["n"] += 1
            h = urllib.request.urlparse(url).hostname if hasattr(urllib.request, "urlparse") else m.urllib.parse.urlparse(url).hostname
            if h == "api.wheretheiss.at":
                return dict(self.fx["iss"])
            if h == "ll.thespacedevs.com":
                return dict(self.fx["launches"])
            if h == "earthquake.usgs.gov":
                return dict(self.fx["quakes"])
            if h == "geocoding-api.open-meteo.com":
                return dict(self.fx["geocode"]["paris"])
            return dict(self.fx["weather"])

        def dead(cfg, url, budget):
            raise m.Fail("timed out")
        real = m.fetch
        try:
            m.fetch = good
            for view, text in (("overview", ""), ("iss", ""), ("launches", ""), ("quakes", ""), ("weather", "Paris")):
                m.run_view(self.ctx(False, True), view, text)   # warm every cache
            m.fetch = dead
            for view, text in (("overview", ""), ("iss", ""), ("launches", ""), ("quakes", ""), ("weather", "Paris")):
                rows = [r for r in m.run_view(self.ctx(False, True), view, text) if r.get("sw_source")]
                self.assertTrue(rows, view)
                for r in rows:
                    self.assertIn("old copy", r["subtitle"], (view, r["title"]))
                    self.assertEqual(r["badge"], "OLD COPY", (view, r["title"]))
                    self.assertIn("Old copy:", r["body"], (view, r["title"]))
            # nothing warm and nothing live: one offline row, not a crash
            shutil.rmtree(self.home); os.makedirs(self.home)
            rows = m.run_view(self.ctx(False, True), "quakes", "")
            self.assertTrue(any("unavailable" in r["title"] for r in rows))
        finally:
            m.fetch = real

    def test_a_cut_short_answer_is_one_failed_source_not_a_crash(self):
        m = self.m

        class Op(object):
            def open(self, req, timeout=None):
                raise http.client.IncompleteRead(b"")
        real = urllib.request.build_opener
        urllib.request.build_opener = lambda *a: Op()
        try:
            with self.assertRaises(m.Fail) as e:
                m.fetch(self.cfg, "https://api.wheretheiss.at/v1/satellites/25544", 5)
            self.assertIn("cut short", str(e.exception))
        finally:
            urllib.request.build_opener = real

    def test_port_and_host_rules(self):
        for url in ("https://api.wheretheiss.at:8443/x", "http://api.wheretheiss.at/x", "https://evil.example/x"):
            with self.assertRaises(self.m.Fail):
                self.m.fetch(self.cfg, url, 5)

    def test_a_clock_a_few_seconds_ahead_is_just_now(self):
        c = self.ctx()
        self.assertEqual(self.m.when(c, c.now + 3), "just now")
        self.assertTrue(self.m.when(c, c.now + 3600).startswith("in "))


if __name__ == "__main__":
    unittest.main()


class SkyWatchMore(SkyWatch):
    def test_quake_count_is_the_feed_not_the_display_limit_and_the_list_is_biggest_first(self):
        feats = [{"properties": {"mag": 4.5 + i * 0.1, "place": "P%d" % i, "time": (self.fx["_now"] - 100 * i) * 1000}, "geometry": {"coordinates": [0, 0, 10]}} for i in range(14)]
        feats.insert(3, {"properties": {"mag": None, "place": "no magnitude"}, "geometry": {"coordinates": [0, 0, 1]}})
        d = {"features": feats}
        rows = self.m.quake_rows(self.ctx(), d, 10)
        self.assertEqual(len(rows), 10)
        mags = [float(r["sw_key"][1:]) for r in rows]
        self.assertEqual(mags, sorted(mags, reverse=True))
        self.assertEqual(len(self.m.valid_quakes(d)), 14)
        self.fx["quakes"] = d
        top = [r for r in self.m.overview(self.ctx()) if r.get("kpi_label") == "M4.5+ quakes"][0]
        self.assertEqual(top["kpi_value"], 14)
        self.assertIn("14 quakes", top["subtitle"]); self.assertIn("10 biggest", top["subtitle"])
        # equal magnitudes keep feed order
        eq = {"features": [{"properties": {"mag": 5.0, "place": n}, "geometry": {"coordinates": [0, 0, 1]}} for n in "abc"]}
        self.assertEqual([r["title"] for r in self.m.quake_rows(self.ctx(), eq, 10)], ["a", "b", "c"])

    def test_a_launch_with_no_net_says_unknown(self):
        out = json.dumps(self.m.launch_rows(self.ctx(), {"results": [{"name": "No date", "net": None, "status": {"abbrev": "TBC"}}, {"name": "No key", "status": {"abbrev": "TBC"}}]}, 5))
        self.assertNotIn("None", out)
        self.assertIn("NET unknown", out)

    def test_a_city_that_is_two_words_falls_back_to_the_first(self):
        rows = self.m.run_view(self.ctx(), "weather", "Paris France")
        self.assertTrue(any("Weather in Paris" in r["title"] for r in rows))
        rows = self.m.run_view(self.ctx(), "weather", "Nowhereville Atlantis")
        self.assertTrue(any("Place finder" in r["title"] or "No such place" in r["title"] for r in rows))
