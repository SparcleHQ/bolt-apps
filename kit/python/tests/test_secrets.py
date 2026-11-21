import os, stat, sys, tempfile, unittest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import bolt_app_kit as k


def stub(d, name, body):
    p = os.path.join(d, name)
    with open(p, "w", encoding="utf-8") as f:
        f.write("#!/bin/sh\n" + body + "\n")
    os.chmod(p, 0o755)


class SecretTests(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp()
        self.old = dict(os.environ)
        os.environ["HOME"] = self.home
        os.environ["USERPROFILE"] = self.home
        os.environ.pop("MY_KEY", None)
        self.tools = tempfile.mkdtemp()

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self.old)

    def env_file(self, mode=0o600, body="MY_KEY=file-secret-1\n"):
        p = k.env_file_path("demo")
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            f.write(body)
        os.chmod(p, mode)

    def get(self, **kw):
        return k.get_secret("demo", "MY_KEY", tool_dirs=[self.tools], **kw)

    def test_nothing_found(self):
        s = self.get()
        self.assertFalse(s)
        self.assertEqual(s.problem, "")

    @unittest.skipIf(os.name == "nt", "POSIX stubs")
    def test_env_beats_keychain_beats_file(self):
        self.env_file()
        stub(self.tools, "security", 'echo keychain-secret-2')
        stub(self.tools, "secret-tool", 'echo keychain-secret-2')
        self.assertEqual(self.get(os_="macos").value, "keychain-secret-2")
        os.environ["MY_KEY"] = "env-secret-3"
        s = self.get(os_="macos")
        self.assertEqual((s.value, s.source), ("env-secret-3", "env"))

    def test_file_is_used_when_there_is_no_keychain(self):
        self.env_file()
        s = self.get(os_="macos")
        self.assertEqual((s.value, s.source), ("file-secret-1", "file"))

    @unittest.skipIf(os.name == "nt", "mode bits")
    def test_loose_file_permissions_are_refused_and_explained(self):
        self.env_file(0o644)
        s = self.get(os_="macos")
        self.assertFalse(s)
        self.assertIn("other users", s.problem)

    @unittest.skipIf(os.name == "nt", "POSIX stubs")
    def test_failing_keychain_tool_is_not_a_hit(self):
        stub(self.tools, "security", 'exit 44')
        self.assertFalse(self.get(os_="macos"))

    def test_repr_never_shows_the_value(self):
        self.env_file()
        self.assertNotIn("file-secret-1", repr(self.get(os_="macos")))

    def test_bad_names_are_refused(self):
        with self.assertRaises(ValueError):
            k.get_secret("../x", "MY_KEY")
        with self.assertRaises(ValueError):
            k.get_secret("demo", "A B")

    def test_setup_hint_has_no_key_and_names_the_service(self):
        for o in ("macos", "linux", "windows"):
            h = k.setup_hint("demo", "MY_KEY", o)
            self.assertIn("MY_KEY", h)
        self.assertIn("bolt-app-demo", k.setup_hint("demo", "MY_KEY", "macos"))

    def test_hostile_key_in_an_error_message_and_in_a_url_is_redacted(self):
        key = "sk_live_abcDEF123456"
        msg = "HTTPError 401 for https://user:%s@api.example.com/v1/x?api_key=%s&other=1 body: Bearer %s rejected" % (key, key, key)
        out = k.redact(msg, [key])
        self.assertNotIn(key, out)
        self.assertIn("api.example.com", out)
        self.assertIn("other=1", out)
        # even when the key is unknown to the caller, the URL shapes are cleaned
        out2 = k.redact("GET https://bob:hunter2pw@h.example.com/?token=abc123xyz", [])
        self.assertNotIn("hunter2pw", out2)
        self.assertNotIn("abc123xyz", out2)

    def test_short_secrets_are_not_replaced_everywhere(self):
        self.assertEqual(k.redact("a b c", ["a"]), "a b c")


if __name__ == "__main__":
    unittest.main()
