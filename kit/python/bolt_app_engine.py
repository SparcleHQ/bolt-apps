#!/usr/bin/env python3
"""Generic Bolt App engine: reads config.json, prints launcher rows. Read-only (GET only).

Usage (the launcher runs this):   engine.py <view> <arg>      (config.json and fixtures.json are read from beside this file)
  view   overview, or a view id from config.json
  arg    "-" nothing | "refresh" skip the cache | "refresh.<id>" refresh a detail view
         | an item id (detail view) | any other word (filters the list by that word)
Other:   engine.py --emit-yaml    prints the launcher app file for this config

An author edits config.json and fixtures.json only. Formatting, row structure, text safety, deadlines and the
cache come from bolt_app_kit. Fixture mode (no key, no network) reads fixtures.json."""
import concurrent.futures as cf
import datetime
import errno
import hashlib
import json
import math
import os
import re
import socket
import stat
import sys
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

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

HERE = os.path.dirname(os.path.abspath(__file__))
MAPS = {}   # value labels from config.json "maps", used as {field|name}
TOKEN = re.compile(r"\{([A-Za-z_][A-Za-z0-9_.]*)(?:\|([a-z_][a-z0-9_]*))?\}")
NAV_OK = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}\Z")
MAX_VIEWS = 8            # the launcher refuses an app file with more views than this (overview counts as one)
MAX_FIELDS = 5
MAX_ROWS = 50
REQ_TIMEOUT = 10.0
TOTAL_BUDGET = 14.0      # all requests together; Bolt stops the script at the app file's bridge.timeout_seconds (app.timeout, 25 unless set), so that is 20 or more for an app that calls an API
MAX_ANSWER = 5 * 1024 * 1024   # bytes read from one answer; a longer one is a failure of its own ("too large"), never cut and misread
CACHE_MAX = getattr(getattr(kit, "cache", None), "_MAX_FILE", 1024 * 1024)   # the kit cache refuses a file larger than this
CACHE_FORM = 3           # unwrapped, mapped rows, with whole records and lookup matches kept when the config uses them
DEMOS = ("demo-offline", "demo-stale", "demo-auth", "demo-nokey", "demo-notfound")


class ConfigError(Exception):
    pass


class TooLarge(Exception):
    """An answer longer than MAX_ANSWER."""


# ---------------------------------------------------------------- small helpers

def get_path(obj, path):
    cur = obj
    for part in str(path).split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        elif isinstance(cur, list) and part.isdigit() and int(part) < len(cur):
            cur = cur[int(part)]
        else:
            return None
    return cur


def human(v):
    s = str(v).replace("_", " ").replace("-", " ").strip()
    return s[:1].upper() + s[1:].lower() if s else s


def lookup(name, item, glob):
    v = get_path(item, name) if item is not None else None
    return v if v is not None else get_path(glob, name)


ISO_DATE = re.compile(r"^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?")


def _when(v, day_only=False):
    """An epoch in seconds or milliseconds (a number or a string of digits) as local time, 2026-11-15 14:05, or the date only.
    A value that is not a plausible epoch reads unknown, never 1970."""
    n = number(v)
    if isinstance(v, str) and re.match(r"^\d{8}\Z", v.strip()):
        return kit.UNKNOWN   # 20260718 is neither an epoch nor an ISO date here
    iso = ISO_DATE.match(v.strip()) if isinstance(v, str) else None
    if iso and n is None:   # 2026-07-18, 2026-07-18T09:30:00Z or 2026-07-18 09:30: shown as written (no time zone change); an impossible date reads unknown
        try:
            datetime.date(int(iso.group(1)[:4]), int(iso.group(1)[5:7]), int(iso.group(1)[8:10]))
        except ValueError:
            return kit.UNKNOWN
        if iso.group(2) and not (int(iso.group(2)[:2]) < 24 and int(iso.group(2)[3:]) < 60):
            return kit.UNKNOWN
        return iso.group(1) if day_only or not iso.group(2) else "%s %s" % (iso.group(1), iso.group(2))
    if n is None or n <= 0:
        return kit.UNKNOWN
    if n >= 1e11:
        n = n / 1000.0
    try:
        t = time.localtime(n)
    except (OverflowError, OSError, ValueError):
        return kit.UNKNOWN
    return time.strftime("%Y-%m-%d" if day_only else "%Y-%m-%d %H:%M", t)


def shown(v, filt):
    if v is None or v == "":
        return kit.UNKNOWN
    if filt == "yes":   # a JSON true or false, or the text a form toggle or an API sends: "true", "false", "yes", "no"
        t = str(v).strip().lower() if isinstance(v, str) else v
        return "Yes" if v is True or t in ("true", "yes") else ("No" if v is False or t in ("false", "no") else str(v))
    if filt == "human":
        return human(v)
    if filt in MAPS:
        return str(MAPS[filt].get(str(v), "code " + str(v)))
    if filt == "hhmm":
        return str(v)[11:16]
    if filt == "day":
        return str(v)[:10]
    if filt in ("when", "whenday"):
        return _when(v, filt == "whenday")
    if filt == "thousands":
        n = number(v)
        if n is None or not math.isfinite(n):
            return kit.UNKNOWN
        return "{:,d}".format(int(n)) if n == int(n) else "{:,.2f}".format(n)
    if filt in ("round", "round1", "round2"):
        n = number(v)
        if n is None:
            return kit.UNKNOWN
        d = {"round": 0, "round1": 1, "round2": 2}[filt]
        return ("%." + str(d) + "f") % (math.floor(abs(n) * 10 ** d + 0.5) / 10 ** d * (1 if n >= 0 else -1))   # half up, as people count
    if filt == "upper":
        return str(v).upper()
    if filt == "lower":
        return str(v).lower()
    if filt in ("join", "chips"):
        return kit.chips([str(x) for x in v]) if isinstance(v, list) else str(v)
    if filt == "dots":
        return " · ".join(str(x) for x in v) if isinstance(v, list) else str(v)
    if filt == "count":
        return str(len(v)) if isinstance(v, (list, dict)) else "1"
    if isinstance(v, bool):
        return "yes" if v else "no"
    if isinstance(v, float) and v == int(v):
        return str(int(v))
    return str(v)


def render(tpl, item, glob, strict=False, blank=None):
    """Fill {name} and {name|filter} from the item, then the shared values. strict=True returns None when a name is missing.
    blank, when given, stands in for a missing value instead of "unknown" (a form record saves an empty input as empty text)."""
    if not isinstance(tpl, str):
        return "" if not strict else None
    missing = []

    def sub(m):
        v = lookup(m.group(1), item, glob)
        if v is None or v == "":
            missing.append(m.group(1))
            return ""
        return shown(v, m.group(2))
    out = TOKEN.sub(sub, tpl)
    if strict:
        return None if missing else one_noun(tpl, out)
    if blank is not None:
        return one_noun(tpl, TOKEN.sub(lambda m: blank if lookup(m.group(1), item, glob) in (None, "") else shown(lookup(m.group(1), item, glob), m.group(2)), tpl))
    return one_noun(tpl, TOKEN.sub(lambda m: shown(lookup(m.group(1), item, glob), m.group(2)), tpl))


def one_noun(tpl, out):
    """A count that came from a {x|count} filter says "1 point", not "1 points": the plain English plural is dropped when the number is exactly 1."""
    return re.sub(r"(?<![\d.,])\b1 ([A-Za-z]{3,}?)s\b", r"1 \1", out) if "|count}" in tpl else out


def token(s):
    t = re.sub(r"[^A-Za-z0-9_.-]", "-", str(s))[:64]
    return t if NAV_OK.match(t) and ".." not in t else ""


def finite(x):
    try:
        return math.isfinite(x)
    except OverflowError:   # an integer too large for a float (10**400)
        return False


def number(v):
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return v if finite(v) else None   # a JSON Infinity, NaN or a huge integer is not a number a total can use
    if isinstance(v, str):
        try:
            f = float(v)
        except ValueError:
            return None
        return f if finite(f) else None   # "inf", "nan", "1e999" are text, not numbers
    return None


def cmp_ok(a, op, b):
    na, nb = number(a), number(b)
    if na is not None and nb is not None:
        a, b = na, nb
    else:
        a, b = str(a), str(b)
    return {"==": a == b, "!=": a != b, ">=": a >= b, "<=": a <= b, ">": a > b, "<": a < b}[op]


RULE = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_.]*)\s*(>=|<=|==|!=|>|<)\s*(.+?)\s*$")


def badge_for(rules, item, glob):
    """First matching rule wins; a rule with no `if` always matches. Text compares as text, numbers as numbers."""
    for r in rules or []:
        cond = r.get("if")
        if not cond:
            return str(r.get("badge", ""))
        m = RULE.match(cond)
        if not m:
            continue
        left = lookup(m.group(1), item, glob)
        right = lookup(m.group(3), item, glob) if NAV_OK.match(m.group(3)) and lookup(m.group(3), item, glob) is not None else m.group(3)
        if left is not None and cmp_ok(left, m.group(2), right):
            return str(r.get("badge", ""))
    return ""


def make_tile(spec, item, glob):
    """A KPI tile from {label, value, max, unit, note, foot, badge}. A value that cannot be read gives no tile, never a zero.
    Its badge then skips rules naming the value's field on the left or reading it on the right. Ordering rules naming it on the
    right are skipped even when it is absent; == and != keep that word as plain text when absent. Rules on another field, such as
    status==open, still apply. The last rule has no `if`, so it would say CLEAR or BEHIND about a number that did not load, and a
    rule such as remaining>=10 would compare a text value like N/A as text. A plain word badge is left out."""
    if not spec:
        return None, ""
    val = spec.get("value")
    v = number(val) if not isinstance(val, str) or number(val) is not None else number(lookup(val, item, glob))
    rules = spec.get("badge") if isinstance(spec.get("badge"), list) else None
    if v is None:
        own = val if isinstance(val, str) else None

        def other_field(r):   # skip own-field reads and ordering on its name; absent-field == and != keep plain text
            m = RULE.match(str(r.get("if") or ""))
            return bool(m) and m.group(1) != own and not (m.group(3) == own and
                (m.group(2) in (">=", "<=", ">", "<") or lookup(own, item, glob) is not None))
        return None, (badge_for([r for r in rules if isinstance(r, dict) and other_field(r)], item, glob) if rules else "")
    badge = badge_for(rules, item, glob) if rules is not None else str(spec.get("badge", ""))
    mx = spec.get("max")
    mxv = None if mx is None else (number(mx) if number(mx) is not None else number(lookup(mx, item, glob)))
    return kit.safe_tile(render(spec.get("label", ""), item, glob), v, unit=spec.get("unit", ""), max=mxv,
                         note=render(spec.get("note", ""), item, glob), foot=render(spec.get("foot", ""), item, glob)), badge


# ---------------------------------------------------------------- config

def load_config(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            cfg = json.load(f)
    except (OSError, ValueError) as e:
        raise ConfigError("Could not read %s (%s)" % (os.path.basename(path), e.__class__.__name__))
    problems = validate_config(cfg)
    if problems:
        raise ConfigError("config.json: " + "; ".join(problems[:3]))
    return cfg


def icon_problems(o, path, out):
    """Every `icon` in config.json must be a name in the launcher's icon list (kit/schema/icons.json). The launcher draws a plain plug for any other name."""
    if isinstance(o, dict):
        for k, v in o.items():
            if k == "icon" and isinstance(v, str) and v not in kit.icons_data.ICONS:
                out.append('icon "%s" (%s) is not in the launcher icon list (kit/schema/icons.json); use a listed name such as activity, list, globe, file or line-chart' % (v, (path + ".icon") if path else "icon"))
            icon_problems(v, "%s.%s" % (path, k) if path else k, out)
    elif isinstance(o, list):
        for i, v in enumerate(o):
            icon_problems(v, "%s[%d]" % (path, i), out)


def validate_config(cfg):
    p = []
    if not isinstance(cfg, dict):
        return ["must be an object"]
    icon_problems(cfg, "", p)
    app, api = cfg.get("app") or {}, cfg.get("api") or {}
    mode = cfg.get("mode", "views")
    if mode not in ("views", "form", "lookup"):
        return ["mode must be views, form or lookup"]
    for k in ("id", "chip", "title"):
        if not isinstance(app.get(k), str) or not app.get(k):
            p.append("app.%s is required" % k)
    if mode == "form":
        fm = cfg.get("form") or {}
        if not fm.get("inputs") or not isinstance((fm.get("submit") or {}).get("label"), str):
            p.append("form.inputs and form.submit.label are required")
        for k in ("record", "item", "widget", "store"):
            if not isinstance(fm.get(k), dict):
                p.append("form.%s is required" % k)
        if isinstance(fm.get("store"), dict) and not isinstance(fm["store"].get("file"), str):
            p.append("form.store.file is required")
        for f in fm.get("inputs") or []:
            if f.get("type") not in ("text", "number", "date", "select", "toggle") or not re.match(r"^[a-z][a-z0-9_]{0,31}\Z", str(f.get("name", ""))):
                p.append("each form input needs a lowercase name and a type of text, number, date, select or toggle")
        return p
    if not isinstance(api.get("base_url"), str) and api and api.get("fixture_default") is not True:
        p.append("api.base_url is required (an app that only shows sample data may leave out api, or set api.fixture_default to true)")
    eps = cfg.get("endpoints")
    if not isinstance(eps, dict) or not eps:
        p.append("endpoints must list at least one endpoint")
        eps = {}
    if api.get("auth_in", "header") not in ("header", "query"):
        p.append("api.auth_in must be header or query")
    if api.get("auth_param") is not None and not re.match(r"^[A-Za-z_][A-Za-z0-9_-]{0,31}\Z", str(api.get("auth_param"))):
        p.append("api.auth_param must be a plain parameter name")
    for n, ep in eps.items():
        if not isinstance(ep, dict):
            continue
        h = ep.get("hydrate")
        if h is not None and (not isinstance(h, dict) or "{id}" not in str(h.get("path", "")) or ep.get("kind", "list") != "list"
                              or not isinstance(h.get("limit", 20), int) or not 1 <= h.get("limit", 20) <= MAX_ROWS):
            p.append("endpoint %s: hydrate needs {path with {id}, limit 1 to %d} on a list endpoint" % (n, MAX_ROWS))
        if ep.get("flatten") is not None and not isinstance(ep["flatten"], (str, bool)):
            p.append("endpoint %s: flatten is true or the name of the field that keeps the key" % n)
    base_host = _host_of(api["base_url"]) if isinstance(api.get("base_url"), str) else None
    allowed = set([base_host] + [h for h in (api.get("allowed_hosts") or []) if isinstance(h, str)])
    for n, ep in eps.items():
        path = ep.get("path") if isinstance(ep, dict) else None
        if isinstance(path, str) and re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", path):
            h = _host_of(path)
            if not path.startswith("https://") or h not in allowed:
                p.append("endpoint %s: a full address must be https on the host of api.base_url or one listed in api.allowed_hosts (host %s)" % (n, h))
    if mode == "lookup":
        lk = cfg.get("lookup") or {}
        chain = bool(lk.get("steps")) and all(n in eps for n in lk["steps"]) and isinstance(lk.get("rows"), list)
        single = lk.get("endpoint") in eps and lk.get("match") and isinstance(lk.get("item"), dict)
        if not (chain or single) or not isinstance(lk.get("widget"), dict):
            p.append("lookup needs a widget and either steps and rows (a chain of endpoints) or endpoint, match and item")
        return p
    views = cfg.get("views")
    if not isinstance(views, list) or not views:
        p.append("views must list at least one view")
        views = []
    if len(views) + 1 > MAX_VIEWS:
        p.append("at most %d views besides overview (the launcher refuses more)" % (MAX_VIEWS - 1))
    ids = set()
    for v in views:
        if not isinstance(v, dict) or not re.match(r"^[a-z][a-z0-9_-]{0,23}\Z", str(v.get("id", ""))) or v.get("id") == "overview":
            p.append("view ids are 1 to 24 lowercase letters, digits, - or _ and never overview")
            continue
        ids.add(v["id"])
        if v.get("endpoint") not in eps:
            p.append("view %s names an endpoint that is not in endpoints" % v["id"])
        if len((v.get("item") or {}).get("fields") or []) > MAX_FIELDS:
            p.append("view %s has more than %d fields" % (v["id"], MAX_FIELDS))
    for v in views:
        for c in (v.get("children") or []) if isinstance(v, dict) else []:
            if c.get("view") not in ids:
                p.append("a child of view %s names a view that does not exist" % v.get("id"))
    for r in (cfg.get("overview") or {}).get("rows", []):
        if r.get("view") and r["view"] not in ids:
            p.append("an overview row names the view %s, which does not exist" % r["view"])
    return p


def views_by_id(cfg):
    return dict((v["id"], v) for v in cfg["views"])


# ---------------------------------------------------------------- statistics for the overview

def match(item, where):
    for field, cond in (where or {}).items():
        v = get_path(item, field)
        if isinstance(cond, list):
            if v not in cond:
                return False
        elif isinstance(cond, dict):
            for op, arg in cond.items():
                if op not in ("not", ">=", "<=", ">", "<", "gte", "lte", "gt", "lt"):
                    raise ConfigError("where: unknown comparison %r; use one of gt, gte, lt, lte, not" % op)
                if op == "not" and v in arg:
                    return False
                if op in (">=", "<=", ">", "<", "gte", "lte", "gt", "lt"):
                    o = {"gte": ">=", "lte": "<=", "gt": ">", "lt": "<"}.get(op, op)
                    if v is None or not cmp_ok(v, o, arg):
                        return False
        elif v != cond:
            return False
    return True


def compute_stats(cfg, data):
    """Named numbers and texts for overview templates. A stat whose endpoint was not read is left out (so a row cannot show it)."""
    specs, out = cfg.get("stats") or {}, {}

    def one(name, depth=0):
        if name in out:
            return out[name]
        s = specs.get(name)
        if s is None or depth > 8:
            return None
        v = None
        if "pct" in s:
            a, b = one(s["pct"][0], depth + 1), one(s["pct"][1], depth + 1)
            v = kit.rnd(100.0 * a / b) if a is not None and b else None
        elif "sum" in s:
            parts = [one(n, depth + 1) for n in s["sum"]]
            v = None if any(x is None for x in parts) else sum(parts)
            v = v if v is None or finite(v) else None   # 1e308 + 1e308 is not a number
        else:
            items = data.get(s.get("endpoint"))
            if isinstance(items, list):
                rows = [x for x in items if match(x, s.get("where"))]
                if "field_sum" in s or "field_max" in s:
                    nums = [number(get_path(x, s.get("field_sum") or s.get("field_max"))) for x in rows]
                    nums = [n for n in nums if n is not None]
                    v = (sum(nums) if "field_sum" in s else max(nums)) if nums else None
                    v = v if v is None or finite(v) else None   # a sum that overflows is left out, like any non-number
                elif "group" in s:
                    counts = {}
                    for x in rows:
                        g = get_path(x, s["group"])
                        if g not in (None, ""):
                            counts[str(g)] = counts.get(str(g), 0) + 1
                    v = ", ".join("%d %s" % (n, human(g).lower()) for g, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0])))
                else:
                    v = len(rows)
        out[name] = v
        return v
    for n in specs:
        one(n)
    return dict((k, v) for k, v in out.items() if v is not None)


# ---------------------------------------------------------------- keys and the network

def find_key(app, api):
    """(key, problem). Lookup order and rules are the kit's (secrets.py): environment, then the system keychain, then
    ~/.config/<app id>/.env (owner-only). The key is never printed, logged, cached or put in a row. problem is the kit's
    reason a key it found was refused, or ""."""
    env_file = os.path.expanduser(api["env_file"]) if api.get("env_file") else None
    s = kit.get_secret(app["id"], api.get("key_env", "API_KEY"), env_file=env_file)
    return (s.value or ""), (s.problem or "")


def key_file(app, api):
    return os.path.expanduser(api["env_file"]) if api.get("env_file") else kit.env_file_path(app["id"])


# (words in the kit's reason, row title, fix) for a key the kit found and refused (secrets.py words them)
KEY_FIXES = (("is a link", "The key file is a link", "%(path)s is a link, which is not followed: put the file itself there, then press Enter"),
             ("is not owned by you", "The key file belongs to another user", "%(path)s is not owned by you: create it again as yourself and chmod 600 it, then press Enter"),
             ("can be read by other users", "Tighten the permissions on the key file", "Run chmod 600 on %(path)s so other users cannot read the key, then press Enter"),
             ("shorter than", "The %(name)s key is too short", "A key this short cannot be hidden from API answers: set the whole key where you keep it (environment, keychain or %(path)s), then press Enter"))


def key_advice(app, api, problem):
    """(title, subtitle) naming what is wrong with the key and the fix for that cause, or None when there is simply no key (the setup row).
    problem is the kit's reason a key was refused; with none, the key file, when there is one, is read for why it gave no key."""
    name, path = api.get("key_env", "API_KEY"), key_file(app, api)
    if os.name == "nt":
        path = os.path.normpath(path)
    home = os.path.expanduser("~")
    words = {"name": name, "path": "~" + path[len(home):] if path.startswith(home + os.sep) else path}
    if problem:
        for part, title, fix in KEY_FIXES:
            if part in problem:
                return title % words, fix % words
        return "The %s key was not used" % name, "%s; fix that, then press Enter" % kit.redact(problem)
    try:
        if not stat.S_ISREG(os.lstat(path).st_mode):
            return None
        with open(path, "r", encoding="utf-8") as f:
            lines = [x.strip() for x in f]
    except UnicodeDecodeError:
        return "The key file is not plain text", "%(path)s is not UTF-8 text: save it as plain text with the line %(name)s=<key>, then press Enter" % words
    except FileNotFoundError:
        return None
    except OSError:
        if os.name == "nt":
            return "The key file cannot be read", "%(path)s is there but you cannot read it: make sure your Windows account can read it (file Properties, Security), then press Enter" % words
        return "The key file cannot be read", "%(path)s is there but you cannot read it: run chmod 600 on it, then press Enter" % words
    lines = [x[7:].lstrip() if x.startswith("export ") else x for x in lines]
    if any(x.startswith(name + "=") for x in lines):   # the kit read the line and found no value in it
        return "The %(name)s line is empty" % words, "%(path)s has %(name)s= with no key after it: paste the key after the = sign, then press Enter" % words
    if any(re.match(re.escape(name) + r"\s*[=:]", x) for x in lines):
        return ("The %(name)s line is not in the form %(name)s=<key>" % words,
                "In %(path)s write %(name)s=<key> with no space before the = sign, then press Enter" % words)
    return "No %(name)s line in the key file" % words, "%(path)s has no line %(name)s=<key> (the name is case sensitive): add it, then press Enter" % words


def https_or_loopback(url):
    p = urllib.parse.urlparse(url)
    return p.scheme == "https" or (p.scheme == "http" and p.hostname in ("127.0.0.1", "localhost"))


class _SameHost(urllib.request.HTTPRedirectHandler):
    """A redirect may stay on the same scheme and host. Anything else is refused, so the key is never forwarded elsewhere."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        old, new = urllib.parse.urlparse(req.full_url), urllib.parse.urlparse(newurl)
        if (new.scheme, new.hostname, new.port) != (old.scheme, old.hostname, old.port):
            raise urllib.error.URLError("redirected to another host or scheme: not followed")
        return urllib.request.HTTPRedirectHandler.redirect_request(self, req, fp, code, msg, headers, newurl)


def _host_of(url):
    return urllib.parse.urlparse(url).hostname


def http_get(api, key, path, timeout):
    headers = {"Accept": "application/json", "User-Agent": api.get("user_agent", "bolt-app-example/1.0")}
    url = path if path.startswith("https:") else api["base_url"].rstrip("/") + path
    if key and _host_of(url) == _host_of(api["base_url"]):   # the key goes to the host it was made for, never to a second one
        if api.get("auth_in") == "query":   # a key some APIs want as a query parameter; it is redacted from the answer before anything keeps it
            url += ("&" if "?" in url else "?") + urllib.parse.urlencode({api.get("auth_param", "api_key"): key})
        else:
            headers[api.get("auth_header", "X-API-Key")] = api.get("auth_prefix", "") + key   # an empty auth_prefix is allowed
    req = urllib.request.Request(url, headers=headers, method="GET")
    with urllib.request.build_opener(_SameHost).open(req, timeout=timeout) as r:
        raw = r.read(MAX_ANSWER + 1)
    if len(raw) > MAX_ANSWER:
        raise TooLarge()
    return json.loads(raw.decode("utf-8")) if raw else None


def hydrate(api, key, ep, raw, deadline):
    """A list of ids (Hacker News topstories) then one request per id, in parallel under the shared deadline. Ids that fail are dropped;
    if none answer the whole endpoint counts as failed."""
    h = ep["hydrate"]
    path = ep.get("data", "data")
    v = get_path(raw, path) if path else raw
    if v is None and isinstance(raw, list):
        v = raw
    ids = [x for x in (v if isinstance(v, list) else []) if isinstance(x, (int, str)) and not isinstance(x, bool)
           and str(x) not in ("", ".", "..") and len(str(x)) <= 128 and "/" not in str(x)][:min(int(h.get("limit", 20)), MAX_ROWS)]   # an odd id costs that row, never the app

    def one(i):
        try:
            return http_get(api, key, h["path"].replace("{id}", urllib.parse.quote(str(i), safe="")), deadline.cap(REQ_TIMEOUT))
        except Exception:
            return None
    ex = cf.ThreadPoolExecutor(max_workers=8)
    futs = [ex.submit(one, i) for i in ids]
    got = []
    for f in futs:
        try:
            r = f.result(timeout=max(0.1, deadline.remaining()))
        except Exception:
            r = None
        if isinstance(r, dict):
            got.append(r)
    ex.shutdown(wait=False, cancel_futures=True)
    if ids and not got:
        raise urllib.error.URLError("no item answered")
    return got


def cause_of(e):
    """auth | rate | notfound | timeout | conn | toolarge | other"""
    if isinstance(e, TooLarge):
        return "toolarge"
    if isinstance(e, urllib.error.HTTPError):
        return "auth" if e.code in (401, 403) else ("rate" if e.code == 429 else ("notfound" if e.code in (404, 410) else "other"))
    r = getattr(e, "reason", e)
    if isinstance(e, (socket.timeout, TimeoutError)) or isinstance(r, (socket.timeout, TimeoutError)):
        return "timeout"
    if isinstance(e, (urllib.error.URLError, ConnectionError, OSError)):
        return "conn"
    return "other"


def ago(sec):
    sec = int(sec)
    return "%d s" % sec if sec < 90 else ("%d min" % round(sec / 60.0) if sec < 5400 else "%.1f h" % (sec / 3600.0))


def unwrap(ep, raw):
    """The rows or the object inside an answer, or None when the answer is not what this endpoint is configured to return.
    An error body such as {"message": "Bad credentials"} and a list of non-records are unread, never data."""
    path = "" if ep.get("hydrate") else ep.get("data", "data")   # a hydrated endpoint already holds its list of records
    kind = ep.get("kind", "list")
    v = get_path(raw, path) if path else raw
    if v is None and kind == "list" and isinstance(raw, list):
        v = raw
    if kind == "list" and ep.get("flatten") and isinstance(v, dict):   # an object of lists keyed by date or name: one list, the key kept in a field
        fld = ep["flatten"] if isinstance(ep["flatten"], str) else "key"
        v = [dict(x, **{fld: k}) for k in sorted(v) if isinstance(v[k], list) for x in v[k] if isinstance(x, dict)]
    if kind == "list":
        if not isinstance(v, list) or (v and not any(isinstance(x, dict) for x in v)):
            return None
        return v
    if not isinstance(v, dict):
        return None
    need = ep.get("require") or []
    if any(get_path(v, r) is None for r in need):
        return None
    return v


PAGE_KEYS = ("next", "next_page", "nextPage", "next_cursor", "nextCursor", "next_page_token", "cursor")


def paged(raw, n):
    """True when the answer says there is more than the rows we hold (a next link or cursor, has_more, or a total above n)."""
    if not isinstance(raw, dict):
        return False
    for holder in (raw, raw.get("meta") if isinstance(raw.get("meta"), dict) else {}, raw.get("pagination") if isinstance(raw.get("pagination"), dict) else {}):
        if any(holder.get(k) for k in PAGE_KEYS) or holder.get("has_more") is True or holder.get("hasMore") is True:
            return True
        for t in ("total", "total_count", "totalCount", "count"):
            if isinstance(holder.get(t), int) and not isinstance(holder.get(t), bool) and holder[t] > n and t != "count":
                return True
    return False


def apply_map(ep, items):
    m = ep.get("map") or {}
    out = []
    for x in items:
        if not isinstance(x, dict):
            continue
        y = dict(x)
        for canon, src in m.items():
            y[canon] = get_path(x, src)
        out.append(y)
    return out


def settle(ep, raw):
    """(value, paged) from an answer: the rows (mapped) or the object the endpoint reads, or None, and whether the answer says it holds more."""
    v = unwrap(ep, raw)
    if ep.get("kind", "list") == "list" and v is not None:
        return apply_map(ep, v), paged(raw, len(v))
    return v, False


WORD = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def cache_reads(cfg):
    """Names used by templates, stats, sorts and matches, plus the implicit id, title and key. Keep exact template and badge paths
    too: a path can consume an entire endpoint or record, including fields it does not name individually."""
    fields, paths, stack = {"id", "title", "key"}, set(), [cfg]
    while stack:
        o = stack.pop()
        if isinstance(o, dict):
            stack.extend(list(o.keys()) + list(o.values()))
        elif isinstance(o, list):
            stack.extend(o)
        elif isinstance(o, str):
            fields.add(o)
            fields.update(o.split("."))
            fields.update(WORD.findall(o))
            paths.update(m.group(1) for m in TOKEN.finditer(o))
            rule = RULE.match(o)
            if rule:
                paths.update((rule.group(1), rule.group(3)))
    return fields, paths


def whole_record_indexes(name, paths, lookup_step):
    """A lookup chain exposes only its first record; elsewhere a path can read a whole list or an indexed record."""
    if lookup_step:
        return {"0"} if name in paths else set()
    if name in paths:
        return None   # the full list is read
    prefix = name + "."
    tails = (path[len(prefix):] for path in paths if path.startswith(prefix))
    return {i.lstrip("0") or "0" for i in tails if i.isdigit()}


def cache_doc(tag, value, pg, fields, whole_records, lookup_step):
    """Keep mapped rows, whether the answer was paged, and whether trimming hid a successful first record in a lookup chain."""
    pruned_match = False
    if isinstance(value, list) and whole_records is not None:
        rows = [row if str(i) in whole_records else {k: v for k, v in row.items() if k in fields} for i, row in enumerate(value)]
        pruned_match = bool(lookup_step and value and value[0] and not rows[0])
        value = rows
    return [CACHE_FORM, tag, value, bool(pg), pruned_match]


def too_big_to_keep(ck, doc):
    return len(json.dumps({"v": 1, "key": ck, "ts": time.time(), "value": doc}).encode("utf-8")) > CACHE_MAX


class Loaded(object):
    """What load() produced: the data by endpoint name, banner notes, and a terminal note when nothing can be shown."""

    def __init__(self):
        self.data, self.notices, self.stop = {}, [], None
        self.cached_age, self.from_cache = 0, False
        self.pruned_lookup_matches = set()


NOW_OVERRIDE = [None]   # sample mode sets this from fixtures.json "_now" so {today} does not drift
DATE_TOKEN = re.compile(r"\{today(?:([+-])(\d{1,4})d)?\}")


def _day(delta):
    return time.strftime("%Y-%m-%d", time.localtime((NOW_OVERRIDE[0] or time.time()) + delta * 86400))


def fill_path(path, pvars):
    """Fill {today}, {today-7d}, {today+1d} (local dates), then {name} and {name.field} from earlier results and the typed query, URL-quoted."""
    path = DATE_TOKEN.sub(lambda m: _day(int(m.group(2) or 0) * (-1 if m.group(1) == "-" else 1)), path)
    def quoted(m):
        q = urllib.parse.quote(str(lookup(m.group(1), pvars, {}) if lookup(m.group(1), pvars, {}) is not None else ""), safe="")
        return q.replace(".", "%2E") if q in (".", "..") else q   # a lone dot segment would be resolved away by the server or a proxy
    return TOKEN.sub(quoted, path) if pvars else path


def load(cfg, names, refresh, demo, fixture_mode, fixtures, pvars=None, deadline=None):
    """deadline: the time budget of the whole run; a lookup chain passes one to every step, so the steps together stay inside TOTAL_BUDGET."""
    L = Loaded()
    eps, api, app = cfg["endpoints"], cfg.get("api") or {}, cfg["app"]
    name = app.get("service", app["title"])
    ttl = float((cfg.get("cache") or {}).get("ttl", 45))
    stale_max = float((cfg.get("cache") or {}).get("stale_max", 86400))

    def finish(got, failed, stale_ages, no_copy=()):
        """got holds (value, paged) by endpoint (see settle); no_copy names the failed calls whose last answer was too large to keep."""
        for n, (v, pg) in got.items():
            L.data[n] = v
            if pg:
                L.notices.append(("page", "Counts and totals cover the first page only", "%s has more rows than one answer holds (%s)" % (name, n), 0))
        if not failed:
            return L
        causes = list(failed.values())
        nf = sorted(n for n, c in failed.items() if c == "notfound")
        if causes and all(c == "notfound" for c in causes):
            if not got:   # every call of the run answered 404 and nothing else is shown: the service is up and has no such thing
                noun = str(app.get("noun") or "").strip()
                q = (pvars or {}).get("query")
                if noun:
                    title = "No such %s" % noun
                elif cfg.get("mode") == "lookup":
                    title = (cfg.get("lookup") or {}).get("none_title", "No match")
                else:
                    title = "The service answered 404 for %s" % ", ".join(nf)
                L.stop = ("notfound", title, 'Nothing found for "%s"' % q if q else "The service says there is nothing at that address (HTTP 404)", 0)
                return L
            # some calls worked: keep their data and say which one answered 404
            L.notices.append(("partial", "Some data did not load: %s" % ", ".join(nf), "%s answered 404" % ", ".join(nf), 0))
            return L
        causes = [c for c in causes if c != "notfound"] or causes
        main = "auth" if "auth" in causes else max(set(causes), key=causes.count)
        late = ("%s did not answer in time (all calls together get %d s)" % (name, int(TOTAL_BUDGET)) if deadline is not None and deadline.expired()
                else "%s did not answer in %d s" % (name, int(REQ_TIMEOUT)))
        text = {"timeout": late, "auth": "%s rejected the API key" % name,
                "rate": "%s is limiting requests, try again in a minute" % name, "conn": "Could not connect to %s" % name,
                "toolarge": "%s sent more than %d MB, more than this app reads" % (name, MAX_ANSWER // (1024 * 1024)),
                "other": "%s returned an error" % name}[main]
        big = sorted(n for n in failed if n in no_copy)
        why = (". No old copy of %s: its last answer was over %d MB, more than the cache keeps" % (", ".join(big), CACHE_MAX // (1024 * 1024))) if big else ""
        if main == "auth":
            L.stop = ("auth", text, "Check the %s key (see the setup line in the README), then press Enter to retry" % api.get("key_env", "API"), 0)
        elif not [n for n in names if n not in failed or n in stale_ages]:
            L.stop = ("offline", text, "Enter to retry" + why if why else "Enter to retry, or try again later", 0)
        elif stale_ages:
            oldest = max(stale_ages.values())
            L.notices.append(("stale", "%s is not answering. Showing data from %s ago." % (name, ago(oldest)), "%s. Enter to retry" % text, oldest))
        missing = [n for n in failed if n not in stale_ages]
        if missing and not L.stop:
            L.notices.append(("partial", "Some data did not load: %s" % ", ".join(sorted(missing)), "%s. Enter to retry%s" % (text, why), 0))
        return L

    if fixture_mode:
        NOW_OVERRIDE[0] = fixtures.get("_now") if isinstance(fixtures.get("_now"), (int, float)) else None
        sec = find_key(app, api)[0] if api.get("key_env") else ""
        if sec:
            fixtures = kit.redact_tree(fixtures, [sec], api.get("auth_param"))   # sample answers get the same treatment as live ones
        if demo == "demo-nokey":
            L.stop = ("nokey", "Add your %s API key" % name, kit.setup_hint(app["id"], api.get("key_env", "API_KEY")), 0)
            return L
        if demo == "demo-notfound":
            return finish({}, dict((n, "notfound") for n in names), {})
        if demo in ("demo-offline", "demo-auth", "demo-stale"):
            cause = "auth" if demo == "demo-auth" else "conn"
            return finish({}, dict((n, cause) for n in names), {}) if demo != "demo-stale" else _stale_demo(L, cfg, names, fixtures, finish)
        got = dict((n, settle(eps[n], fixtures[n])) for n in names if n in fixtures)
        return finish(got, dict((n, "other") for n in names if n not in fixtures), {})
    if not api.get("base_url"):
        raise ConfigError("this app has no api.base_url, so it can only show sample data")
    if not https_or_loopback(api["base_url"]):
        raise ConfigError("api.base_url must be https (http only to this machine) so the key is never sent in the clear")
    key, problem = find_key(app, api) if api.get("key_env") else ("", "")
    if problem or (not key and api.get("key_env")):   # the row names the cause: a refused key, a key file that gives none, or no key at all
        L.stop = ("nokey",) + (key_advice(app, api, problem) or ("Add your %s API key" % name, kit.setup_hint(app["id"], api.get("key_env", "API_KEY")))) + (0,)
        return L
    tag = _hash(json.dumps(cfg, sort_keys=True))   # a copy made under another config.json is a miss: its rows were mapped and cut for that one
    fields, paths = cache_reads(cfg)
    lookup_step = pvars is not None

    def doc_ok(d):   # see cache_doc
        return isinstance(d, list) and len(d) == 5 and d[0] == CACHE_FORM and d[1] == tag and (isinstance(d[2], (list, dict)) or d[3] == "too large")

    def from_cache(n, doc):
        if doc[4]:
            L.pruned_lookup_matches.add(n)
        return doc[2], doc[3] is True

    fresh = kit.Cache(app["id"], ttl, doc_ok)
    old = kit.Cache(app["id"] + "-stale", stale_max, doc_ok)
    deadline = deadline or kit.Deadline(TOTAL_BUDGET)
    got, todo = {}, []
    for n in names:
        ck = "%s:%s" % (n, _hash(api["base_url"] + fill_path(eps[n]["path"], pvars)))
        hit = None if refresh else fresh.get(ck)
        if hit is not None and hit[2] is not None:
            got[n] = from_cache(n, hit)
            L.from_cache = True
            L.cached_age = max(L.cached_age, int(fresh.age(ck) or 0))
        else:
            todo.append(n)

    def fetch(n):
        def run():
            if deadline.expired():   # an earlier step of a chain used the whole budget
                return kit.Probe(n, False, reason="timeout")
            try:
                v = http_get(api, key, fill_path(eps[n]["path"], pvars), deadline.cap(REQ_TIMEOUT))
                if eps[n].get("hydrate"):
                    v = hydrate(api, key, eps[n], v, deadline)
                v = kit.redact_tree(v, [key] if key else [], api.get("auth_param"))   # APIs echo the key in their links and errors: strip it before anything is cached or shown
                return kit.Probe(n, v is not None and unwrap(eps[n], v) is not None, v, "other")
            except Exception as e:
                return kit.Probe(n, False, reason=cause_of(e))
        return run
    res = kit.run_parallel(dict((n, fetch(n)) for n in todo), deadline) if todo else {}
    failed, stale_ages, no_copy = {}, {}, set()
    for n in todo:
        p, ck = res[n], "%s:%s" % (n, _hash(api["base_url"] + fill_path(eps[n]["path"], pvars)))
        if p.ok:
            got[n] = settle(eps[n], p.value)
            whole_records = whole_record_indexes(n, paths, lookup_step)
            doc = cache_doc(tag, got[n][0], got[n][1], fields, whole_records, lookup_step)
            fresh.put(ck, doc)      # put() refuses failures; they are never cached
            if not old.put(ck, doc) and old.enabled and too_big_to_keep(ck, doc) and (old.get(ck) or [None] * 5)[2] is None:
                old.put(ck, [CACHE_FORM, tag, None, "too large", False])   # no old copy to keep: a later failure says why
        else:
            failed[n] = "timeout" if p.timed_out else (p.reason if p.reason in ("auth", "rate", "timeout", "conn", "notfound", "toolarge") else "other")
            prev = old.get(ck) if failed[n] != "notfound" else None   # a 404 means it is gone: never show an old copy of it
            if prev is not None and prev[2] is not None:
                got[n] = from_cache(n, prev)
                stale_ages[n] = old.age(ck) or 0
            elif prev is not None:
                no_copy.add(n)
    return finish(got, failed, stale_ages, no_copy)


def _stale_demo(L, cfg, names, fixtures, finish):
    got = dict((n, settle(cfg["endpoints"][n], fixtures[n])) for n in names if n in fixtures)
    return finish(got, dict((n, "conn") for n in names), dict((n, 10800) for n in got))


def _hash(s):
    return hashlib.sha256(s.encode("utf-8")).hexdigest()[:8]


# ---------------------------------------------------------------- rows

def sort_items(view, items):
    out = list(items)
    for spec in reversed(view.get("sort") or []):
        order = spec.get("order")

        def k(x, spec=spec, order=order):
            v = get_path(x, spec["field"])
            if order:
                return (order.index(v) if v in order else len(order), str(v).lower())
            n = number(v)
            return (0, n, "") if n is not None else (1, 0, str(v if v is not None else "").lower())
        out.sort(key=k, reverse=bool(spec.get("desc")))
    return out


def item_id(view, item):
    """The nav arg for an item. A nav token (letters, digits, _ . -, at most 64) is used as it is unless it ends in . and 12 lowercase hex
    digits. Those ids and non-token ids become an ASCII part and a hash of the whole id, keeping derived args separate from unchanged ids."""
    raw = str(get_path(item, view.get("id_field", "id")))
    if token(raw) == raw and not re.search(r"\.[0-9a-f]{12}\Z", raw):
        return raw
    fold = unicodedata.normalize("NFKD", raw).encode("ascii", "ignore").decode("ascii")
    fold = re.sub(r"\.{2,}", ".", re.sub(r"[^A-Za-z0-9_.-]+", "-", fold)).strip("-.")[:40].rstrip("-.")
    if fold == "refresh" or fold.startswith("refresh."):
        fold = "id-" + fold
    return "%s.%s" % (fold or "id", hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12])


def extra_fields(spec, item, glob):
    """Named row fields a widget binds ({{row.name}}). A value that is exactly one {name} keeps a number a number,
    so a chart or tile reads it as one."""
    out = {}
    for name, tpl in (spec.get("extra") or {}).items():
        m = TOKEN.fullmatch(tpl) if isinstance(tpl, str) else None
        v = lookup(m.group(1), item, glob) if m and not m.group(2) else None
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            out[name] = v
        elif isinstance(tpl, (int, float)) and not isinstance(tpl, bool):
            out[name] = tpl
        else:
            out[name] = render(tpl, item, glob)
    return out


def item_row(cfg, view, item, glob, nav):
    spec = view["item"]
    title = render(spec.get("title", "{title}"), item, glob)
    subtitle = render(spec.get("subtitle", ""), item, glob)
    tile, badge = make_tile(spec.get("tile"), item, glob)
    fields = {}
    for i, f in enumerate((spec.get("fields") or [])[:MAX_FIELDS]):
        fields["f%d" % (i + 1)] = render(f.get("value", ""), item, glob)
    ex = extra_fields(spec, item, glob)
    multiline = dict((k, ex.pop(k)) for k in list(ex) if kit.MULTILINE.match(k) and isinstance(ex[k], str))
    fields.update(ex)
    url = render(spec.get("url", ""), item, glob, strict=True) if spec.get("url") else None
    url = url if url and re.match(r"^https?://", url) else None
    kw = dict(icon=spec.get("icon", view.get("icon", "list")), body=render(spec.get("body", ""), item, glob), tile=tile, badge=badge,
              pane=view.get("pane_id", view["id"]), open_url=url or "", multiline=multiline, **fields)
    if isinstance(spec.get("data_field"), str) and isinstance(get_path(item, spec["data_field"]), dict):
        kw["data"] = get_path(item, spec["data_field"])
    if isinstance(spec.get("trend_field"), str) and isinstance(get_path(item, spec["trend_field"]), list):
        kw["trend"] = get_path(item, spec["trend_field"])
    if nav:
        return kit.safe_row(title, subtitle, nav=nav, manifest_actions=2, **kw)
    cp = render(spec.get("copy"), item, glob) if spec.get("copy") else True
    return kit.safe_row(title, subtitle, copy=cp, url=url, manifest_actions=2, **kw)


def noted(view_id, text):
    """pane and body for a row with no fields of its own: the note view where the view's pane binds fields, else the view's own pane."""
    return dict(pane=NOTE_ACTIVE[0] or view_id, body=text if NOTE_ACTIVE[0] else "")


def back_row(subtitle):
    return kit.back_row(subtitle, view=NOTE_ACTIVE[0])


def refresh_row(view_id, arg="refresh", title="Refresh", sub="Enter to fetch fresh data"):
    note = NOTE_ACTIVE[0]
    return kit.refresh_row(view_id, title=title, subtitle=sub, pane=note) if arg == "refresh" else kit.row(
        title, sub, icon="RefreshCw", nav={"view": view_id, "arg": arg}, pane=note or view_id, body=kit.REFRESH_BODY if note else "", copy=False)


def notice_rows(L, view_id, arg, ttl):
    rows = []
    for kind, title, sub, age in L.notices:
        tile = kit.tile("Data age", age, "s", None, note="old copy") if age else None
        rows.append(kit.row(title, sub, icon="AlertCircle", nav={"view": view_id, "arg": arg}, pane=NOTE_ACTIVE[0] or view_id, body=sub if NOTE_ACTIVE[0] else "", copy=False,
                            tile=tile, badge={"stale": "STALE", "partial": "PARTIAL", "page": "FIRST PAGE"}[kind]))
    if not rows and L.from_cache and L.cached_age >= 2:
        forced = arg == "refresh" or arg.startswith("refresh.")   # not for an id too long for "refresh.<id>": Enter reopens it from the cache
        sub = "Enter to refresh (data is kept %d s)" % ttl if forced else "Data is kept %d s; this id is too long for a forced refresh" % ttl
        rows.append(kit.row("Loaded from cache, %d s old" % L.cached_age, sub, icon="RefreshCw",
                            nav={"view": view_id, "arg": arg}, pane=NOTE_ACTIVE[0] or view_id, body=sub if NOTE_ACTIVE[0] else "", copy=False,
                            tile=kit.tile("Data age", L.cached_age, "s", ttl, note="from cache, Enter to refresh" if forced else "from cache"), badge="CACHED"))
    return rows


def stop_rows(L, view_id, arg):
    kind, title, sub, _ = L.stop
    if kind == "notfound":
        return [kit.row(title, sub, icon="Search", copy=False)]   # nothing to retry: no nav, no tile, no pane
    icon = {"auth": "Key", "nokey": "Key"}.get(kind, "AlertCircle")
    badge = {"auth": "KEY", "nokey": "KEY", "offline": "OFFLINE"}.get(kind, "")
    return [kit.row(title, sub, icon=icon, nav={"view": view_id, "arg": arg}, copy=False, badge=badge, pane=NOTE_ACTIVE[0], body=sub if NOTE_ACTIVE[0] else "")]   # no tile fields: a setup row must not draw an empty tile in the right pane; in a field-binding view it draws the note


def overview_rows(cfg, glob):
    out = []
    for r in (cfg.get("overview") or {}).get("rows", []):
        if r.get("only_if") and lookup(r["only_if"], None, glob) is None:
            continue
        tile, badge = make_tile(r.get("tile"), None, glob)
        url = render(r.get("url", ""), None, glob, strict=True) if r.get("url") else None
        url = url if url and re.match(r"^https?://", url) else None
        kw = dict(icon=r.get("icon", "list"), body=render(r.get("body", ""), None, glob), tile=tile, badge=badge, open_url=url or "", manifest_actions=2)
        kw.update(extra_fields(r, None, glob))
        if isinstance(r.get("trend"), list):
            kw["trend"] = r["trend"]
        elif r.get("trend_path") and isinstance(lookup(r["trend_path"], None, glob), list):
            kw["trend"] = [x for x in lookup(r["trend_path"], None, glob)[:60] if number(x) is not None]
        if r.get("view"):
            out.append(kit.row(render(r["title"], None, glob), render(r.get("subtitle", ""), None, glob),
                               nav=dict(([("view", r["view"])] + ([("arg", token(r["arg"]))] if r.get("arg") else []))), **kw))
        else:
            out.append(kit.row(render(r["title"], None, glob), render(r.get("subtitle", ""), None, glob), copy=True if not url else True, url=url, **kw))
    return out


def children_of(cfg, view, item, data, glob):
    vs = views_by_id(cfg)
    rows = []
    for c in view.get("children") or []:
        cv = vs[c["view"]]
        pid = get_path(item, c.get("parent_field", view.get("id_field", "id")))
        for x in sort_items(cv, data.get(cv["endpoint"]) or []):
            if get_path(x, c["match"]) == pid:
                rows.append((cv, x))
    return rows


def unread_row(view, at, arg="refresh"):
    """The row for a list whose call failed with no old copy to show: it says the list did not load, never "0 rows" or "nothing linked".
    Enter reloads the view `at` (the list itself, or the detail the list belongs to)."""
    sub = "The list did not load, so it is not shown as empty. Enter to retry"
    return kit.row("Could not read %s" % view.get("title", view["id"]).lower(), sub, icon="AlertCircle", nav={"view": at, "arg": arg},
                   copy=False, badge="ERROR", **dict(noted(at, sub), **dict(("f%d" % (i + 1), "") for i in range(MAX_FIELDS))))


def list_rows(cfg, view, data, glob, flt):
    if data.get(view["endpoint"]) is None:   # not read: a failed call is never shown as an empty list
        return [back_row("Back to the overview")], [unread_row(view, view["id"])]
    vs = views_by_id(cfg)
    items = sort_items(view, data.get(view["endpoint"]) or [])
    nav_to_detail = bool(view.get("children"))
    rows = []
    for x in items:
        r = item_row(cfg, view, x, glob, {"view": view["id"], "arg": item_id(view, x)} if nav_to_detail and item_id(view, x) else None)
        if flt and flt.lower() not in " ".join(str(r.get(k, "")) for k in ("title", "subtitle", "kpi_badge", "f1", "f2", "f3", "f4", "f5")).lower():
            continue
        rows.append(r)
    total = len(items)
    sub = "%d %s" % (total, view.get("title", view["id"]).lower())
    if flt:
        sub = "%d of %d match \"%s\"" % (len(rows), total, flt)
    if len(rows) > MAX_ROWS:
        sub += ", showing the first %d" % MAX_ROWS
        rows = rows[:MAX_ROWS]
    head = [back_row("Back to the overview")]
    if flt:
        head.append(kit.row("Showing %d of %d" % (len(rows), total), "Enter to clear the filter \"%s\"" % flt, icon="Search",
                            nav={"view": view["id"]}, copy=False, **noted(view["id"], "Enter to clear the filter \"%s\"" % flt)))
    if not rows:
        rows = [kit.row(view.get("empty", "Nothing to show"), "No matching rows" if flt else "The API returned no rows", icon=view.get("icon", "list"),
                        copy=False, **dict(noted(view["id"], "No matching rows" if flt else "The API returned no rows"), **dict(("f%d" % (i + 1), "") for i in range(MAX_FIELDS))))]
    head[0] = back_row(sub)
    return head, rows


def detail_rows(cfg, view, data, glob, wanted, refresh_arg):
    vs = views_by_id(cfg)
    found = [x for x in data.get(view["endpoint"]) or [] if item_id(view, x) == wanted]
    if not found:
        return [back_row("Back to the list"), kit.row("Not found", "No %s with id %s" % (view.get("title", view["id"]).lower(), wanted), icon="AlertCircle", copy=False, **noted(view["id"], "No %s with id %s" % (view.get("title", view["id"]).lower(), wanted)))]
    item = found[0]
    kids = children_of(cfg, view, item, data, glob)
    rows = [back_row("Back to %s" % view.get("title", view["id"]).lower()), item_row(cfg, view, item, glob, None)]
    unread = [vs[c["view"]] for c in view.get("children") or [] if data.get(vs[c["view"]]["endpoint"]) is None]
    for cv, x in kids[:max(0, MAX_ROWS - 4 - len(unread))]:
        rows.append(item_row(cfg, cv, x, glob, {"view": cv["id"], "arg": item_id(cv, x)} if cv.get("children") and item_id(cv, x) else None))
    for cv in unread:   # each linked list that did not load says so, beside the linked rows that did
        rows.append(unread_row(cv, view["id"], refresh_arg))
    if not kids and not unread and view.get("children"):
        rows.append(kit.row(view.get("no_children", "Nothing linked"), "No related rows", icon="list", copy=False, **noted(view["id"], "No related rows")))
    return rows


# ---------------------------------------------------------------- app file

ACT_OPEN = "op" + "en"   # the action id; written in two parts because the install prompt's text search reads a quoted open followed by a comma as starting other programs
FILE_WORDS = [_PFX + w for w in ("config.json", "fixtures.json", "bolt_app_kit.py",) + (("bolt_app_engine.py",) if globals().get("_THIN_ENTRY") else ())]   # named in the command so editing any of them asks again; a thin entry (see kit/examples/ENGINE.md) also names the engine file it runs
TILE_BIND = [("title", "{{row.kpi_label}}"), ("value", "{{row.kpi_value}}"), ("unit", "{{row.kpi_unit}}"), ("max", "{{row.kpi_max}}"),
             ("subtitle", "{{row.kpi_note}}"), ("badge", "{{row.kpi_badge}}"), ("footer", "{{row.kpi_foot}}")]


LINE_BREAKS = ("\n", "\r", "\x85", "\u2028", "\u2029")   # the plain YAML the launcher reads keeps a value on one line and escapes only \" and \\


def yq(v):
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    if any(c in str(v) for c in LINE_BREAKS):   # emit_yaml names the config key first; this catches a value it did not list
        raise ConfigError("a value for the app file holds a line break: %s" % json.dumps(str(v))[:60])
    return '"%s"' % str(v).replace("\\", "\\\\").replace('"', '\\"')


def first_break(o, path):
    """The config path of the first string (value or key) under o that holds a line break, or None."""
    if isinstance(o, str):
        return path if any(c in o for c in LINE_BREAKS) else None
    for k, x in (o.items() if isinstance(o, dict) else enumerate(o) if isinstance(o, list) else ()):
        hit = first_break(str(k), path) if isinstance(o, dict) else None
        hit = hit or first_break(x, ("%s.%s" if isinstance(o, dict) else "%s[%s]") % (path, k))
        if hit:
            return hit
    return None


def yaml_spots(cfg):
    """(config path, value) for every part of config.json that emit_yaml writes into the app file."""
    app, mode = cfg.get("app") or {}, cfg.get("mode", "views")
    out = [("app.%s" % k, app.get(k)) for k in ("id", "chip", "title", "icon", "description")]
    if mode == "form":
        fm = cfg.get("form") or {}
        out += [("form.placeholder", fm.get("placeholder")), ("form.inputs", fm.get("inputs")), ("form.submit.label", (fm.get("submit") or {}).get("label")), ("form.widget", fm.get("widget"))]
    elif mode == "lookup":
        lk = cfg.get("lookup") or {}
        out += [("lookup.examples", lk.get("examples")), ("lookup.widget", lk.get("widget"))]
    else:
        out.append(("overview.widget", (cfg.get("overview") or {}).get("widget")))
        for i, v in enumerate(cfg.get("views") or []):
            out.append(("views[%d].widget" % i, v.get("widget")) if v.get("widget") else ("views[%d].item.fields" % i, (v.get("item") or {}).get("fields")))
    return out


def yflow(v):
    if isinstance(v, dict):
        return "{ " + ", ".join("%s: %s" % (k, yflow(x)) for k, x in v.items()) + " }"
    if isinstance(v, list):
        return "[" + ", ".join(yflow(x) for x in v) + "]"
    return yq(v)


def yblock(v, indent):
    """Plain YAML: bare keys, one-line values, block maps and lists, flow maps for list items. No anchors or block scalars."""
    pad = " " * indent
    out = []
    if isinstance(v, dict):
        for k, x in v.items():
            if isinstance(x, (dict, list)) and x:
                out.append("%s%s:" % (pad, k))
                out += yblock(x, indent + 2)
            else:
                out.append("%s%s: %s" % (pad, k, yflow(x)))
    elif isinstance(v, list):
        for x in v:
            out.append("%s- %s" % (pad, yflow(x)))
    return out


def widget_lines(w, indent):
    pad = " " * indent
    out = ["%skind: %s" % (pad, w["kind"]), "%smode: %s" % (pad, w.get("mode", "selected_row"))]
    if w.get("bind"):
        out.append("%sbind:" % pad)
        out += yblock(w["bind"], indent + 2)
    return out


def preview_widget(v):
    fields = []
    for i, f in enumerate(v["item"].get("fields") or []):
        d = {"label": f["label"], "value": "{{row.f%d}}" % (i + 1)}
        if f.get("kind") == "chips":
            d["kind"] = "chips"
        fields.append(d)
    return {"kind": "entity_preview", "mode": "selected_row", "bind": {
        "title": "{{row.title}}", "subtitle": "{{row.subtitle}}", "tiles_above": dict(TILE_BIND),
        "fields": fields, "body": "{{row.body}}", "actions": [ACT_OPEN, "copy"]}}


def tiles_widget():
    b = {"layout": "tiles"}
    b.update(dict(TILE_BIND))
    return {"kind": "cards", "mode": "list_data", "bind": b}


def view_widget(v):
    return v.get("widget") or preview_widget(v)


def emit_yaml(cfg):
    for where, value in yaml_spots(cfg):
        bad = first_break(value, where)
        if bad:
            raise ConfigError("config.json: %s holds a line break, which the app file cannot keep (each value there is one line): write it on one line" % bad)
    app, mode = cfg["app"], cfg.get("mode", "views")
    vs = cfg.get("views") or []
    words = " ".join("{{scripts_dir}}/%s" % f for f in FILE_WORDS)
    L = ["# Generated by: python3 scripts/" + _SELF + " --emit-yaml (edit config.json, not this file)",
         "schema_version: 1", "runtime: bridge", "id: %s" % app["id"], "chip: %s" % app["chip"], "title: %s" % yq(app["title"]),
         "icon: %s" % app.get("icon", "shield-check"), "description: %s" % yq(app.get("description", app["title"]))]
    if mode == "form":
        fm = cfg["form"]
        L.append("placeholder_examples: [%s]" % yq(fm.get("placeholder", "Fill the form and press " + fm["submit"]["label"])))
    elif mode == "lookup":
        L.append("placeholder_examples: [%s]" % ", ".join(yq(x) for x in cfg["lookup"].get("examples", ["type a name"])))
    else:
        L.append("placeholder_examples: [%s]" % ", ".join(yq(x) for x in ["Enter for overview"] + [v["id"] for v in vs][:6]))
    L.append("emits: Generic")
    if mode == "form":
        L.append("inputs:")
        for f in cfg["form"]["inputs"]:
            d = dict((k, f[k]) for k in ("name", "type", "label", "required", "min", "max", "step", "placeholder", "default", "options", "max_length", "pattern") if k in f)
            L.append("  - " + yflow(d))
        L += ["submit:", "  label: %s" % yq(cfg["form"]["submit"]["label"])]
        cmd_args = " ".join("{{%s}}" % f["name"] for f in cfg["form"]["inputs"])
    elif mode == "lookup":
        L += ["args:", '  - { name: q1, from: "query.word(0)", default: "-" }', '  - { name: q2, from: "query.word(1)", default: "-" }', '  - { name: q3, from: "query.word(2)", default: "-" }']
        cmd_args = "{{q1}} {{q2}} {{q3}}"
    else:
        L += ["args:", '  - { name: view, from: "query.word(0)", default: overview }', '  - { name: arg, from: "query.word(1)", default: "-" }']
        cmd_args = "{{view}} {{arg}}"
    L += ["bridge:", "  command:"]
    for osn, py in (("macos", "python3"), ("linux", "python3"), ("windows", "python")):
        L.append(('    %s: "%s {{scripts_dir}}/' + _SELF + ' %s %s"') % (osn, py, cmd_args, words))
    L += ["  parse: json", "  timeout_seconds: %d" % int(app.get("timeout", 25)), "presentation:", "  widget: list", "  title_field: title", "  subtitle_field: subtitle"]
    if app.get("searchable"):
        L.append("  searchable: true")
    if mode == "views":
        L += ["  view_arg: view", "  right_widget:"] + widget_lines((cfg.get("overview") or {}).get("widget") or tiles_widget(), 4)
        L += ["  views:", "    overview: {}"]
        for v in vs:
            L += ["    %s:" % v["id"], "      right_widget:"] + widget_lines(view_widget(v), 8)
        plan = note_plan(cfg) or (None, False)
        if plan[1]:
            L += note_lines(plan[0])
    elif mode == "form":
        L.append("  right_widget:")
        L += widget_lines(cfg["form"]["widget"], 4)
    else:
        L.append("  right_widget:")
        L += widget_lines(cfg["lookup"]["widget"], 4)
    L += ["actions:", '  - { id: open, kind: url, target: row, label: Open, url_template: "{{row.open_url}}" }',
          '  - { id: copy, kind: composer, target: row, label: Copy, insert: "{{row.copy_text}}" }']
    return "\n".join(L) + "\n"


# ---------------------------------------------------------------- main

def split_args(argv):
    """Positional words follow the config. The config is config.json beside this script; --config=PATH overrides it (tests).
    Words that name a file of this app (the command lists them so an edit asks again) are not input and are dropped."""
    cfg = os.path.join(HERE, _PFX + "config.json")
    for a in argv[1:]:
        if a.startswith("--config=") and os.environ.get("BOLT_APP_TEST"):   # tests only: a typed query word must never switch the config
            cfg = a[len("--config="):]
    args = [a for a in argv[1:] if not a.startswith("--") and not (os.path.isabs(a) and os.path.basename(a) in FILE_WORDS)]
    return cfg, args


def never_fetches(cfg):
    """An app with no api section, or one that ships with api.fixture_default true, never contacts a service: it draws no Refresh row."""
    api = cfg.get("api") or {}
    return not api or api.get("fixture_default") is True


def fixture_mode(cfg):
    e = os.environ.get("BOLT_APP_FIXTURE")
    if e in ("0", "1"):
        return e == "1"
    return bool((cfg.get("api") or {}).get("fixture_default", not cfg.get("api")))


def read_fixtures(cfg, cfg_path):
    _cn = os.path.basename(cfg_path)
    fp = os.path.join(os.path.dirname(os.path.abspath(cfg_path)), (_cn[:-len("config.json")] if _cn.endswith("config.json") else "") + (cfg.get("api") or {}).get("fixture_file", "fixtures.json"))
    try:
        with open(fp, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        raise ConfigError("Fixture mode is on but %s could not be read" % os.path.basename(fp))


SAMPLE_FALLBACK = [False]   # set by run(): no key was found and api.on_missing_key is "sample"


def is_tiles_grid(w):
    return bool(w) and w.get("kind") == "cards" and (w.get("bind") or {}).get("layout") == "tiles"


# The first row of a drilled list is selected when it opens, so the Back row is the first thing the right pane draws. A pane that binds fields (detail, card, diff, json_tree...)
# draws dash placeholders for a row that has none, so in a view like that the Back, Refresh and notice rows point at a small markdown view, "note", that draws their own words.
NOTE_VIEW = kit.NOTE_VIEW
NOTE_VIEW_ALT = "back-note"
NOTE_ACTIVE = [None]   # set by run_views for the view being drawn: the note view's id when its pane binds fields a nav row lacks, else None


def pane_binds_fields(w):
    return bool(w) and (w.get("mode") or "selected_row") == "selected_row" and w.get("kind") not in (None, "entity_preview", "markdown")


MAX_VIEWS = 8   # Bolt refuses an app file with more than 8 entries in presentation.views (the overview counts as one)


def note_plan(cfg):
    """(view id, declare) for the pane of the Back, Refresh and notice rows, or None when no view draws a field-binding pane (or there is no room for the note view).
    A markdown selected_row view that already binds exactly title, subtitle and body is reused (declare False); else the `note` view is added when the app has room for it."""
    vs = cfg.get("views") or []
    if cfg.get("mode", "views") != "views":
        return None
    if not (any(pane_binds_fields(view_widget(v)) for v in vs) or pane_binds_fields((cfg.get("overview") or {}).get("widget"))):
        return None
    for v in vs:
        w = view_widget(v)
        b = w.get("bind") or {}
        if w.get("kind") == "markdown" and (w.get("mode") or "selected_row") == "selected_row" and [b.get(k) for k in ("title", "subtitle", "body")] == ["{{row.title}}", "{{row.subtitle}}", "{{row.body}}"] and set(b) <= {"title", "subtitle", "body", "actions"}:
            return v["id"], False
    free = [n for n in (NOTE_VIEW, NOTE_VIEW_ALT) if not any(v.get("id") == n for v in vs)]   # the author's own `note` view is theirs: take the next name
    return (free[0], True) if free and len(vs) + 1 < MAX_VIEWS else None


def note_lines(name):
    return ["    %s:" % name, "      right_widget:"] + widget_lines({"kind": "markdown", "mode": "selected_row", "bind": {"title": "{{row.title}}", "subtitle": "{{row.subtitle}}", "body": "{{row.body}}"}}, 8)


def view_widget_of(cfg, view_id):
    """The right_widget the emitted app file gives this run (see emit_yaml): the form or lookup widget, the overview widget, or the view's own."""
    mode = cfg.get("mode", "views")
    if mode == "form":
        return cfg["form"]["widget"]
    if mode == "lookup":
        return cfg["lookup"]["widget"]
    if view_id == "overview":
        return (cfg.get("overview") or {}).get("widget") or tiles_widget()
    v = views_by_id(cfg).get(view_id)
    return view_widget(v) if v else None


def label_on_tile(rows, hint):
    """In a tiles grid a row with no number draws an empty "-" tile, so the label rides on the FIRST real tile, in one place, without clobbering its data: SAMPLE as its badge when it has none,
    the hint in its footer when that is free, else added to its note."""
    tiles = [r for r in rows if isinstance(r.get("kpi_value"), (int, float)) and not isinstance(r.get("kpi_value"), bool)]
    if not tiles:
        return False
    first = tiles[0]
    if not first.get("kpi_badge"):
        first["kpi_badge"] = "SAMPLE"
    if not first.get("kpi_foot"):
        first["kpi_foot"] = hint[:80]
    else:
        tag = " · sample data"   # the footer holds real data, so the label is the short tail of the note
        first["kpi_note"] = ((first.get("kpi_note") or "")[:80 - len(tag)] + tag) if first.get("kpi_note") else "sample data"
    return True


def mark_subtitle(rows, text):
    """Say it where a pane cannot show a label row: in the list's own subtitle of the first row (the Back row when there is one), which the widget does not plot."""
    if rows:
        r = rows[0]
        r["subtitle"] = ((r.get("subtitle") or "") + (" · " if r.get("subtitle") else "") + text)[:200]
    return rows


def sample_banner(cfg, rows, fx=True, quiet=False, view_id="overview"):
    at = 1 if rows and (rows[0].get("nav") or {}).get("back") else 0
    app, api = cfg["app"], cfg.get("api") or {}
    name = app.get("service", app["title"])
    w = view_widget_of(cfg, view_id) or {}
    kind, tiles = w.get("kind"), is_tiles_grid(w)
    if SAMPLE_FALLBACK[0]:   # the labelled sample data is shown with a label and a key hint: never instead of the data
        hint = "sample data: add your %s API key for live data" % name
        if tiles and label_on_tile(rows, hint):
            return rows
        if kind not in (None, "entity_preview", "markdown"):   # these panes plot, compare or lay out fields the label row does not have (a data point, a blank pane): the label goes in the first row's subtitle
            return mark_subtitle(rows, "sample data")
        # a row the person can select has text in its pane: the label and hint carry a body
        rows.insert(at, kit.row("SAMPLE DATA: add your %s API key to see live data" % name, "These rows are invented examples, not your data.", body="Sample data: these rows are invented examples. Add your %s API key to see live data." % name, icon="FileText", copy=False, badge="SAMPLE"))
        rows.insert(at + 1, kit.row("Add your %s API key" % name, "Select this row: the steps are in its pane", body="Sample data is shown until a key is found. " + kit.setup_hint(app["id"], api.get("key_env", "API_KEY")), icon="Key", copy=False, badge="KEY"))
    elif fx and api.get("fixture_banner"):
        if tiles and label_on_tile(rows, "sample data"):
            return rows
        if kind not in (None, "entity_preview", "markdown"):
            return mark_subtitle(rows, "sample data")
        rows.insert(at, kit.row("Sample data", "This is sample data.", body="This is sample data.",
                                icon="FileText", copy=False, badge="SAMPLE"))
    return rows


def run_views(cfg, args, fx, fixtures):
    view_id = args[0] if args else "overview"
    arg = args[1] if len(args) > 1 else "-"
    vs = views_by_id(cfg)
    if view_id not in vs:
        view_id = "overview"
    NOTE_ACTIVE[0] = note_plan(cfg)[0] if note_plan(cfg) and pane_binds_fields(view_widget_of(cfg, view_id)) else None
    refresh = arg == "refresh" or arg.startswith("refresh.")
    detail_id = arg[len("refresh."):] if arg.startswith("refresh.") else ("" if arg in ("-", "refresh", "") else arg)
    demo = ""
    if fx and arg in DEMOS:
        demo, detail_id = arg, ""
    ttl = (cfg.get("cache") or {}).get("ttl", 45)
    objects = [n for n, e in cfg["endpoints"].items() if e.get("kind") == "object"]
    if view_id == "overview":
        names = list(cfg["endpoints"])
    else:
        v = vs[view_id]
        names = sorted(set([v["endpoint"]] + objects + [vs[c["view"]]["endpoint"] for c in v.get("children") or []]))
    L = load(cfg, names, refresh, demo, fx, fixtures)
    retry = "refresh" if not detail_id or view_id == "overview" else "refresh." + detail_id
    if not NAV_OK.match(retry) or ".." in retry:
        # a filter word such as C++, café or a/b cannot ride in a nav arg: retry the list (a refresh drops the filter anyway).
        # An id of 57 to 64 characters is a valid arg but too long with "refresh." in front: retry opens the detail by its id, so
        # Enter re-reads the calls that failed (they are never cached) but serves the others from the cache until its ttl ends.
        # A filter word that long and made of token characters takes the same path, so its retry keeps the filter.
        retry = detail_id if NAV_OK.match(detail_id) and ".." not in detail_id else "refresh"
    data_view = view_id != "overview" and (vs[view_id].get("widget") or {}).get("mode") == "list_data"   # every row is plotted: no Back or refresh rows
    if L.stop:
        rows = stop_rows(L, view_id, retry)
        kit.emit(([back_row("Back to the overview")] if view_id != "overview" else []) + rows)
    glob = dict(L.data)
    glob.update(compute_stats(cfg, L.data))
    if view_id == "overview":
        # a tiles grid draws a "-" tile for a row with no number, so its overview has no Refresh row (the answer is cached for a short time; type the app, then refresh, to re-read)
        rows = notice_rows(L, "overview", retry, ttl) + overview_rows(cfg, glob) + ([] if is_tiles_grid(view_widget_of(cfg, "overview")) or never_fetches(cfg) else [refresh_row("overview")])
    else:
        v = vs[view_id]
        flt = ""
        known = any(item_id(v, x) == detail_id for x in L.data.get(v["endpoint"]) or [])
        if detail_id and not (known and v.get("children")):
            flt, detail_id = (detail_id if not refresh else ""), ""
        notes = notice_rows(L, view_id, retry, ttl)
        if detail_id:
            body = detail_rows(cfg, v, L.data, glob, detail_id, retry)
            again = refresh_row(view_id, retry) if retry == "refresh" or retry.startswith("refresh.") else refresh_row(   # a long id: Enter reopens the item, it does not skip the cache
                view_id, retry, title="Reload", sub="Enter reads the calls that failed again; the rest comes from the cache (kept %d s)" % ttl)
            rows = body[:1] + notes + body[1:] + ([] if never_fetches(cfg) else [again])
        else:
            head, body = list_rows(cfg, v, L.data, glob, flt)
            if data_view and body:   # only a stale or partial notice is worth a row among the data; a skipped cell shows as a gap
                rows = [n for n in notes if n.get("kpi_badge") in ("STALE", "PARTIAL")] + body
            else:
                rows = head[:1] + notes + head[1:] + body + ([] if never_fetches(cfg) else [refresh_row(view_id)])
    kit.emit(sample_banner(cfg, rows, fx, quiet=view_id != "overview" and (vs[view_id].get("widget") or {}).get("kind") in ("chart", "table"), view_id=view_id))


def lookup_rows(cfg, items, query, glob):
    lk = cfg["lookup"]
    view = {"id": "lookup", "pane_id": None, "icon": lk.get("icon", "list"), "item": lk["item"], "id_field": lk.get("id_field", "id")}
    q = query.lower()
    exact = [x for x in items if any(str(get_path(x, f)).lower() == q for f in lk["match"])]
    hits = exact or [x for x in items if any(q in str(get_path(x, f) or "").lower() for f in lk["match"])]
    if not hits:
        return [kit.row(lk.get("none_title", "No match"), 'Nothing found for "%s"' % query, icon="Search", copy=False)]
    return [item_row(cfg, view, x, glob, None) for x in hits[:10]]


def run_lookup(cfg, args, fx, fixtures):
    lk = cfg["lookup"]
    words = [a for a in args if a != "-"]
    demo = words.pop() if fx and words and words[-1] in DEMOS else ""
    query = " ".join(words) or ("demo" if demo else "")
    refresh = query == "refresh"
    if not query or refresh:
        kit.emit([kit.row(lk.get("prompt_title", "Type what to look up"), lk.get("prompt_subtitle", "One word, then Enter"), icon="Search", copy=False)])
    if lk.get("steps"):
        # a chain: each step's path may use {query} and {earlier_step.field} (the first result of an earlier step)
        pvars, glob, notices = {"query": query}, {}, []
        deadline = kit.Deadline(TOTAL_BUDGET)   # one budget for the whole chain: the steps run one after another inside bridge.timeout_seconds
        for i, step in enumerate(lk["steps"]):
            L = load(cfg, [step], False, demo, fx, fixtures, pvars, deadline)
            if L.stop and L.stop[0] == "notfound" and i > 0:   # only the lookup that takes the typed word may say "no such": a later 404 means the chain broke
                kit.emit([kit.row("Found it, but the next lookup answered 404", "The first lookup worked; %s said there is nothing at that address. Try again later." % step, icon="AlertCircle", copy=False, badge="ERROR")])
            if L.stop:
                kit.emit(stop_rows(L, "overview", "refresh"))
            notices += notice_rows(L, "overview", "refresh", 45)
            got = L.data.get(step)
            first = got[0] if isinstance(got, list) and got else got
            if first in (None, [], {}) and step not in L.pruned_lookup_matches:
                kit.emit([kit.row(lk.get("none_title", "No match"), 'Nothing found for "%s"' % query, icon="Search", copy=False)])
            glob[step] = first
            pvars[step] = first
        rows = notices + overview_rows({"overview": {"rows": lk["rows"]}}, glob)
        kit.emit(sample_banner(cfg, rows, fx))
    L = load(cfg, [lk["endpoint"]] + [n for n, e in cfg["endpoints"].items() if e.get("kind") == "object" and n != lk["endpoint"]], False, demo, fx, fixtures)
    if L.stop:
        kit.emit(stop_rows(L, "overview", "refresh"))
    glob = dict(L.data)
    rows = notice_rows(L, "overview", "refresh", 45) + lookup_rows(cfg, L.data.get(lk["endpoint"]) or [], query, glob)
    kit.emit(sample_banner(cfg, rows, fx))


DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}\Z")


def form_values(fm, args):
    """(values, problems). Values arrive as words in the order of the inputs; a toggle is "true" or "false"."""
    vals, bad = {}, []
    for i, f in enumerate(fm["inputs"]):
        v = args[i].strip() if i < len(args) else ""
        if v == "" and f.get("default") is not None and f["type"] != "date":
            v = str(f["default"]).lower() if isinstance(f["default"], bool) else str(f["default"])
        label = f.get("label", f["name"])
        if v == "" and f["type"] == "date":
            v = time.strftime("%Y-%m-%d")
        if v == "" and f.get("required"):
            bad.append("%s is required" % label)
        elif v != "":
            if f["type"] == "number":
                n = number(v)
                if n is None or n != n or abs(n) == float("inf"):
                    bad.append("%s must be a number" % label)
                elif f.get("min") is not None and n < f["min"]:
                    bad.append("%s must be at least %s" % (label, f["min"]))
                elif f.get("max") is not None and n > f["max"]:
                    bad.append("%s must be at most %s" % (label, f["max"]))
                else:
                    v = "%.2f" % n if f.get("step") and float(f["step"]) < 1 else (str(int(n)) if n == int(n) else str(n))
            elif f["type"] == "select" and v not in (f.get("options") or []):
                bad.append("%s must be one of: %s" % (label, ", ".join(f.get("options") or [])))
            elif f["type"] == "date" and not DATE_RE.match(v):
                bad.append("%s must look like 2026-01-31" % label)
            elif f["type"] == "text" and f.get("max_length") and len(v) > int(f["max_length"]):
                bad.append("%s is longer than %s characters" % (label, f["max_length"]))
            elif f.get("pattern") and not re.search(f["pattern"], v):
                bad.append("%s is not in the expected shape" % label)
            elif f["type"] == "toggle":
                v = "true" if v.lower() in ("true", "1", "yes", "on") else "false"
        vals[f["name"]] = v
    return vals, bad


def store_path(fm):
    return os.path.expanduser(fm["store"]["file"])


def store_read(fm):
    p = store_path(fm)
    out = []
    try:
        if os.path.islink(p):
            return out
        with open(p, "r", encoding="utf-8") as f:
            for line in f:
                try:
                    x = json.loads(line)
                except ValueError:
                    continue
                if isinstance(x, dict):
                    out.append(x)
    except OSError:
        pass
    return out


_STORE_LOCK = threading.Lock()


def _win_lock(fd):
    """Windows byte lock on the log's lock file: retry a busy lock a few times, raise if it never frees (a row is never dropped quietly).
    Returns False where there is no msvcrt."""
    try:
        import msvcrt
    except ImportError:
        return False
    for attempt in range(5):
        try:
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_LOCK, 1)
            return True
        except OSError as e:
            if e.errno not in (errno.EDEADLK, errno.EACCES) or attempt == 4:
                raise
            time.sleep(0.05 * (attempt + 1))


def store_append(fm, rec):
    """Append one record to the local log (folder 0700, file 0600, never through a link); keep the newest max_rows."""
    p = store_path(fm)
    d = os.path.dirname(p)
    os.makedirs(d, 0o700, exist_ok=True)
    if os.path.islink(p) or os.path.islink(d):
        raise ConfigError("%s is a link, so nothing was saved" % os.path.basename(p))
    try:
        if os.stat(d).st_uid == os.getuid() and os.stat(d).st_mode & 0o077:
            os.chmod(d, 0o700)   # a folder that already existed with looser permissions is tightened
    except (OSError, AttributeError):
        pass
    with _STORE_LOCK:
        lock = os.open(p + ".lock", os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
        win_locked = False
        try:
            try:
                import fcntl
                fcntl.flock(lock, fcntl.LOCK_EX)   # two submits at once must not lose a row
            except ImportError:
                win_locked = _win_lock(lock)
            rows = store_read(fm) + [rec]
            rows = rows[-int(fm["store"].get("max_rows", 200)):]
            tmp = "%s.tmp%d.%d" % (p, os.getpid(), threading.get_ident())
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0), 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                for r in rows:
                    f.write(json.dumps(r, ensure_ascii=True) + "\n")
            for attempt in range(5):   # Windows can hold the target for a moment
                try:
                    os.replace(tmp, p)
                    break
                except PermissionError:
                    if attempt == 4:
                        raise
                    time.sleep(0.05 * (attempt + 1))
        finally:
            if win_locked:
                try:
                    import msvcrt
                    os.lseek(lock, 0, os.SEEK_SET)
                    msvcrt.locking(lock, msvcrt.LK_UNLCK, 1)
                except OSError:
                    pass
            os.close(lock)


def run_form(cfg, args, fx, fixtures):
    fm = cfg["form"]
    vals, bad = form_values(fm, args)
    if bad:
        kit.emit([kit.error_row("; ".join(bad[:3]), title="Not saved")])
    rec = dict((k, render(t, vals, {}, blank="")) for k, t in fm["record"].items())   # an empty input is saved as "", never as the word unknown
    store_append(fm, rec)
    saved = list(reversed(store_read(fm)))
    seeds = list(fixtures.get("seed") or []) if fx else []
    items = saved + seeds
    view = {"id": "form", "pane_id": None, "icon": fm.get("icon", "list"), "item": fm["item"]}
    rows = [item_row(cfg, view, x, {}, None) for x in items[:MAX_ROWS]]
    kit.emit(rows or [kit.row("Saved", "The log is empty", icon="list", copy=False)])


def run(argv):
    cfg_path, args = split_args(argv)
    cfg = load_config(cfg_path)
    if "--emit-yaml" in argv:
        sys.stdout.write(emit_yaml(cfg))
        sys.exit(0)
    fx = fixture_mode(cfg)
    api = cfg.get("api") or {}
    # api.on_missing_key: "setup" (default, a real app: one row that says how to add the key) or "sample" (a demo: show the labelled sample data and say a key makes it live)
    omk = api.get("on_missing_key", "setup")
    if omk not in ("setup", "sample"):
        raise ConfigError("api.on_missing_key must be setup or sample, got %s" % json.dumps(omk)[:40])
    if not fx and omk == "sample" and api.get("key_env") and os.environ.get("BOLT_APP_FIXTURE") != "0":
        key, problem = find_key(cfg["app"], api)
        if not key and not problem:   # a key file that is too open is a different problem: it keeps its own "tighten the permissions" row
            fx = True
            SAMPLE_FALLBACK[0] = True
    fixtures = read_fixtures(cfg, cfg_path) if fx else {}
    MAPS.update(cfg.get("maps") or {})
    mode = cfg.get("mode", "views")
    if mode == "form":
        run_form(cfg, args, fx, fixtures)
    elif mode == "lookup":
        run_lookup(cfg, args, fx, fixtures)
    else:
        run_views(cfg, args, fx, fixtures)


def emit_yaml_failed(e):
    """--emit-yaml must never write an error row into the app file: say what is wrong on stderr, list the valid icons when one is wrong, exit 1."""
    msg = str(e) if isinstance(e, ConfigError) else ("config.json: %s" % e if isinstance(e, kit.KitError) else "%s while building the app file" % e.__class__.__name__)
    sys.stderr.write("--emit-yaml failed, no app file was written: %s\n" % msg)
    if "icon" in msg:
        sys.stderr.write("Valid icons: %s\n" % ", ".join(sorted(kit.icons_data.ICONS)))
    sys.exit(1)


def main(argv):
    if "--emit-yaml" in argv:
        try:
            run(argv)
        except SystemExit:
            raise
        except Exception as e:
            emit_yaml_failed(e)
        return
    try:
        run(argv)
    except ConfigError as e:
        kit.emit([kit.error_row(str(e), title="This app is not set up correctly")])
    except SystemExit:
        raise
    except kit.KitError as e:   # a config value the row contract refuses: say which
        kit.emit([kit.error_row("config.json: %s" % e, title="This app is not set up correctly")])
    except Exception as e:  # never a stack trace in the launcher
        if os.environ.get("BOLT_APP_DEBUG"):   # bolt-apps run sets this: the real error goes to the terminal
            import traceback
            traceback.print_exc()
        kit.emit([kit.error_row("%s while building the rows. Run the script in a terminal to see why." % e.__class__.__name__)])


if __name__ == "__main__":
    main(sys.argv)
