import json, os, unittest, math
import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import bolt_app_kit as k

CASES = json.load(open(os.path.join(os.path.dirname(__file__), "..", "..", "conformance", "cases.json"), encoding="utf-8"))


def conv(a):
    if a == "__nan__":
        return float("nan")
    if isinstance(a, str) and a.startswith("__now:"):
        return ("now", float(a[6:]))
    return a


class Conformance(unittest.TestCase):
    def test_functions(self):
        for fn in ("fmt_pct", "fmt_bytes", "fmt_duration", "fmt_count", "fmt_time", "elide_end", "elide_left",
                   "host_label", "clean_text", "neutralise_braces", "safe_text", "safe_copy"):
            for args, expect in CASES[fn]:
                args = [conv(a) for a in args]
                kw = {}
                if fn == "fmt_time":
                    now = [a for a in args if isinstance(a, tuple)]
                    args = [a for a in args if not isinstance(a, tuple)]
                    if now:
                        kw["now"] = now[0][1]
                    if len(args) > 1:
                        kw["mode"] = args.pop()
                if fn == "safe_copy":
                    args = [[tuple(x) if isinstance(x, list) else x for x in args[0]]] if isinstance(args[0], list) else args
                with self.subTest(fn=fn, args=args):
                    self.assertEqual(getattr(k, fn)(*args, **kw), expect)

    def test_tile_rule(self):
        for c in CASES["tile_rule"]:
            args = [conv(a) for a in c["args"]]
            with self.subTest(args=args):
                if c.get("error"):
                    with self.assertRaises(k.KitError):
                        k.tile(*args)
                elif c["expect"] is None:
                    self.assertIsNone(k.tile(*args))
                else:
                    t = k.tile(*args)
                    for key, v in c["expect"].items():
                        self.assertEqual(t[key], v)

    def test_validate(self):
        for c in CASES["validate"]:
            with self.subTest(name=c["name"]):
                self.assertEqual(not k.validate_rows(c["rows"]), c["valid"], k.validate_rows(c["rows"]))


if __name__ == "__main__":
    unittest.main()
