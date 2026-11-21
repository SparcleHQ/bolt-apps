"""Review fixes: key file handling and redaction."""
import base64
import os
import stat
import sys
import tempfile
import time
import unittest
import urllib.parse

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import bolt_app_kit as k  # noqa: E402


class KeyFile(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()

    def f(self, body, mode=0o600):
        p = os.path.join(self.d, ".env")
        with open(p, "w", encoding="utf-8") as fh:
            fh.write(body)
        os.chmod(p, mode)
        return p

    @unittest.skipIf(os.name == "nt", "symlinks")
    def test_symlink_is_refused(self):
        real = self.f("MY_KEY=abc12345\n")
        link = os.path.join(self.d, "link.env")
        os.symlink(real, link)
        s = k.secrets._from_file("demo", "MY_KEY", path=link)
        self.assertFalse(s)
        self.assertIn("link", s.problem)

    def test_export_and_comments_are_read_safely(self):
        for body, want in (("export MY_KEY=abc12345\n", "abc12345"), ("MY_KEY=abc12345 # my key\n", "abc12345"), ('MY_KEY="a b#c"\n', "a b#c"),
                           ("# MY_KEY=old\nMY_KEY='zzz99999'\n", "zzz99999")):
            s = k.secrets._from_file("demo", "MY_KEY", path=self.f(body))
            self.assertEqual(s.value, want, body)

    def test_a_comment_needs_a_space_or_tab_before_the_hash(self):
        s = k.secrets._from_file("demo", "MY_KEY", path=self.f("MY_KEY=abc#def12345 # note\n"))
        self.assertEqual(s.value, "abc#def12345")
        s = k.secrets._from_file("demo", "MY_KEY", path=self.f("MY_KEY=abc12345\t# note\n"))
        self.assertEqual(s.value, "abc12345")

    def test_setup_hint_leaves_umask_alone(self):
        h = k.setup_hint("demo", "MY_KEY", os_="macos")
        self.assertNotIn("umask 077 &&", h)
        self.assertIn("(umask 077;", h)


class Redact(unittest.TestCase):
    def test_short_secret_and_encoded_forms(self):
        sec = "ab+/9z"
        for form in (sec, urllib.parse.quote(sec, safe=""), urllib.parse.quote_plus(sec), base64.b64encode(sec.encode()).decode()):
            self.assertNotIn(form, k.redact("error with %s inside" % form, [sec]), form)
        self.assertNotIn("xyz", k.redact("bad xyz here", ["xyz"]))



if __name__ == "__main__":
    unittest.main()
