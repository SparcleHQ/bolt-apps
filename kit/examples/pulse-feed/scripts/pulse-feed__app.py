#!/usr/bin/env python3
"""=pulse-feed [topic <word>]: trending Hacker News stories, or a topic that merges two public sources. A copyable layout example.

What it shows, in code you can read top to bottom:
  - no word: the front page. One request for the list of ids, then one request per story ("hydrate") in parallel
  - a topic word: two sources in parallel and merged: the front page filtered by the word, and the Algolia search API
  - a tile row on top ("Trending: 30 stories"), then one row per story with a trend icon and an open-link arrow
  - a preview pane per story (SOURCE, AUTHOR, AGE, SCORE and a markdown body with a safety note)
  - footer buttons: Open post (a link), Copy quote (into the composer); drilling is by row nav: the Narrow rows open a topic
  - sample mode: BOLT_APP_FIXTURE=1 reads scripts/<app id>__fixtures.json, no network (this is what `bolt-apps check` runs)
No key is needed. Both APIs are free and public. Everything the person sees goes through kit rows."""
import os as _os
import sys as _sys

_sys.dont_write_bytecode = True   # Bolt installs the script folder as it is: no __pycache__ in it
_SELF = _os.path.basename(__file__)
_PFX = _SELF.partition("__")[0] + "__" if "__" in _SELF else ""   # Bolt keeps every app's scripts in ONE folder, so each file of this app is named <app id>__<name>
import importlib.util as _ilu
_spec = _ilu.spec_from_file_location("bolt_app_kit", _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), _PFX + "bolt_app_kit.py"))   # the kit sits beside the script under this app's own name (python -I drops the script folder from the path, so it is loaded by path)
kit = _sys.modules.get("bolt_app_kit")   # already imported: the test suite does this; a normal run never has
if kit is None and _os.path.exists(_spec.origin):
    kit = _ilu.module_from_spec(_spec)
    _sys.modules["bolt_app_kit"] = kit
    _spec.loader.exec_module(kit)
elif kit is None and _os.path.isdir(_os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "bolt_app_kit")):   # a bolt_app_kit package folder beside the script
    _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
    import bolt_app_kit as kit
elif kit is None:
    raise SystemExit("script files must be named <app id>__<name>: this one is %s and %s was not found beside it. Rename the files back, and do not run the script through a link." % (_SELF, _PFX + "bolt_app_kit.py"))

import concurrent.futures as cf
import html
import json
import math
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
FILE_WORDS = tuple(_PFX + w for w in ("config.json", "fixtures.json", "bolt_app_kit.py",))   # the helper files the bridge command names, so Bolt shows them in the approval
VIEWS = ("overview", "topic")
APP = "pulse-feed"
TOKEN = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,39}\Z")   # a topic is one plain lowercase word: it travels in a nav arg and a URL
HN_ITEM = "https://news.ycombinator.com/item?id=%d"
SAFETY = "Unmoderated public post, shown as is."


def load_json(name):
    with open(os.path.join(HERE, _PFX + name), "r", encoding="utf-8") as f:
        return json.load(f)


def split_args(argv):
    """The last words are the helper files the command lists, not input: drop exactly that group."""
    a = list(argv[1:])
    n = len(FILE_WORDS)
    if len(a) >= n and [os.path.basename(x) for x in a[-n:]] == list(FILE_WORDS):
        a = a[:-n]
    return [w for w in a if w != "-"]


# ------------------------------------------------------------------ the network

class Fail(Exception):
    def __init__(self, kind, msg):
        Exception.__init__(self, msg)
        self.kind, self.msg = kind, msg


class _SameHost(urllib.request.HTTPRedirectHandler):
    hosts = ()

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        u = urllib.parse.urlparse(newurl)
        if u.scheme != "https" or u.hostname not in self.hosts:
            raise Fail("fail", "redirected to a host this app does not use")
        return urllib.request.HTTPRedirectHandler.redirect_request(self, req, fp, code, msg, headers, newurl)


BUDGET = [0.0]   # the wall-clock time after which no request may still be reading (set in main)


def http_get(cfg, url):
    u = urllib.parse.urlparse(url)
    if u.scheme != "https" or u.hostname not in cfg["hosts"]:
        raise Fail("fail", "host not allowed")
    _SameHost.hosts = tuple(cfg["hosts"])
    req = urllib.request.Request(url, headers={"User-Agent": cfg["api"]["user_agent"], "Accept": "application/json"})
    try:
        with urllib.request.build_opener(_SameHost).open(req, timeout=cfg["api"]["call_timeout_s"]) as r:
            chunks, size = [], 0
            while True:   # read in pieces: a server that drips bytes must not outlive the budget (the socket timeout is per read)
                if BUDGET[0] and time.time() > BUDGET[0]:
                    raise Fail("fail", "timed out")
                piece = r.read(16384)
                if not piece:
                    break
                chunks.append(piece)
                size += len(piece)
                if size > cfg["api"]["max_bytes"]:
                    break
            raw = b"".join(chunks)
    except urllib.error.HTTPError as e:
        raise Fail("rate" if e.code == 429 else "fail", "answered %d" % e.code)
    except (urllib.error.URLError, OSError, ValueError) as e:
        raise Fail("fail", "timed out" if "timed out" in str(e) else "could not connect")
    if len(raw) > cfg["api"]["max_bytes"]:
        raise Fail("fail", "answer too large")
    try:
        return json.loads(raw.decode("utf-8", "replace"))
    except ValueError:
        raise Fail("fail", "answer was not JSON")


class Net(object):
    """Where answers come from: the two public APIs, or fixtures.json in sample mode. One place, so the rest of the code does not know which."""

    def __init__(self, cfg, fixture, demos):
        self.cfg, self.fixture, self.demos = cfg, fixture, demos
        self.fx = load_json("fixtures.json") if fixture else None

    def _guard(self):
        if "demo-offline" in self.demos or "demo-stale" in self.demos:
            raise Fail("fail", "could not connect")

    def top_ids(self):
        self._guard()
        raw = self.fx["topstories"] if self.fixture else http_get(self.cfg, self.cfg["sources"]["firebase"] + "/topstories.json")
        if not isinstance(raw, list):
            raise Fail("fail", "unexpected answer")
        return [i for i in raw if isinstance(i, int) and not isinstance(i, bool)]

    def item(self, i):
        if self.fixture:
            return None if "demo-partial" in self.demos else self.fx["items"].get(str(i))
        return http_get(self.cfg, "%s/item/%d.json" % (self.cfg["sources"]["firebase"], i))

    def search(self, topic, n):
        self._guard()
        if self.fixture:   # a recorded answer cannot search: keep the hits whose title has the word
            return {"hits": [h for h in self.fx["search"]["hits"] if topic in str(h.get("title", "")).lower()]}
        q = urllib.parse.urlencode({"query": topic, "tags": "story", "hitsPerPage": n})
        return http_get(self.cfg, self.cfg["sources"]["algolia"] + "?" + q)


# ------------------------------------------------------------------ normalise: raw answers to the stories this app shows

def good_url(v, i):
    """The link a row opens. Only an https address; a post without one opens its discussion page."""
    if isinstance(v, str) and re.match(r"^https://[\x21-\x7e]+\Z", v) and len(v) <= 2000 and "{" not in v and "}" not in v:
        return v
    return HN_ITEM % i


def plain(s, limit):
    """Text from a public post as plain words: entities decoded, then no angle brackets, brackets, parentheses, backticks or braces."""
    if not isinstance(s, str):
        return ""
    return kit.clean_text(re.sub(r"[<>\[\]()`{}]", " ", re.sub(r"<[^>]*>", " ", html.unescape(s))), limit)


def story(i, title, url, author, score, ts, comments, source):
    """One story, or None when a field is missing or not the right type (one odd post costs that post, not the list)."""
    if not isinstance(i, int) or isinstance(i, bool) or not isinstance(title, str):
        return None
    title = plain(title, 160)
    nums = (score, ts, comments)
    if not title or any(isinstance(n, bool) or not isinstance(n, (int, float)) or not math.isfinite(n) for n in nums):
        return None
    if not 0 <= ts < 4e9:
        return None
    return {"id": i, "title": title, "url": good_url(url, i), "author": plain(author, 40) or "unknown",
            "score": min(int(max(score, 0)), 10 ** 9), "ts": int(ts), "comments": min(int(max(comments, 0)), 10 ** 9), "source": source}


def n_firebase(d):
    if not isinstance(d, dict) or d.get("type") != "story" or d.get("dead") or d.get("deleted"):
        return None
    try:
        return story(d.get("id"), d.get("title"), d.get("url"), d.get("by"), d.get("score"), d.get("time"), d.get("descendants", 0), "HN front page")
    except (OverflowError, ValueError, TypeError):
        return None


def n_algolia(raw):
    out = []
    for h in (raw.get("hits") if isinstance(raw, dict) else None) or []:
        if not isinstance(h, dict):
            continue
        try:
            i = int(h.get("objectID"))
        except (TypeError, ValueError):
            continue
        try:
            s = story(i, h.get("title"), h.get("url"), h.get("author"), h.get("points") or 0, h.get("created_at_i"), h.get("num_comments") or 0, "HN search")
        except (OverflowError, ValueError, TypeError):   # NaN, Infinity or an odd type costs that hit only
            s = None
        if s:
            out.append(s)
    return out


# ------------------------------------------------------------------ fetch: ids, then every story in parallel (hydrate)

def hydrate(net, ids, deadline):
    """One request per id on daemon threads, inside the deadline. Returns (stories in the order of ids, how many did not answer).
    A thread still reading at the deadline is abandoned: it is a daemon, and the budget in http_get stops it reading on."""
    found, lock, todo = {}, threading.Lock(), list(ids)

    def work():
        while True:
            with lock:
                if not todo or time.time() > deadline:
                    return
                i = todo.pop(0)
            try:
                s = n_firebase(net.item(i))
            except Exception:   # an item that failed or was odd is skipped
                s = None
            if s:
                with lock:
                    found[i] = s

    threads = [threading.Thread(target=work, daemon=True) for _ in range(min(net.cfg["api"]["workers"], max(1, len(ids))))]
    for t in threads:
        t.start()
    for t in threads:
        t.join(max(0.1, deadline - time.time()))
    with lock:
        got = dict(found)
    return [got[i] for i in ids if i in got], len(ids) - len(got)


def front_page(net, n, deadline):
    ids = net.top_ids()[:n]
    return hydrate(net, ids, deadline)


def gather(net, topic):
    """(stories, notes). No topic: the front page. A topic: the front page scan and the search run side by side, then merge by id."""
    lim = net.cfg["limits"]
    deadline = time.time() + net.cfg["api"]["deadline_s"]
    notes = []
    if not topic:
        stories, missed = front_page(net, lim["trending"], deadline)
        if not stories:
            raise Fail("fail", "no story could be read")
        if missed:
            notes.append("%d of %d stories did not answer" % (missed, lim["trending"]))
        return stories, notes
    with cf.ThreadPoolExecutor(max_workers=2) as ex:
        scan = ex.submit(front_page, net, lim["scan"], deadline)
        srch = ex.submit(lambda: n_algolia(net.search(topic, lim["search"])))
        merged, failed = {}, []
        try:
            page, missed = scan.result(timeout=max(1, deadline - time.time()))
            if not page or missed * 2 >= lim["scan"]:   # most of the front page did not answer: say so, never hide it
                failed.append("HN front page")
            for s in page:
                if topic in s["title"].lower():
                    merged[s["id"]] = s
        except Exception:
            failed.append("HN front page")
        try:
            for s in srch.result(timeout=max(1, deadline - time.time())):
                if s["id"] in merged:
                    merged[s["id"]]["source"] = "both"
                else:
                    merged[s["id"]] = s
        except Exception:
            failed.append("HN search")
    if len(failed) == 2:
        raise Fail("fail", "neither source answered")
    if failed:
        notes.append("%s did not answer, showing the other source" % failed[0])
    return sorted(merged.values(), key=lambda s: (-s["score"], s["id"])), notes


# ------------------------------------------------------------------ cache: fresh and an old copy

class MemCache(object):
    """The part of kit.Cache this app uses, held in memory, with a fixed age so sample output is the same every time."""

    def __init__(self):
        self.d = {}

    def get(self, key):
        return self.d.get(key)

    def put(self, key, value):
        self.d[key] = value

    def age(self, key):
        return 3 * 3600


class Source(object):
    def __init__(self, cfg, net):
        self.cfg, self.net = cfg, net
        if net.fixture:   # sample mode keeps its cache in memory: a check run never reads or writes the real cache folder
            self.fresh, self.old = MemCache(), MemCache()
            return
        root = kit.cache.default_root(APP)
        shape = lambda v: isinstance(v, dict) and isinstance(v.get("stories"), list)
        self.fresh = kit.Cache(APP, cfg["cache"]["ttl"], shape, root=root + "/fresh")
        self.old = kit.Cache(APP, cfg["cache"]["stale_max"], shape, root=root + "/old")

    def get(self, topic, refresh=False):
        """(stories, state). state: stale (age or None), err, notes, cached (age in s). stories is None when nothing can be shown."""
        key = "t-" + (topic or "trending")
        if not refresh and not self.net.fixture:
            hit = self.fresh.get(key)
            if hit is not None:
                return hit["stories"], {"stale": None, "err": "", "notes": hit.get("notes", []), "cached": self.fresh.age(key) or 0}
        try:
            if "demo-stale" in self.net.demos:   # sample mode only: put an old copy in place first, then fail
                saved = self.net.demos
                self.net.demos = []
                st, nt = gather(self.net, topic)
                self.net.demos = saved
                self.old.put(key, {"stories": st, "notes": nt})
            stories, notes = gather(self.net, topic)
        except Fail as e:
            return self._fallback(key, e.msg)
        except Exception:   # an odd answer is unread, never a traceback
            return self._fallback(key, "unexpected answer")
        self.fresh.put(key, {"stories": stories, "notes": notes})
        if not notes:   # a partial answer must never replace a complete old copy
            self.old.put(key, {"stories": stories, "notes": notes})
        return stories, {"stale": None, "err": "", "notes": notes, "cached": 0}

    def _fallback(self, key, why):
        old = self.old.get(key)
        if old is not None:
            return old["stories"], {"stale": self.old.age(key) or 0, "err": why, "notes": [], "cached": 0}
        return None, {"stale": None, "err": why, "notes": [], "cached": 0}


# ------------------------------------------------------------------ rows

def narrow_word(title, skip=""):
    """A word to narrow to: the longest plain word of the title (5 or more letters), lowercase. None when there is none."""
    words = [w for w in re.findall(r"[a-z]{5,24}", title.lower()) if w != skip]
    return max(words, key=len) if words else None


def mdsafe(s):
    return re.sub(r"[^A-Za-z0-9 .,:/_-]", " ", s)


def story_row(s, now, topic):
    age = kit.fmt_duration(max(0, now - s["ts"]))
    host = kit.host_label(s["url"]) if not s["url"].startswith("https://news.ycombinator.com/") else "news.ycombinator.com"
    body = "%s, %s, posted %s ago.\n\nLink: %s\n\n%s" % (kit.fmt_count(s["score"], "point", "points"), kit.fmt_count(s["comments"], "comment", "comments"), age, mdsafe(host), SAFETY)
    return kit.safe_row(s["title"], "%s, %s, %s ago" % (kit.fmt_count(s["score"], "point", "points"), kit.fmt_count(s["comments"], "comment", "comments"), age),
                        icon="trending-up", pane="stories", url=s["url"], open_url=s["url"],
                        copy='"%s" - %s on Hacker News, %s' % (s["title"], s["author"], s["url"]), body=body,
                        story_source=s["source"], story_author=s["author"], story_age=age, story_score=s["score"], badge=("BOTH" if s["source"] == "both" else ""))


def banner(state, cfg):
    if state["stale"] is not None:
        return [kit.row("Showing an old copy", "%s is not answering (%s); this copy is %s old" % (cfg["app"]["service"], state["err"], kit.fmt_duration(state["stale"])), icon="Clock", badge="OLD COPY", copy=False)]
    return [kit.row("Partial result", n, icon="AlertCircle", badge="PARTIAL", copy=False) for n in state["notes"][:1]]


def build(topic, stories, state, cfg, fixture, now):
    rows = []
    if fixture:
        rows.append(kit.row("Sample data", "Fixture mode: no network. Unset BOLT_APP_FIXTURE for the live APIs", icon="FileText", badge="SAMPLE", copy=False))
    shown = stories[:cfg["limits"]["rows"]]
    if topic:
        head = "Topic %s: %s" % (kit.clean_text(topic, 40), kit.fmt_count(len(shown), "story", "stories"))
        sub = "front page and search merged. The Narrow rows below go deeper"
    else:
        head = "Trending: %s" % kit.fmt_count(len(shown), "story", "stories")
        sub = "the Hacker News front page, by rank. Type =pulse-feed topic and a word to search"
    rows += banner(state, cfg)
    rows.append(kit.row(head, sub, icon="TrendingUp", pane="stories", body=sub + ". Select a story below for its details, Open post and Copy quote.", tile=kit.tile("Stories", len(shown), "", None, note="topic %s" % topic if topic else "front page"), copy=False))
    if topic:
        rows.append(kit.row("Back to trending", "the front page without a topic", icon="arrow-left", nav={"view": "overview"}, copy=False))
    seen = []
    for s in shown:
        w = narrow_word(s["title"], topic)
        if w and w not in seen:
            seen.append(w)
    rows += [kit.row("Narrow to %s" % w, "stories about %s: the front page and a search, merged" % w, icon="Search", nav={"view": "topic", "arg": w}, pane="stories", body="Press Enter to narrow the list to stories about %s: the front page and a search, merged." % w, copy=False) for w in seen[:3]]
    if not shown:
        rows.append(kit.row("No story matches %s" % kit.clean_text(topic, 40), "Try a shorter word. Enter to go back to trending", icon="Search", nav={"view": "overview"}, copy=False))
    rows += [story_row(s, now, topic) for s in shown]
    rows.append(kit.refresh_row("topic" if topic else "overview", title="Check again", subtitle="Enter to fetch fresh data past the cache") if not topic else
                kit.row("Check again", "Enter to fetch fresh data past the cache", icon="RefreshCw", nav={"view": "topic", "arg": "refresh." + topic}, copy=False))
    return rows


def offline_rows(cfg, state, topic):
    nav = {"view": "topic", "arg": "refresh." + topic} if topic else {"view": "overview", "arg": "refresh"}
    return [kit.row("Could not reach %s" % cfg["app"]["service"], "%s. Enter to try again" % state["err"], icon="AlertCircle", badge="OFFLINE", copy=False),
            kit.row("Try again", "Enter to run again", icon="RefreshCw", nav=nav, copy=False)]


def emit_yaml(cfg):
    app = cfg["app"]
    words = " ".join("{{scripts_dir}}/%s" % f for f in FILE_WORDS)
    L = ["# Generated by: python3 scripts/" + _SELF + " --emit-yaml (edit config.json, not this file)", "schema_version: 1", "runtime: bridge", "id: %s" % app["id"], "chip: %s" % app["chip"],
         "title: %s" % json.dumps(app["title"]), "icon: %s" % app["icon"], "description: %s" % json.dumps(app["description"]),
         'placeholder_examples: ["Enter for trending", "topic rust", "topic weekly"]', "emits: Generic", "args:",
         '  - { name: view, from: "query.word(0)", default: overview }', '  - { name: arg, from: "query.word(1)", default: "-" }', "bridge:", "  command:"]
    for osn in ("macos", "linux"):
        L.append(('    %s: "python3 {{scripts_dir}}/' + _SELF + ' {{view}} {{arg}} %s"') % (osn, words))
    L += ["  parse: json", "  timeout_seconds: %d" % app["timeout"], "presentation:", "  widget: list", "  title_field: title", "  subtitle_field: subtitle", "  view_arg: view", "  views:"]
    for v in ("overview", "topic", "stories"):
        L += ["    %s:" % v, "      right_widget:", "        kind: entity_preview", "        mode: selected_row", "        bind:", '          title: "{{row.title}}"', '          subtitle: "{{row.subtitle}}"',
              "          fields:", '            - { label: SOURCE, value: "{{row.story_source}}" }', '            - { label: AUTHOR, value: "{{row.story_author}}" }',
              '            - { label: AGE, value: "{{row.story_age}}" }', '            - { label: SCORE, value: "{{row.story_score}}" }',
              '          body: "{{row.body}}"', "          actions:", '            - "open"', '            - "copy"']
    L += ["actions:", '  - { id: open, kind: url, target: row, label: "Open post", url_template: "{{row.open_url}}" }',
          '  - { id: copy, kind: composer, target: row, label: "Copy quote", insert: "{{row.copy_text}}" }']
    return "\n".join(L) + "\n"


# ------------------------------------------------------------------ main

def main(argv):
    global APP
    cfg = load_json("config.json")
    APP = cfg["app"]["id"]
    if "--emit-yaml" in argv:
        sys.stdout.write(emit_yaml(cfg))
        return
    words = split_args(argv)
    if words and words[0] in VIEWS:
        view, rest = words[0], words[1:]
    elif not words:
        view, rest = "overview", []
    else:   # a bare first word is not a declared view, and the launcher cannot route it: say how to ask for a topic
        kit.emit([kit.row("Type topic and a word", "for example =pulse-feed topic %s. A bare word is not a view" % (re.sub(r"[^a-z0-9]", "", words[0].lower())[:20] or "rust"), icon="Search", nav={"view": "overview"}, copy=False)])
    demos = [w for w in rest if w in ("demo-offline", "demo-stale", "demo-partial")]
    rest = [w for w in rest if w not in demos]
    refresh = bool(rest) and (rest[0] == "refresh" or rest[0].startswith("refresh."))
    topic = ""
    if view == "topic" and rest:
        t = rest[0][len("refresh."):] if rest[0].startswith("refresh.") else ("" if rest[0] == "refresh" else rest[0])
        topic = t.lower()
        if topic and not TOKEN.match(topic):
            kit.emit([kit.row("Use one plain word", "letters and digits only, for example =pulse-feed topic rust", icon="Search", nav={"view": "overview"}, copy=False)])
    elif view == "overview" and rest and rest[0] == "refresh":
        refresh = True
    env = os.environ.get("BOLT_APP_FIXTURE")
    fixture = (env == "1") if env in ("0", "1") else bool(cfg["api"]["fixture_default"])
    if not fixture:
        BUDGET[0] = time.time() + cfg["api"]["deadline_s"]
        # a last resort inside the launcher's timeout (timeout_seconds in the app file): whatever is still running, answer with one row and end the process
        wd = threading.Timer(cfg["api"]["deadline_s"] + 4, lambda: kit.emit([kit.error_row("Hacker News took too long. Press Enter to try again", title="Timed out")]))
        wd.daemon = True
        wd.start()
    net = Net(cfg, fixture, demos if fixture else [])
    now = net.fx["_now"] if fixture else int(time.time())
    stories, state = Source(cfg, net).get(topic, refresh=refresh)
    if stories is None:
        kit.emit(offline_rows(cfg, state, topic))
    kit.emit(build(topic, stories, state, cfg, fixture, now))


def run(argv):
    try:
        main(argv)
    except SystemExit:
        raise
    except kit.KitError as e:   # a row the contract refuses is the author's bug: say what it is
        kit.emit([kit.error_row("Row contract: %s" % kit.clean_text(str(e), 200), title="This app could not run")])
    except Exception as e:   # one plain row: never a traceback
        if os.environ.get("BOLT_APP_DEBUG"):   # bolt-apps run sets this: the real error goes to the terminal
            import traceback
            traceback.print_exc()
        kit.emit([kit.error_row("%s while building the rows. Run the script in a terminal to see why." % e.__class__.__name__)])


if __name__ == "__main__":
    run(sys.argv)
