#!/usr/bin/env python3
"""=script-template [view] [words]: a working script app on the Bolt Apps kit, and a tour of what a Bolt 181 app can show. It searches the Art Institute of Chicago's
public-domain artworks (no key). Copy this folder, then edit the lines marked EDIT HERE to point it at your own API.

What it shows, in code you can read top to bottom:
  - the views: overview (number tiles with a meter, a sparkline and a delta), items (a list with a search word and a small picture in the preview pane), item (one artwork with a big picture in a markdown pane, and with
    its description), pictures (a card grid), chart (a bar chart), table (sorted, with a total) and record (a json tree), every drill with a Back row
  - a call to an API with a host allowlist (every host it contacts is named in config.json), a refused redirect to another host, a size cap, a timeout and no cookies
  - pictures: the script fetches a small thumbnail from the allowlisted image host and puts it in the row as an inline data: image, because a Bolt user app pane
    never loads a web address. Row text fields are cut at 4,000 characters, so the image is split over fields (img1 to img4 for a small one, up to img24 for the big picture of the detail pane) and the app file joins them
  - a cache in two layers: fresh (config cache.ttl) and an old copy (cache.stale_max) shown when the API fails; thumbnails are cached for 30 days
  - the offline row and sample mode (BOLT_APP_FIXTURE=1, used by check)
  - --emit-yaml, which writes the app file from config.json so the two never disagree
Everything the person can see goes through kit rows, so text is cleaned and the contract is checked; text a person can paste goes through kit.safe_copy."""
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

import base64
import concurrent.futures as cf
import html
import http.client
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
FILE_WORDS = tuple(_PFX + w for w in ("config.json", "fixtures.json", "bolt_app_kit.py",))   # the helper files the bridge command names, so Bolt shows them in the approval
VIEWS = ("overview", "items", "item", "pictures", "chart", "table", "record")
APP = "script-template"   # replaced by config app.id at run time, so a copy with a new id has its own cache
TOKEN = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}\Z")   # what a nav arg may be: one plain word, never a path or text with spaces
ITEM_ID = re.compile(r"^[0-9]{1,9}\Z")   # EDIT HERE: what one of your record ids looks like
IMAGE_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z")   # an IIIF image id: it is put in a URL path, so it must be exactly this shape
B64 = re.compile(r"^/9j/[A-Za-z0-9+/]*={0,2}\Z")   # base64 of a JPEG (every JPEG starts with FF D8 FF, which is /9j/)
DATA_PREFIX = "data:image/jpeg;base64,"


load_json = kit.json_loader(HERE, _PFX)


# ------------------------------------------------------------------ the network: https, fixed hosts, same-host redirects, no cookies, timeout, size cap

Fail = kit.Fail


class _SameHost(urllib.request.HTTPRedirectHandler):
    hosts = ()

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        u = urllib.parse.urlparse(newurl)
        if u.scheme != "https" or u.port not in (None, 443) or u.hostname != urllib.parse.urlparse(req.full_url).hostname or u.hostname not in self.hosts:
            raise Fail("fail", "redirected to a host this app does not use")
        return urllib.request.HTTPRedirectHandler.redirect_request(self, req, fp, code, msg, headers, newurl)


def http_bytes(cfg, url, accept, cap, timeout):
    """One GET: https to a host in cfg["hosts"] only, no cookies and no credentials, at most `cap` bytes. Returns (bytes, too_big)."""
    u = urllib.parse.urlparse(url)
    if u.scheme != "https" or u.port not in (None, 443) or u.hostname not in cfg["hosts"]:
        raise Fail("fail", "host not allowed")
    headers = {"User-Agent": cfg["api"]["user_agent"], "Accept": accept}   # EDIT HERE if your API wants a header: headers["Authorization"] = "Bearer " + key
    _SameHost.hosts = tuple(cfg["hosts"])
    try:
        with urllib.request.build_opener(_SameHost).open(urllib.request.Request(url, headers=headers), timeout=max(1.0, timeout)) as r:
            raw = r.read(cap + 1)
    except urllib.error.HTTPError as e:
        raise Fail("notfound" if e.code == 404 else ("rate" if e.code == 429 else ("http" if 400 <= e.code < 500 else "fail")), "answered %d" % e.code)
    except http.client.HTTPException:   # IncompleteRead, BadStatusLine and the like
        raise Fail("fail", "the answer was cut short")
    except (urllib.error.URLError, OSError, ValueError) as e:
        raise Fail("fail", "timed out" if "timed out" in str(e) else "could not connect")
    return raw[:cap], len(raw) > cap


def http_json(cfg, url, budget):
    api = cfg["api"]
    raw, big = http_bytes(cfg, url, "application/json", api["max_bytes"], min(api["call_timeout_s"], budget))
    if big:
        raise Fail("fail", "answer too large")
    try:
        d = json.loads(raw.decode("utf-8", "replace"))
    except ValueError:
        raise Fail("fail", "answer was not JSON")
    if not isinstance(d, dict):
        raise Fail("fail", "answer was not an object")
    return d

# ------------------------------------------------------------------ reading the API's answer

def tidy(v, limit=None):
    """kit.clean_text, and the long dashes some API text carries become a comma (em dash) or a plain hyphen (en dash, as in 1594-1665). Normal hyphens are left alone."""
    if isinstance(v, str):
        v = re.sub(r"\s*\u2014\s*", ", ", v).replace("\u2013", "-")
    return kit.clean_text(v, limit)


def one_line(v, limit):
    return tidy(v.split("\n")[0] if isinstance(v, str) else "", limit)


def count(v):
    """A count from the API: a whole number in a sane range, else the answer is unread (never a 0 made up)."""
    if isinstance(v, bool) or not isinstance(v, int) or not 0 <= v < 10 ** 9:
        raise ValueError("a count was not a whole number")
    return v


def n_item(r, cfg):
    """EDIT HERE: turn one record of the API's answer into the record this app uses, or None when it has no usable id or title. A value that is the wrong type is
    left out of that record, never turned into 0 or "None"."""
    f = cfg["fields"]
    if not isinstance(r, dict):
        return None
    rid, title = str(r.get(f["id"], "")), r.get(f["title"])
    img = r.get(f["image"])
    if not ITEM_ID.match(rid) or not isinstance(title, str) or not tidy(title):
        return None
    year = r.get(f["year"])
    out = {"id": rid, "title": tidy(title, 140), "artist": one_line(r.get(f["artist"]), 90), "date": tidy(r.get(f["date"]), 40),
           "year": year if isinstance(year, int) and not isinstance(year, bool) and -5000 < year < 3000 else None,
           "medium": tidy(r.get(f["medium"]), 120), "place": tidy(r.get(f["place"]), 60), "department": tidy(r.get(f["department"]), 80),
           "public": r.get(f["public"]) is True,
           "image_id": img if isinstance(img, str) and IMAGE_ID.match(img) else ""}
    d = r.get(f["description"])
    if isinstance(d, str) and d:
        out["description"] = kit.clean_lines(re.sub(r"\s*\u2014\s*", ", ", re.sub(r"<[^>]+>", "", html.unescape(re.sub(r"</p>|<br\s*/?>", "\n\n", d)))).replace("\u2013", "-"), 12, 1400)
    for k in ("credit", "dimensions"):
        if isinstance(r.get(f[k]), str):
            out[k] = one_line(r.get(f[k]), 160)
    return out


def n_items(raw, cfg):
    """EDIT HERE: the list in the API's answer. This app keeps public-domain artworks that have a picture (the picture host serves those under CC0). An answer that has
    records but none usable is unread: raise ValueError and the whole answer counts as unread."""
    rows = raw.get(cfg["endpoints"]["items"]["data"])
    if not isinstance(rows, list):
        raise ValueError("no list in the answer")
    out = [i for i in (n_item(r, cfg) for r in rows) if i and i["public"] and i["image_id"]]
    if rows and not out and not any(isinstance(r, dict) and r.get(cfg["fields"]["public"]) is False for r in rows):
        raise ValueError("no record had the expected fields")
    return out


def n_facets(raw, cfg):
    """EDIT HERE: the counts that feed the tiles, the chart and the table: matches, public-domain matches, public-domain matches per period and per department."""
    a = (raw.get("aggregations") or {}).get("pd") if isinstance(raw.get("aggregations"), dict) else None
    pg = raw.get("pagination")
    if not isinstance(a, dict) or not isinstance(pg, dict):
        raise ValueError("no counts in the answer")
    per = [count(b.get("doc_count")) for b in a["periods"]["buckets"]]
    if len(per) != len(cfg["endpoints"]["items"]["periods"]):
        raise ValueError("a period is missing")
    depts = [[kit.clean_text(b.get("key"), 40), count(b.get("doc_count"))] for b in a["depts"]["buckets"] if isinstance(b.get("key"), str) and kit.clean_text(b.get("key"))]
    return {"all": count(pg.get("total")), "pd": count(a.get("doc_count")), "periods": per, "depts": depts, "other": count(a["depts"].get("sum_other_doc_count"))}


def period_labels(cfg):
    out = []
    for lo, hi in cfg["endpoints"]["items"]["periods"]:
        out.append("Before %d" % hi if lo is None else ("%d on" % lo if hi is None else "%d to %d" % (lo, hi)))
    return out


def period_index(cfg, year):
    for i, (lo, hi) in enumerate(cfg["endpoints"]["items"]["periods"]):
        if (lo is None or year >= lo) and (hi is None or year < hi):
            return i
    return None


def century(year):
    if year is None or year < 1:
        return ""
    c = (year - 1) // 100 + 1
    return "%d%s c." % (c, "th" if 10 <= c % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(c % 10, "th"))


def search_params(cfg, word):
    """EDIT HERE: the query. Every typed word is only a percent-encoded value, never a name or a path. The same words must appear in every field listed (operator and)."""
    ep = cfg["endpoints"]["items"]
    p = [("query[bool][must][0][multi_match][query]", word), ("query[bool][must][0][multi_match][operator]", "and")]
    return p + [("query[bool][must][0][multi_match][fields][%d]" % i, f) for i, f in enumerate(ep["search_fields"])]


def list_url(cfg, word):
    ep = cfg["endpoints"]["items"]
    q = search_params(cfg, word) + [("query[bool][filter][0][term][is_public_domain]", "true"), ("limit", str(ep["limit"])), ("fields", ep["fields"])]
    return cfg["api"]["base_url"].rstrip("/") + ep["path"] + "?" + urllib.parse.urlencode(q)


def facets_url(cfg, word):
    ep = cfg["endpoints"]["items"]
    q = search_params(cfg, word) + [("limit", "0"), ("aggs[pd][filter][term][is_public_domain]", "true"), ("aggs[pd][aggs][depts][terms][field]", "department_title.keyword"),
                                    ("aggs[pd][aggs][depts][terms][size]", str(ep["department_count"])), ("aggs[pd][aggs][periods][range][field]", "date_start")]
    for i, (lo, hi) in enumerate(ep["periods"]):
        if lo is not None:
            q.append(("aggs[pd][aggs][periods][range][ranges][%d][from]" % i, str(lo)))
        if hi is not None:
            q.append(("aggs[pd][aggs][periods][range][ranges][%d][to]" % i, str(hi)))
    return cfg["api"]["base_url"].rstrip("/") + ep["path"] + "?" + urllib.parse.urlencode(q)


# ------------------------------------------------------------------ the data: fresh cache, network, old copy; thumbnails beside it

class Source(object):
    def __init__(self, cfg, fixture, demos, fx):
        self.cfg, self.fixture, self.demos, self.fx = cfg, fixture, demos, fx
        c = cfg["cache"]
        root = kit.cache.default_root(APP)
        listy = lambda v: isinstance(v, dict) and isinstance(v.get("items"), list) and isinstance(v.get("facets"), dict)
        one = lambda v: isinstance(v, dict) and isinstance(v.get("item"), dict)
        thumb = lambda v: isinstance(v, dict) and isinstance(v.get("t"), str) and len(v["t"]) <= 16000 and bool(B64.match(v["t"]))
        flag = lambda v: isinstance(v, dict)
        self.fresh = kit.Cache(APP, c["ttl"], lambda v: listy(v) or one(v), root=root + "/fresh")
        self.old = kit.Cache(APP, c["stale_max"], lambda v: listy(v) or one(v), root=root + "/old")
        self.thumbs = kit.Cache(APP, c["thumb_ttl"], thumb, root=root + "/thumbs", max_entries=400)
        hero = lambda v: isinstance(v, dict) and isinstance(v.get("t"), str) and len(v["t"]) <= cfg["images"]["hero"]["chunk_chars"] * cfg["images"]["hero"]["max_chunks"] and bool(B64.match(v["t"]))
        self.heroes = kit.Cache(APP, c["thumb_ttl"], hero, root=root + "/heroes", max_entries=100)   # the big pictures of the list pane, kept as long as the small ones
        self.misses = kit.Cache(APP, c["miss_ttl"], flag, root=root + "/misses", max_entries=400)   # an image that could not be fetched is not asked for again for a while

    def _budget(self):
        return self.deadline - time.time()

    def _get(self, key, load, refresh):
        """(value, state): value is None when nothing can be shown. state {"stale": age or None, "err": text, "cached": age}."""
        if not refresh and not self.fixture:
            hit = self.fresh.get(key)
            if hit is not None:
                return hit, {"stale": None, "err": "", "cached": self.fresh.age(key) or 0}
        self.deadline = time.time() + self.cfg["api"]["deadline_s"]
        try:
            if "demo-offline" in self.demos or "demo-stale" in self.demos:
                if "demo-stale" in self.demos:
                    self.old.put(key, load(True))
                raise Fail("fail", "could not connect")
            val = load(self.fixture)
        except Fail as e:
            if e.kind == "notfound":
                return {"missing": True}, {"stale": None, "err": "", "cached": 0}
            return self._fallback(key, e.msg, e.kind)
        except Exception:   # an odd answer (a null, a huge number, a wrong shape) is unread, never a traceback
            return self._fallback(key, "unexpected answer")
        self.fresh.put(key, val)
        self.old.put(key, val)
        return val, {"stale": None, "err": "", "cached": 0}

    def _fallback(self, key, why, kind="fail"):
        old = self.old.get(key)
        if old is not None:
            return old, {"stale": self.old.age(key) or 0, "err": why, "cached": 0, "kind": kind}
        return None, {"stale": None, "err": why, "cached": 0, "kind": kind}

    def search(self, word, typed, refresh):
        """The artworks and the counts for a search word. In sample mode the recorded answers are used (a typed word narrows the recorded list on this side)."""
        cfg = self.cfg

        def load(sample):
            if sample:
                items = n_items(self.fx["search"], cfg)
                if typed:
                    items = [i for i in items if word.lower() in (i["title"] + " " + i["artist"]).lower()]
                return {"items": items, "facets": n_facets(self.fx["facets"], cfg)}
            items = n_items(http_json(cfg, list_url(cfg, word), self._budget()), cfg)   # typed text is only percent-encoded, into the query
            return {"items": items, "facets": n_facets(http_json(cfg, facets_url(cfg, word), self._budget()), cfg)}
        val, state = self._get("s:" + word.lower(), load, refresh)
        return val, state

    def detail(self, rid, refresh):
        cfg = self.cfg
        ep = cfg["endpoints"]["item"]

        def load(sample):
            if sample:
                raw = self.fx["details"].get(rid)
                if raw is None:   # a recorded list row with no recorded detail: show what the list knows
                    hit = next((i for i in n_items(self.fx["search"], cfg) if i["id"] == rid), None)
                    if hit is None:
                        raise Fail("notfound", "not found")
                    return {"item": hit}
            else:
                raw = http_json(cfg, cfg["api"]["base_url"].rstrip("/") + ep["path"] + rid + "?" + urllib.parse.urlencode([("fields", ep["fields"])]), self._budget())
            it = n_item(raw.get(ep["data"]), cfg)
            if it is None:
                raise Fail("notfound", "not found")
            return {"item": it}
        val, state = self._get("d:" + rid, load, refresh)
        if val is not None and val.get("missing"):
            return "missing", state
        return (val["item"] if val else None), state

    # ---- thumbnails

    def fetch_thumb(self, image_id, hero=False):
        """A JPEG from the picture host as base64, or None. Tries the widths in config images.widths (images.hero.widths for the big picture), widest first, until one fits max_bytes."""
        im = self.cfg["images"]
        spec = im["hero"] if hero else im
        for w in spec["widths"]:
            try:
                raw, big = http_bytes(self.cfg, "%s/%s/full/%d,/0/default.jpg" % (im["base_url"].rstrip("/"), image_id, w), "image/jpeg", spec["max_bytes"], min(im["call_timeout_s"], self._thumb_left()))
            except Fail:
                return None
            if big:
                continue   # too many bytes for the row fields: ask for a smaller one
            return base64.b64encode(raw).decode("ascii") if raw[:3] == b"\xff\xd8\xff" else None
        return None

    def _thumb_left(self):
        return max(1.0, self._thumb_end - time.time())

    def attach_thumbs(self, items, network):
        """Set item["img"] to an inline data: URL (or ""). Sample mode reads the recorded thumbnails; a live run reads the thumbnail cache and, when `network` is true, fetches the
        missing ones together with a small time budget. A failed one is left blank, never an error."""
        im = self.cfg["images"]
        need = []
        for it in items:
            b = None
            if self.fixture:
                b = self.fx.get("thumbs", {}).get(it["image_id"])
                b = b if isinstance(b, str) and B64.match(b) else None
            else:
                hit = self.thumbs.get(it["image_id"]) if it["image_id"] else None
                b = hit["t"] if hit else None
                if b is None and network and it["image_id"] and self.misses.get(it["image_id"]) is None and it["image_id"] not in need:
                    need.append(it["image_id"])
            it["img"] = DATA_PREFIX + b if b and len(DATA_PREFIX) + len(b) <= im["chunk_chars"] * im["max_chunks"] else ""
        if not need:
            return
        self._thumb_end = time.time() + im["budget_s"]
        ex = cf.ThreadPoolExecutor(max_workers=im["workers"])
        futs = dict((ex.submit(self.fetch_thumb, i), i) for i in need)
        done, _ = cf.wait(list(futs), timeout=im["budget_s"])
        ex.shutdown(wait=False)
        got = {}
        for f in done:
            try:
                got[futs[f]] = f.result()
            except Exception:
                got[futs[f]] = None
        for iid in need:
            b = got.get(iid)
            if b and B64.match(b) and len(DATA_PREFIX) + len(b) <= im["chunk_chars"] * im["max_chunks"]:
                self.thumbs.put(iid, {"t": b})
                for it in items:
                    if it["image_id"] == iid:
                        it["img"] = DATA_PREFIX + b
            elif iid in got:   # answered with nothing usable (not a timeout that left it unfinished): do not ask again for a while
                self.misses.put(iid, {"m": 1})


    def attach_heroes(self, items, network):
        """The big picture of the detail pane. Set item["hero"] to an inline data: URL or "" (only the detail view asks, for the one artwork, so the row bytes and the picture time stay small).
        Same rules as attach_thumbs: sample mode reads recorded pictures, a live run reads the cache and fetches the missing one within images.budget_s."""
        im = self.cfg["images"]
        hero = im["hero"]
        room = hero["chunk_chars"] * hero["max_chunks"]
        need = []
        for k, it in enumerate(items):
            it["hero"] = ""
            if not it["image_id"]:
                continue
            if self.fixture:
                b = self.fx.get("heroes", {}).get(it["image_id"])
                b = b if isinstance(b, str) and B64.match(b) else None
            else:
                hit = self.heroes.get(it["image_id"])
                b = hit["t"] if hit else None
                if b is None and network and self.misses.get("h" + it["image_id"]) is None and it["image_id"] not in need:
                    need.append(it["image_id"])
            if b and len(DATA_PREFIX) + len(b) <= room:
                it["hero"] = DATA_PREFIX + b
        if not need:
            return
        self._thumb_end = time.time() + im["budget_s"]
        ex = cf.ThreadPoolExecutor(max_workers=im["workers"])
        futs = dict((ex.submit(self.fetch_thumb, i, True), i) for i in need)   # all together, each with the per-picture timeout
        done, _ = cf.wait(list(futs), timeout=im["budget_s"])
        ex.shutdown(wait=False)
        got = {}
        for f in done:
            try:
                got[futs[f]] = f.result()
            except Exception:
                got[futs[f]] = None
        for iid in need:
            b = got.get(iid)
            if b and B64.match(b) and len(DATA_PREFIX) + len(b) <= room:
                self.heroes.put(iid, {"t": b})
                for it in items:
                    if it["image_id"] == iid and it["hero"] == "":
                        it["hero"] = DATA_PREFIX + b
            elif iid in got:
                self.misses.put("h" + iid, {"m": 1})


# ------------------------------------------------------------------ rows

def pct(n, whole):
    return int(round(100.0 * n / whole)) if whole else 0


def fmt(n):
    return format(n, ",")


back = kit.back_to_overview


def banner(state, cfg):
    if state["stale"] is not None:
        return [kit.note_row("Showing an old copy", "%s is not answering (%s); this copy is %s old" % (cfg["app"]["service"], state["err"], kit.fmt_duration(state["stale"])), icon="Clock", badge="OLD COPY")]
    if state["cached"] >= 2:
        return [kit.note_row("From a recent run", "%s old. Enter on Check again for fresh data" % kit.fmt_duration(state["cached"]), icon="Clock", badge="CACHED")]
    return []


def sample_row():
    return kit.note_row("Sample data", "Recorded answers, no network. A shipped app runs live", icon="FileText", badge="SAMPLE")


def offline_rows(cfg, state, view):
    kind = state.get("kind", "fail")
    title = {"http": "The %s did not accept that search" % cfg["app"]["service"], "rate": "%s is busy" % cfg["app"]["service"]}.get(kind, "Could not reach %s" % cfg["app"]["service"])
    sub = ("%s. Try other words" % state["err"] if kind == "http" else "%s. Wait a minute, then try again" % state["err"] if kind == "rate" else
           "%s. If this is your copy, check api.base_url and hosts in config.json" % state["err"]) if state["err"] else "Enter to try again"
    sel = view in ("items", "item", "record")   # a view that draws a pane per selected row
    target = view if view in ("overview", "items", "pictures", "chart", "table") else "overview"
    return ([back()] if sel else []) + [kit.note_row(title, sub, badge="OFFLINE" if kind == "fail" else "REFUSED"), kit.refresh_row(target, title="Try again", subtitle="Enter to run again", pane=kit.NOTE_VIEW)]


def dept_style(cfg, dept):
    d = cfg["departments"].get(dept)
    return d if d else ["Image", "neutral", kit.clean_text(dept, 14) or "Artwork"]


def img_fields(img, cfg):
    """The picture as fields img1 to img4: a row text field is cut at 4,000 characters, so the app file joins them with {{row.img1}}{{row.img2}}...."""
    im = cfg["images"]
    n, size = im["max_chunks"], im["chunk_chars"]
    if not img or len(img) > n * size:
        return {}
    return dict(("img%d" % (k + 1), img[k * size:(k + 1) * size]) for k in range(n) if img[k * size:(k + 1) * size])


_PUNCT = re.compile(r"([!-/:-@\[-`{-~])")


def md_escape(v):
    """Text from the API that goes into a MARKDOWN body: every ASCII punctuation character gets a backslash, which markdown reads as the plain character. So brackets, parentheses, backticks,
    asterisks, underscores, pipes, angle brackets, `![`, links, autolinks (the colon and the slashes) and html all show as the text they are and never become a link, an image or a tag."""
    return _PUNCT.sub(r"\\\1", kit.clean_text(v) if isinstance(v, str) else "")


def hero_markdown(it, cfg, facets, full=False):
    """The text under the big picture (a markdown body): the title, the artist and date, a short list of facts (one says how many works share the period) and the attribution.
    Every string that came from the API is md_escape()d; the rest is fixed text."""
    a = cfg["attribution"]
    out = ["&nbsp;", "", "### " + md_escape(it["title"])]   # the first line ends the picture's paragraph (the app file's YAML takes no \\n, so the line break lives in the row text)
    who = " \u00b7 ".join(md_escape(x) for x in (it["artist"], it["date"]) if x)
    if who:
        out += ["", who]
    facts = []
    if facets and it["year"] is not None and period_index(cfg, it["year"]) is not None:
        idx = period_index(cfg, it["year"])
        facts.append("Same period: %s works, %s" % (md_escape(fmt(facets["periods"][idx])), md_escape(period_labels(cfg)[idx])))
    for label, v in (("Medium", it["medium"]), ("Origin", it["place"]), ("Department", it["department"])):
        if v:
            facts.append("%s: %s" % (label, md_escape(v)))
    if facts:
        out += [""] + ["- " + x for x in facts]
    if full:
        if it.get("description"):
            out += [""] + [md_escape(x) for x in it["description"][:1200].split("\n")]
        extra = ["Credit: %s" % md_escape(it["credit"]) if it.get("credit") else "", "Size: %s" % md_escape(it["dimensions"]) if it.get("dimensions") else ""]
        if any(extra):
            out += [""] + [x for x in extra if x]
    out += ["", "*%s*" % md_escape(a["line"] + (". " + a["description_line"] if full and it.get("description") else ""))]
    return "\n".join(out)


def hero_fields(img, cfg):
    """The big picture as fields img1 to img24 (4,000 characters each), joined in the pane template."""
    h = cfg["images"]["hero"]
    n, size = h["max_chunks"], h["chunk_chars"]
    if not img or len(img) > n * size:
        return {}
    return dict(("img%d" % (k + 1), img[k * size:(k + 1) * size]) for k in range(n) if img[k * size:(k + 1) * size])


def hero_row(it, cfg, facets=None, full=True):
    """The one artwork of the detail view: its pane is the markdown hero (hero_alt, hero_lines and img1 to img24). Only this row carries the big picture; the list rows carry the small one."""
    page = cfg["links"]["item_page"] + it["id"]
    sub = " \u00b7 ".join(x for x in (it["artist"], it["date"]) if x)
    icon, tone, short = dept_style(cfg, it["department"])
    share_raw = " - ".join(x for x in (it["title"], sub, page) if x)
    kw = dict(hero_alt="Artwork" if it.get("hero") else "No picture here: it is on Open source", share_text=kit.safe_copy(share_raw), open_url=page, body=cfg["attribution"]["line"],
              badges=[(short, tone)], multiline={"hero_lines": hero_markdown(it, cfg, facets, full)})
    kw.update(hero_fields(it.get("hero", ""), cfg))
    cent = century(it["year"])
    if cent:
        kw["badge"] = cent
    return kit.safe_row(it["title"], sub, icon=icon, copy=share_raw, **kw)


def art_row(it, cfg, facets=None, nav=True, full=False):
    """One artwork. The same fields feed the list, the preview pane, the picture grid and the detail, so a row can move between views.
    Everything copied or pasted is made by kit.safe_copy (a bullet first, no shell characters, bounded): API text is never put on the clipboard raw."""
    a = cfg["attribution"]
    page = cfg["links"]["item_page"] + it["id"]
    sub = " · ".join(x for x in (it["artist"], it["date"]) if x)
    icon, tone, short = dept_style(cfg, it["department"])
    body = [a["line"]]
    if full:
        body = [it.get("description", ""), "", "%s%s" % ("Credit: %s. " % it["credit"] if it.get("credit") else "", "Size: %s" % it["dimensions"] if it.get("dimensions") else ""), "", a["line"] + (". " + a["description_line"] if it.get("description") else "")]
    share_raw = " - ".join(x for x in (it["title"], sub, page) if x)
    kw = dict(a_artist=it["artist"], a_date=it["date"], a_medium=it["medium"], a_origin=it["place"], a_dept=it["department"], a_rights="Public domain (CC0)" if it["public"] else "Not public domain",
              share_text=kit.safe_copy(share_raw), open_url=page, body="\n".join(body).strip(), badges=[(short, tone)])
    kw.update(img_fields(it.get("img", ""), cfg))
    cent = century(it["year"])
    if facets and it["year"] is not None and period_index(cfg, it["year"]) is not None:
        idx = period_index(cfg, it["year"])
        kw["tile"] = kit.safe_tile("Same period", facets["periods"][idx], max=max(facets["periods"]) or None, note="public domain, %s" % period_labels(cfg)[idx], foot="for this search")
    if cent:
        kw["badge"] = cent
    if nav:
        return kit.safe_row(it["title"], sub, icon=icon, nav={"view": "item", "arg": it["id"]}, copy=False, **kw)
    return kit.safe_row(it["title"], sub, icon=icon, copy=share_raw, **kw)   # copy= goes through kit.safe_copy


def label_first(rows, state, fixture):
    """In a view the launcher draws as one grid, a label row would be a card or a blank table row: the label rides on the first row's subtitle instead."""
    tags = (["sample data"] if fixture else []) + (["old copy, %s old" % kit.fmt_duration(state["stale"])] if state["stale"] is not None else [])
    if tags and rows:
        rows[0] = dict(rows[0], subtitle=kit.text("%s · %s" % (rows[0]["subtitle"], ", ".join(tags)) if rows[0]["subtitle"] else ", ".join(tags), 200))
    return rows


def overview_rows(data, state, cfg, fixture, word):
    items, f, t = data["items"], data["facets"], cfg["tiles"]
    labels = period_labels(cfg)
    peak = max(f["periods"])
    pk = f["periods"].index(peak)
    mean = sum(f["periods"]) / float(len(f["periods"]))
    top = f["depts"][0] if f["depts"] else None
    w = kit.clean_text(word, 40)
    rows = [
        kit.row("%s: %d%%" % (t["share_label"], pct(f["pd"], f["all"])), "%s of %s artworks matching %s are free to use" % (fmt(f["pd"]), fmt(f["all"]), w), icon="ShieldCheck", badge="CC0",
                tile=kit.safe_tile(t["share_label"], pct(f["pd"], f["all"]), unit="%", max=100, note="%s of %s matches" % (fmt(f["pd"]), fmt(f["all"])), foot="search word: %s" % w), nav={"view": "items"},
                body="Press Enter for the list, with a picture, facts and where to read more."),
        kit.row("%s: %s artworks" % (t["peak_label"], fmt(peak)), "%s is the busiest of %d periods" % (labels[pk], len(labels)), icon="TrendingUp", badge="PEAK", nav={"view": "chart"},
                tile=kit.safe_tile(t["peak_label"], peak, note=labels[pk], foot="public domain, for %s" % w), trend=f["periods"], delta=int(round(peak - mean)), since="above the period average",
                body="Press Enter for the chart of artworks per period."),
    ]
    if top:
        rows.append(kit.row("%s: %s" % (t["dept_label"], top[0]), "%s artworks, %d%% of the public-domain matches" % (fmt(top[1]), pct(top[1], f["pd"])), icon=dept_style(cfg, top[0])[0], badge="TOP", nav={"view": "table"},
                            tile=kit.safe_tile(t["dept_label"], top[1], max=f["pd"] or None, note=top[0], foot="of %s public domain" % fmt(f["pd"])), trend=[d[1] for d in f["depts"]], body="Press Enter for the table of departments."))
    rows.append(kit.row("%s: %d artworks" % (t["pictured_label"], len(items)), "small pictures, shown in the list and as a grid", icon="Image", badge="CC0", nav={"view": "pictures"},
                        tile=kit.safe_tile(t["pictured_label"], len(items), max=cfg["endpoints"]["items"]["limit"], note="pictures from artic.edu", foot="public domain, CC0"), body="Press Enter for the picture grid."))
    tags = ([("SAMPLE", "recorded answers, no network")] if fixture else []) + ([("OLD COPY", "an old copy, %s old" % kit.fmt_duration(state["stale"]))] if state["stale"] is not None else [])
    if tags:   # a tiles grid draws no label row: the label rides on the first tile
        rows[0] = dict(rows[0], kpi_badge=tags[0][0], kpi_foot=kit.text("; ".join(x[1] for x in tags), 80))
    # a tiles grid draws a tile for EVERY row, so the refresh row is a real tile too: its number is how old the data on screen is (0 when it is fresh)
    age = int(state["stale"] if state["stale"] is not None else (state.get("cached") or 0))
    rows.append(kit.row("Check again", "Enter to fetch fresh data past the cache", icon="RefreshCw", nav={"view": "overview", "arg": "refresh"}, copy=False,
                        tile=kit.safe_tile("Data age", age, unit="s", note="Enter to fetch fresh data"), body="Press Enter to fetch fresh data past the cache."))
    return rows


def chart_rows(data, state, cfg, fixture, word):
    f, labels = data["facets"], period_labels(cfg)
    rows = [kit.row(lab, "%s public-domain artworks for %s" % (fmt(n), kit.clean_text(word, 40)), icon="TrendingUp", period=lab, count=n, tile=None) for lab, n in zip(labels, f["periods"])]
    return label_first(rows, state, fixture)


def table_rows(data, state, cfg, fixture, word):
    f = data["facets"]
    rows = [kit.row(name, "%s artworks, %d%% of the public-domain matches" % (fmt(n), pct(n, f["pd"])), icon=dept_style(cfg, name)[0], dept=name, count=n, share=round(100.0 * n / f["pd"], 1) if f["pd"] else 0) for name, n in f["depts"]]
    if f["other"]:
        rows.append(kit.row("Other departments", "%s artworks, %d%% of the public-domain matches" % (fmt(f["other"]), pct(f["other"], f["pd"])), icon="Layers", dept="Other departments", count=f["other"], share=round(100.0 * f["other"] / f["pd"], 1) if f["pd"] else 0))
    return label_first(rows, state, fixture)


def build(view, arg, data, state, cfg, fixture, word):
    if view == "overview":
        return overview_rows(data, state, cfg, fixture, word)
    if view == "chart":
        return chart_rows(data, state, cfg, fixture, word)
    if view == "table":
        return table_rows(data, state, cfg, fixture, word)
    items, facets = data["items"], data["facets"]
    if view == "pictures":
        rows = [art_row(i, cfg, facets) for i in items] or [kit.row("No match", "no public-domain artwork with a picture matches %s" % kit.clean_text(word, 40), icon="Search", copy=False)]
        return label_first(rows, state, fixture) if items else rows
    out = [back()] + ([sample_row()] if fixture else []) + banner(state, cfg)   # items
    out += [art_row(i, cfg, facets) for i in items]
    if not items:
        out.append(kit.note_row("No match", "no public-domain artwork with a picture matches %s" % kit.clean_text(word, 40), icon="Search", body="Try a painter or a subject: monet, hokusai, cat, ship."))
    return out


def build_item(view, it, state, cfg, fixture):
    head = [back("Back to the list" if view == "item" else "Back to the artwork")] + ([sample_row()] if fixture else []) + banner(state, cfg)
    if view == "record":
        data = dict((k, v) for k, v in it.items() if k not in ("img", "hero", "image_id") and v not in (None, ""))
        return head + [kit.safe_row("Record %s" % it["id"], "the fields this app reads, as the API gave them", icon="Braces", data=data, body="Select a branch to open it.")]
    return head + [hero_row(it, cfg),
                   kit.row("Record (JSON)", "the same fields as a tree", icon="Braces", nav={"view": "record", "arg": it["id"]}, pane=kit.NOTE_VIEW, body="Press Enter for the raw record."),
                   kit.note_row("Attribution", cfg["attribution"]["line"], icon="BookOpen",
                                body="\n".join([cfg["attribution"]["line"]] + ([cfg["attribution"]["description_line"]] if it.get("description") else []) + ["Source: " + cfg["links"]["item_page"] + it["id"]]))]


# ------------------------------------------------------------------ the app file, written from config.json

_tile_bind = kit.tile_bind


_PREVIEW = [
    "kind: entity_preview", "mode: selected_row", "bind:",
    '  title: "{{row.title}}"', '  subtitle: "{{row.subtitle}}"',
    "  tiles_above:"] + _tile_bind(4) + [
    "  fields:", '    - { label: ARTIST, value: "{{row.a_artist}}" }', '    - { label: DATE, value: "{{row.a_date}}" }', '    - { label: MEDIUM, value: "{{row.a_medium}}" }',
    '    - { label: ORIGIN, value: "{{row.a_origin}}" }', '    - { label: DEPARTMENT, value: "{{row.a_dept}}" }', '    - { label: RIGHTS, value: "{{row.a_rights}}" }',
    '  body: "{{row.body}}"', "  actions:", '    - "open"', '    - "copy"']
_HERO = ["kind: markdown", "mode: selected_row", "bind:",
         '  body: "![{{row.hero_alt}}](' + "".join("{{row.img%d}}" % k for k in range(1, 25)) + ')' + '{{row.hero_lines}}"', "  actions:", '    - "open"', '    - "copy"']   # the picture over the whole text, one markdown body
_TILES = ["kind: cards", "mode: list_data", "bind:", '  layout: "tiles"'] + _tile_bind(2) + ['  delta: "{{row.delta}}"', '  delta_label: "{{row.since}}"', '  trend: "{{row.trend}}"']
_NOTE = ["kind: markdown", "mode: selected_row", "bind:", '  title: "{{row.title}}"', '  subtitle: "{{row.subtitle}}"', '  body: "{{row.body}}"']   # the pane of the Back, notice and hint rows (kit.NOTE_VIEW)


_indent = kit.indent


def emit_yaml(cfg):
    L = kit.bridge_head(cfg, _SELF, FILE_WORDS, ["Enter for the overview", "items monet", "chart", "table", "pictures cats", "hokusai"], nargs=4, systems=("macos", "linux", "windows")) + ["  right_widget:"]
    L += _indent(_TILES, 4)
    L += ["  views:", "    overview:", "      right_widget:"] + _indent(_TILES, 8)
    L += ["    items:", "      right_widget:"] + _indent(_PREVIEW, 8) + ["    item:", "      right_widget:"] + _indent(_HERO, 8)
    L += ["    pictures:", "      right_widget:", "        kind: cards", "        mode: list_data", "        bind:", '          layout: "grid"', '          title: "{{row.title}}"', '          subtitle: "{{row.a_artist}}"',
          '          image: "{{row.img1}}{{row.img2}}{{row.img3}}{{row.img4}}"', '          badge: "{{row.kpi_badge}}"', '          footer: "{{row.a_date}}"']
    L += ["    chart:", "      right_widget:", "        kind: chart", "        mode: list_data", "        bind:", "          type: bar", "          x: period", "          y: count",
          '          label: "Public-domain artworks by period"']
    L += ["    table:", "      right_widget:", "        kind: table", "        mode: list_data", "        bind:", "          columns:", "            - { field: dept, label: Department }",
          "            - { field: count, label: Artworks, align: right, total: sum, format: number }", "            - { field: share, label: Share, align: right, unit: \"%\" }",
          "          sort: { field: count, dir: desc }", '          totals_label: "All departments"']
    L += ["    record:", "      right_widget:", "        kind: json_tree", "        mode: selected_row", "        bind:", "          source: data"]
    L += ["    note:", "      right_widget:"] + _indent(_NOTE, 8)
    L += ["actions:", '  - { id: open, kind: url, target: row, label: "Open source", url_template: "{{row.open_url}}" }', '  - { id: copy, kind: composer, target: row, label: "Copy summary", insert: "{{row.share_text}}" }']
    return "\n".join(L) + "\n"


# ------------------------------------------------------------------ main

def main(argv):
    global APP
    cfg = load_json("config.json")
    APP = cfg["app"]["id"]
    if "--emit-yaml" in argv:
        sys.stdout.write(emit_yaml(cfg))
        return
    words = kit.split_args(argv, FILE_WORDS)
    first = words[0].lower() if words else ""
    view = first if first in VIEWS else ("items" if first and not first.startswith("demo-") else "overview")   # a first word that is not a view is a search word
    rest = words[1:] if first in VIEWS else words
    demos = [w for w in rest if w in ("demo-offline", "demo-stale")]
    arg = " ".join(w for w in rest if w not in demos)[:60]
    fixture = kit.fixture_mode(os.environ.get("BOLT_APP_FIXTURE"), cfg["api"]["fixture_default"])
    fx = load_json("fixtures.json") if fixture else {}
    src = Source(cfg, fixture, demos, fx)
    refresh = arg == "refresh"
    if view in ("item", "record"):
        rid = arg if ITEM_ID.match(arg) else ""
        if not rid:
            kit.emit([back(), kit.note_row("Not found", "no artwork with id %s" % kit.clean_text(arg, 30))])
        it, state = src.detail(rid, False)
        if it == "missing":
            kit.emit([back(), kit.note_row("Not found", "no artwork with id %s" % rid, body="The collection has no artwork with this id.")])
        if it is None:
            kit.emit(offline_rows(cfg, state, view))
        if view == "item" and it["public"] and it["image_id"]:
            src.attach_heroes([it], network=state["stale"] is None)
        else:
            it["hero"] = ""
        kit.emit(build_item(view, it, state, cfg, fixture))
    default = cfg["endpoints"]["items"]["default_query"]
    word = "" if refresh else kit.clean_text(" ".join(w for w in rest if w not in demos), 40)
    if re.search(r"\.\.|[/\\]", word):
        kit.emit([back(), kit.note_row("Type a word or two", "a name or a subject, for example: =%s items monet" % cfg["app"]["chip"], icon="Search")])
    typed = len(word) >= 2
    if word and not typed:
        kit.emit([back(), kit.note_row("Type a longer word", "at least two letters, for example: =%s items monet" % cfg["app"]["chip"], icon="Search")])
    shown_word = word if typed else default
    data, state = src.search(shown_word, typed, refresh)
    if data is None:
        kit.emit(offline_rows(cfg, state, view))
    if view in ("items", "pictures"):
        src.attach_thumbs(data["items"], network=state["stale"] is None)
    kit.emit(build(view, arg, data, state, cfg, fixture, shown_word))


if __name__ == "__main__":
    kit.run_guarded(main, sys.argv, debug=bool(os.environ.get("BOLT_APP_DEBUG")))
