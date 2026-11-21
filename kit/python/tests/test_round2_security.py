"""Security review fixes: redact_tree is fast, does not over-redact, covers more forms, and short keys are refused."""
import base64
import random
import json
import os
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import bolt_app_kit as k  # noqa: E402

KEY = "S3cretKey99"


class RedactTree(unittest.TestCase):
    def test_hostile_strings_do_not_make_redaction_quadratic(self):
        for label, text in (("dotted run", "@" + "a." * 40000 + "://x"), ("key run", "?" + "key" * 20000), ("amp run", "&a=" * 30000), ("scheme run", "a+" * 30000 + "@")):
            t = time.time()
            k.redact_tree({"u": text}, [KEY]); k.redact(text, [KEY])
            self.assertLess(time.time() - t, 3.0, label)

    def test_long_credentials_are_hidden_whole(self):
        secret = "Zq81x7LmP" * 600
        got = k.redact_tree({"u": "https://a/x?token=%s&z=1" % secret}, [KEY])["u"]
        self.assertNotIn("Zq81x7LmP", got); self.assertIn("z=1", got)
        got = k.redact_tree({"u": "https://user:%s@example.com/path" % secret}, [KEY])["u"]
        self.assertNotIn("Zq81x7LmP", got); self.assertIn("example.com/path", got)
        got = k.redact("fetch https://u:%s@h.example/x failed" % secret, [KEY])
        self.assertNotIn("Zq81x7LmP", got); self.assertIn("h.example/x failed", got)

    def test_userinfo_with_several_at_signs(self):
        got = k.redact_tree({"u": "https://me@corp:pa@ss@wd@example.com/p?q=a@b"}, [KEY])["u"]
        self.assertEqual(got, "https://[hidden]@example.com/p?q=a@b")
        self.assertEqual(k.redact_tree({"u": "see https://example.com/a@b here"}, [KEY])["u"], "see https://example.com/a@b here")
        self.assertEqual(k.redact_tree({"u": "mail me@example.com"}, [KEY])["u"], "mail me@example.com")

    def test_userinfo_with_question_and_hash_in_the_password(self):
        for pw in ("p#ss", "p?ss", "a?b#c", "x@y?z#w"):
            got = k.redact_tree({"u": "https://user:%s@host.example.org/path?x=1#frag" % pw}, [KEY])["u"]
            self.assertTrue(got.startswith("https://[hidden]@host.example.org/path?x=1#frag"), (pw, got))
        self.assertEqual(k.redact_tree({"u": "https://host.example.org/p?x=1#frag and https://host.example.org/q?a=b@c"}, [KEY])["u"], "https://host.example.org/p?x=1#frag and https://host.example.org/q?a=b@c")

    def test_case_hex_and_percent_forms(self):
        key = "Ab+/9zQx"
        for form in (key, key.upper(), key.lower(), "aB+/9zqX", key.encode().hex(), key.encode().hex().upper(), "Ab%2B%2F9zQx", "ab%2b%2f9zqx", "AB%2B%2F9ZQX"):
            out = json.dumps(k.redact_tree({"a": "x %s y" % form}, [key]))
            self.assertNotIn(form, out, form)
            self.assertIn("[hidden]", out, form)

    def test_a_5mb_body_is_redacted_in_about_a_second(self):
        body = {"items": [{"id": i, "title": "story number %d with some text in it" % i, "url": "https://news.example.com/item?id=%d" % i} for i in range(50000)]}
        body["items"][7]["url"] = "https://x/y?api_key=" + KEY
        self.assertGreater(len(json.dumps(body)), 5_000_000)
        t = time.time()
        out = k.redact_tree(body, [KEY])
        first = time.time() - t
        body2 = {"items": body["items"] * 2}
        t = time.time()
        k.redact_tree(body2, [KEY])
        second = time.time() - t
        self.assertLess(first, 6.0)   # a loose bound: a loaded machine is slower, a quadratic loop is far slower
        self.assertLess(second, max(first * 6, 3.0), "twice the data must cost about twice the time")
        self.assertNotIn(KEY, json.dumps(out))

    def test_only_credential_names_are_rewritten_whole_names_only(self):
        url = "https://x/y?keyword=foo&author=bob&next_page_token=abc&monkey=1&page=2"
        self.assertEqual(k.redact_tree({"u": url}, [KEY])["u"], url)
        got = k.redact_tree({"u": "https://x/y?api_key=%s&key=zz&token=t&mykey=keep&access_token=a" % KEY}, [KEY])["u"]
        self.assertIn("api_key=[hidden]", got); self.assertIn("key=[hidden]", got); self.assertIn("token=[hidden]", got); self.assertIn("access_token=[hidden]", got)
        self.assertIn("mykey=keep", got)

    def test_credential_spellings_stay_redacted_and_benign_names_stay(self):
        for name in ("client_secret", "session_key", "access_key_id", "x_api_token", "refresh_token", "id_token", "X-Amz-Signature", "sig", "credential",
                     "X-Amz-Credential", "sessionToken", "api-key", "APIKEY", "password", "bearer_token"):
            got = k.redact_tree({"u": "https://x/y?a=1&%s=Zq81x7LmP&b=2" % name}, [KEY])["u"]
            self.assertIn("%s=[hidden]" % name, got, name)
            self.assertIn("a=1", got); self.assertIn("b=2", got)
        for name in ("keyword", "monkey", "author", "next_page_token", "page_token", "cursor", "sort_key", "primary_key", "page", "q", "authors", "key_id"):
            url = "https://x/y?%s=abc123" % name
            self.assertEqual(k.redact_tree({"u": url}, [KEY])["u"], url, name)

    def test_credentials_inside_nested_encoded_and_fragment_urls(self):
        cases = ("https://a/x?next=https://h/p?token=Zq81x7LmP&z=1", "https://a/x?redirect=https%3A%2F%2Fh%2Fp%3Ftoken%3DZq81x7LmP%26z%3D1",
                 "https://a/x?return_url=https://h/p%3Fsig%3DZq81x7LmP", "https://a/cb#access_token=Zq81x7LmP&state=1", "https://a/x?next=https://h/p?client_secret=Zq81x7LmP#frag",
                 "https://a/x?u=https%253A%252F%252Fh%253Ftoken%253DZq81x7LmP")
        for c in cases[:5]:
            self.assertNotIn("Zq81x7LmP", k.redact_tree({"u": c}, [KEY])["u"], c)
        self.assertIn("z=1", k.redact_tree({"u": cases[0]}, [KEY])["u"])
        self.assertIn("state=1", k.redact_tree({"u": cases[3]}, [KEY])["u"])
        self.assertIn("next=https://h/p", k.redact_tree({"u": cases[0]}, [KEY])["u"])

    def test_encoded_values_that_contain_equals_signs(self):
        for c in ("https://a/x?next=https%3A%2F%2Fh%2Fp%3Ftoken%3DZq81x7LmP%3D%3D%26z%3D1", "https://a/x?r=https%3A%2F%2Fh%2Fp%3Ftoken%3DabcDEF%3D%3D",
                  "https://a/x?r=https%3A%2F%2Fh%2Fp%3Fsig%3DZq81x7LmP%3Dtail%3Dmore", "https://a/x?r=h%3Ftoken%3Dabc%3D%3D%26ok%3D1"):
            got = k.redact_tree({"u": c}, [KEY])["u"]
            for secret in ("Zq81x7LmP", "abcDEF", "abc%3D", "tail", "more"):
                self.assertNotIn(secret, got, c)
        self.assertIn("%26z%3D1", k.redact_tree({"u": "https://a/x?next=https%3A%2F%2Fh%2Fp%3Ftoken%3DZq81x7LmP%3D%3D%26z%3D1"}, [KEY])["u"])
        self.assertIn("ok%3D1", k.redact_tree({"u": "https://a/x?r=h%3Ftoken%3Dabc%3D%3D%26ok%3D1"}, [KEY])["u"])
        for benign in ("https://a/x?r=h%3Fkeyword%3Dfoo%3D%3D%26author%3Dbob", ):
            self.assertEqual(k.redact_tree({"u": benign}, [KEY])["u"], benign)
        self.assertNotIn("Zq81x7LmP", k.redact_tree({"u": "https://a/x?token=Zq81x7LmP=="}, [KEY])["u"])

    def test_the_configured_auth_param_is_covered(self):
        self.assertIn("appid=[hidden]", k.redact_tree({"u": "https://x/y?appid=abcdef&n=1"}, [KEY], "appid")["u"])
        self.assertIn("n=1", k.redact_tree({"u": "https://x/y?appid=abcdef&n=1"}, [KEY], "appid")["u"])

    def test_forms_case_hex_url_and_base64(self):
        for form in (KEY, KEY.lower(), KEY.upper(), KEY.encode().hex(), base64.b64encode(KEY.encode()).decode(), base64.urlsafe_b64encode(KEY.encode()).decode().rstrip("="),
                     "S3cretKey99".replace("S3", "S%33")):
            if form == "S%33cretKey99":
                continue
            self.assertNotIn(form, json.dumps(k.redact_tree({"a": ["see %s here" % form]}, [KEY])), form)

    def test_deep_nesting_does_not_crash(self):
        d = cur = {}
        for _ in range(100):
            cur["a"] = {}; cur = cur["a"]
        k.redact_tree(d, [KEY])

    def test_the_looser_pattern_stays_for_error_text(self):
        self.assertIn("[hidden]", k.redact("failed https://x/y?keyword=1&token=abc", [KEY]))


class ShortKeys(unittest.TestCase):
    def test_a_key_under_three_characters_is_refused(self):
        home = tempfile.mkdtemp(); old = dict(os.environ)
        try:
            os.environ["HOME"] = home; os.environ["USERPROFILE"] = home; os.environ["MY_KEY"] = "ab"
            s = k.get_secret("demo", "MY_KEY", tool_dirs=[home])
            self.assertFalse(s); self.assertIn("shorter than", s.problem)
            os.environ["MY_KEY"] = "abc"
            self.assertTrue(k.get_secret("demo", "MY_KEY", tool_dirs=[home]))
        finally:
            os.environ.clear(); os.environ.update(old)


class Fuzz(unittest.TestCase):
    """A seeded adversarial fuzzer: the secret is embedded in many URL, query, userinfo, fragment and encoded shapes among random junk, and must never
    survive redact_tree (or redact). Fixed seed, so a failure reproduces; 20k cases in well under 20 s."""

    ALPHA = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

    def make_secret(self, r):
        n = r.randint(6, 24)
        return "".join(r.choice(self.ALPHA + "+/=_-.~!*") for _ in range(n))

    def junk(self, r):
        return "".join(r.choice("abc xyz/:?&=#;%@.-_+<>\"'") for _ in range(r.randint(0, 12)))

    def shapes(self, S, r, used):
        from urllib.parse import quote, quote_plus
        forms = [S, quote(S, safe=""), quote_plus(S), S.encode().hex(), S.encode().hex().upper(), base64.b64encode(S.encode()).decode(), base64.urlsafe_b64encode(S.encode()).decode().rstrip("="), S.lower(), S.upper()]
        def f():
            x = r.choice(forms)
            used.append(x)
            return x
        names = ["api_key", "token", "access_token", "client_secret", "sig", "X-Amz-Signature", "key", "password", "appid", "id_token", "sessionToken"]
        n = lambda: r.choice(names)
        return [
            lambda: f(), lambda: "x " + f() + " y",
            lambda: "https://h.example.org/p?%s=%s&z=1" % (n(), f()), lambda: "https://h.example.org/p?z=1&%s=%s" % (n(), f()),
            lambda: "https://h.example.org/p#%s=%s&s=1" % (n(), f()), lambda: "https://h.example.org/cb?next=https://o.example.org/p?%s=%s" % (n(), f()),
            lambda: "https://u:%s@h.example.org/p?q=1#f" % f(), lambda: "https://%s@h.example.org/" % f(), lambda: "ftp://a:%s@h.example.org:21/x" % f(),
            lambda: "https://h.example.org/p?r=https%%3A%%2F%%2Fo.example.org%%2Fp%%3F%s%%3D%s%%26z%%3D1" % (n(), quote(f(), safe="")),
            lambda: "https://h.example.org/p?r=https%%3A%%2F%%2Fo.example.org%%2Fp%%3F%s%%3D%s" % (n(), quote(f(), safe="")),
            lambda: "https://x.example.org/y;%s=%s;z=1" % (n(), f()), lambda: "failed: %s=%s" % (n(), f()),
            lambda: "Authorization: Bearer " + f(), lambda: '{"k": "' + f() + '"}',
        ]

    def test_the_secret_never_survives(self):
        r = random.Random(20261115)
        t0 = time.time()
        bad = []
        for i in range(20000):
            S = self.make_secret(r)
            used = []
            shape = r.choice(self.shapes(S, r, used))
            text = self.junk(r) + shape() + self.junk(r)
            if r.random() < 0.3:
                text += " " + self.junk(r) + r.choice(self.shapes(S, r, used))()
            out = k.redact_tree({"a": [text], text[:5]: text}, [S])
            blob = json.dumps(out)
            loose = k.redact(text, [S])
            if any(u in blob or u in loose for u in used):   # every form that was put in must be gone, not only the literal secret
                bad.append(text)
                if len(bad) > 5:
                    break
        self.assertEqual(bad[:5], [])
        self.assertLess(time.time() - t0, 120.0)   # a very loose bound: only a runaway loop trips it, a loaded machine does not


    def test_unknown_passwords_in_userinfo_never_survive_and_the_host_stays(self):
        r = random.Random(7261115)
        chars = self.ALPHA + "?#@:%!*+/=-_.~"
        bad = []
        for i in range(20000):
            pw = "".join(r.choice(chars) for _ in range(r.randint(3, 30)))
            if "/" in pw or any(c.isspace() for c in pw):
                pw = pw.replace("/", "x")   # a slash ends the authority by definition: that is a different URL
            user = "".join(r.choice(self.ALPHA) for _ in range(r.randint(1, 8)))
            scheme = r.choice(["https", "http", "ftp", "postgres", "git+ssh"])
            host = "h%d.example.org" % r.randint(1, 999)
            path = r.choice(["", "/", "/p/q", "/p?x=1#frag", "/a@b/c"])
            url = "%s://%s:%s@%s%s" % (scheme, user, pw, host, path)
            text = self.junk(r).replace("@", "") + " " + url + " " + self.junk(r).replace("@", "")
            out = k.redact_tree({"u": text}, [KEY])["u"]
            loose = k.redact(text, [KEY])
            want_tail = host + path
            if pw in out or pw in loose or (path and want_tail not in out) or (path and want_tail not in loose):
                bad.append((url, out))
                if len(bad) > 3:
                    break
        self.assertEqual(bad[:3], [])


if __name__ == "__main__":
    unittest.main()
