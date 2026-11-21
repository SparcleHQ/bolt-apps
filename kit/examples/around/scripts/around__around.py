#!/usr/bin/env python3
"""=around <place>: a verdict for a place, stitched from five independent open data sources by distance.

An example of the Bolt Apps kit for stitching disjoint systems on coordinates: a geocoder (Nominatim) gives the point, then
Overpass (places), CityBikes (live docks), Open-Meteo (weather) and Wikipedia (landmarks) are called in parallel and joined by
haversine distance. Limits, TTLs, weights and the auth demo live in config.json. No key is needed; one optional view shows how a
required free key is requested with get_secret (keychain, then ~/.config/around/.env: never a shell variable)."""
import base64
import concurrent.futures as cf
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
FILE_WORDS = tuple(_PFX + w for w in ("config.json", "fixtures.json", "bolt_app_kit.py",))
VIEWS = ("overview", "places", "bikes", "weather", "landmarks", "keys")
DEMOS = ("demo-places-down", "demo-bikes-down", "demo-weather-down", "demo-wiki-down", "demo-secrets")
APP = "around"


def load_json(name):
    with open(os.path.join(HERE, _PFX + name), "r", encoding="utf-8") as f:
        return json.load(f)


def split_args(argv):
    a = list(argv[1:])
    if len(a) >= 3 and [os.path.basename(x) for x in a[-3:]] == list(FILE_WORDS):
        a = a[:-3]
    return [w for w in a if w != "-"]


# ------------------------------------------------------------------ geometry

def haversine(a, b, c, d):
    R, p = 6371000.0, math.radians
    x = math.sin(p(c - a) / 2) ** 2 + math.cos(p(a)) * math.cos(p(c)) * math.sin(p(d - b) / 2) ** 2
    return 2 * R * math.asin(min(1.0, math.sqrt(x)))


def bearing_word(a, b, c, d):
    y = math.sin(math.radians(d - b)) * math.cos(math.radians(c))
    x = math.cos(math.radians(a)) * math.sin(math.radians(c)) - math.sin(math.radians(a)) * math.cos(math.radians(c)) * math.cos(math.radians(d - b))
    deg = (math.degrees(math.atan2(y, x)) + 360) % 360
    return ("north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west")[int((deg + 22.5) // 45) % 8]


def metres(m):
    return "%d m" % (round(m / 10.0) * 10 if m >= 100 else round(m))


# ------------------------------------------------------------------ http with a host allowlist

class Fail(Exception):
    def __init__(self, kind, msg):
        Exception.__init__(self, msg)
        self.kind, self.msg = kind, msg


class _Redirects(urllib.request.HTTPRedirectHandler):
    hosts = ()

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        u = urllib.parse.urlparse(newurl)
        if u.scheme != "https" or u.hostname not in self.hosts:
            raise Fail("fail", "redirected to a host this app does not use")
        return urllib.request.HTTPRedirectHandler.redirect_request(self, req, fp, code, msg, headers, newurl)


def http(cfg, url, form=None, headers=None):
    u = urllib.parse.urlparse(url)
    if u.scheme != "https" or u.hostname not in cfg["hosts"]:
        raise Fail("fail", "host not allowed")
    h = {"User-Agent": cfg["api"]["user_agent"], "Accept": "application/json"}
    h.update(headers or {})
    _Redirects.hosts = tuple(cfg["hosts"])
    body = None if form is None else urllib.parse.urlencode(form).encode()
    req = urllib.request.Request(url, data=body, headers=h)
    try:
        with urllib.request.build_opener(_Redirects).open(req, timeout=cfg["api"]["call_timeout_s"]) as r:
            raw = r.read(cfg["api"]["max_bytes"] + 1)
    except urllib.error.HTTPError as e:
        raise Fail("limited" if e.code == 429 else "fail", "answered %d" % e.code if e.code != 429 else "rate limited")
    except (urllib.error.URLError, OSError, ValueError) as e:
        raise Fail("fail", "timed out" if "timed out" in str(e) else "could not connect")
    if len(raw) > cfg["api"]["max_bytes"]:
        raise Fail("fail", "answer too large")
    try:
        return json.loads(raw.decode("utf-8", "replace"))
    except ValueError:
        raise Fail("fail", "answer was not JSON")


# ------------------------------------------------------------------ the auth matrix: build a request's credentials, show them masked

def build_auth(mode, secret):
    """(headers, query, masked text) for each way a service can ask for a key. The masked text is what may be shown."""
    if mode == "no key" or not secret:
        return {}, {}, "nothing sent"
    if mode == "required free key":
        return {}, {"apikey": secret}, "?apikey=" + "*" * 8
    if mode in ("optional key", "bearer"):
        return {"Authorization": "Bearer " + secret}, {}, "Authorization: Bearer " + "*" * 8
    if mode == "basic":
        tok = base64.b64encode(secret.encode()).decode()
        return {"Authorization": "Basic " + tok}, {}, "Authorization: Basic " + "*" * 8
    raise ValueError(mode)


# ------------------------------------------------------------------ calls

def num(x):
    """A finite number or None. Text, booleans, NaN and infinity are not numbers."""
    return float(x) if isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) else None


def coord(lat, lon):
    la, lo = num(lat), num(lon)
    if la is None or lo is None or not (-90 <= la <= 90 and -180 <= lo <= 180):
        raise ValueError("coordinates out of range")
    return la, lo


def n_geocode(raw):
    r = raw[0]
    try:
        la, lo = coord(float(r["lat"]), float(r["lon"]))   # the geocoder sends them as text
    except (TypeError, ValueError):
        raise ValueError("coordinates out of range")
    return {"lat": la, "lon": lo, "name": r.get("name") or r["display_name"].split(",")[0], "full": r["display_name"]}


def check_overpass(raw):
    """A busy Overpass server answers HTTP 200 with a remark that names an error and no or partial elements. That is a failure, not 'none found'."""
    remark = raw.get("remark") if isinstance(raw, dict) else None
    if isinstance(remark, str) and re.search(r"error|timed out|out of memory", remark, re.I):
        raise Fail("fail", "Overpass reported a problem: " + kit.clean_text(remark, 60))


def n_places(raw, cfg, lat, lon):
    check_overpass(raw)
    out = []
    els = raw.get("elements")
    if not isinstance(els, list):
        raise ValueError("no elements")
    for e in els:
        if not isinstance(e, dict):
            continue
        t = e.get("tags") if isinstance(e.get("tags"), dict) else {}
        la, lo = e.get("lat"), e.get("lon")
        if la is None and isinstance(e.get("center"), dict):
            la, lo = e["center"].get("lat"), e["center"].get("lon")
        if num(la) is None or num(lo) is None or not isinstance(t.get("name"), str) or not t.get("name"):
            continue
        cat = next((c["id"] for c in cfg["categories"] if ("amenity" in t and c["id"] == "cafe" and t["amenity"] == "cafe") or ("leisure" in t and c["id"] == "gym" and t["leisure"] == "fitness_centre")), None)
        if cat:
            out.append({"cat": cat, "name": t["name"], "brand": t.get("brand") if isinstance(t.get("brand"), str) else "", "hours": t.get("opening_hours") if isinstance(t.get("opening_hours"), str) else "",
                        "lat": float(la), "lon": float(lo), "dist": haversine(lat, lon, float(la), float(lo))})
    # Overpass cuts a long answer by element id, not by distance: when the cap is hit the nearest places may be missing, and the app says so
    return {"items": sorted(out, key=lambda p: p["dist"]), "limited": len(els) >= cfg["places_limit"]}


def n_bikes(raw, cfg, lat, lon):
    st = []
    for s in raw["network"]["stations"]:
        la, lo, fb = num(s.get("latitude")), num(s.get("longitude")), num(s.get("free_bikes"))
        if la is None or lo is None or fb is None:
            continue
        d = haversine(lat, lon, la, lo)
        if d <= cfg["bike_max_m"]:
            es = num(s.get("empty_slots"))
            st.append({"name": str(s.get("name") or "dock"), "lat": la, "lon": lo, "bikes": int(fb), "free": None if es is None else int(es), "dist": d, "at": parse_ts(s.get("timestamp"))})
    return {"network": str(raw["network"].get("name") or "bikes"), "stations": sorted(st, key=lambda s: s["dist"])}


def parse_ts(s):
    try:
        import calendar
        return calendar.timegm(time.strptime(str(s)[:19], "%Y-%m-%dT%H:%M:%S"))
    except (TypeError, ValueError):
        return None


def n_weather(raw):
    c, h = raw["current"], raw["hourly"]
    off = int(num(raw.get("utc_offset_seconds")) or 0)
    temp = num(c["temperature_2m"])
    if temp is None:
        raise ValueError("no current temperature")
    hours = []
    for t, tp, pr in zip(h["time"], h["temperature_2m"], h["precipitation_probability"]):
        if isinstance(t, str) and num(tp) is not None:   # a null in the arrays drops that hour, it does not stop the answer
            hours.append((t[11:16], num(tp), num(pr)))
    return {"temp": temp, "feels": num(c.get("apparent_temperature")), "wind": num(c.get("wind_speed_10m")), "code": c.get("weather_code"), "off": off,
            "now": str(c["time"])[11:16], "hours": hours, "time": c["time"]}


def n_wiki(raw, lat, lon):
    out = []
    for g in raw["query"]["geosearch"]:
        la, lo, d = num(g.get("lat")), num(g.get("lon")), num(g.get("dist"))
        if la is not None and lo is not None and d is not None and isinstance(g.get("pageid"), int) and isinstance(g.get("title"), str):
            out.append({"title": g["title"], "dist": d, "lat": la, "lon": lo, "page": g["pageid"]})
    return out


def nearest_network(cfg, lat, lon):
    best = min(cfg["bike_networks"], key=lambda n: haversine(lat, lon, n["lat"], n["lon"]))
    return best["id"] if haversine(lat, lon, best["lat"], best["lon"]) <= cfg["bike_network_max_km"] * 1000 else None


_GATE_LOCK = threading.Lock()   # in-process: Windows file locks are per process, so threads share one lock too


class geocode_gate(object):
    """Nominatim allows one request a second. This lock holds across threads and across processes (a file lock), and the
    next caller waits until `gap` seconds after the last one finished. POSIX uses fcntl.flock; Windows uses msvcrt.locking."""
    _tl = _GATE_LOCK

    def __init__(self, root, gap):
        self.root, self.gap, self.fd = root, gap, None
        self._winlock = False

    def __enter__(self):
        geocode_gate._tl.acquire()
        try:
            os.makedirs(self.root, 0o700, exist_ok=True)
            self.fd = os.open(os.path.join(self.root, "gate"), os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
            try:
                import fcntl
                fcntl.flock(self.fd, fcntl.LOCK_EX)
            except ImportError:
                try:
                    import msvcrt
                    os.lseek(self.fd, 0, os.SEEK_SET)
                    msvcrt.locking(self.fd, msvcrt.LK_LOCK, 1)
                    self._winlock = True
                except ImportError:
                    pass
            try:
                if hasattr(os, "pread"):
                    raw = os.pread(self.fd, 64, 0)
                else:
                    os.lseek(self.fd, 0, os.SEEK_SET)
                    raw = os.read(self.fd, 64)
                last = float(raw.decode() or 0)
            except (ValueError, OSError):
                last = 0.0
            wait = self.gap - (time.time() - last)
            if wait > 0:
                time.sleep(min(wait, self.gap * 2))
        except BaseException:
            self._release()
            raise
        return self

    def _release(self):
        if self.fd is not None:
            if self._winlock:
                try:
                    import msvcrt
                    os.lseek(self.fd, 0, os.SEEK_SET)
                    msvcrt.locking(self.fd, msvcrt.LK_UNLCK, 1)
                except OSError:
                    pass
                self._winlock = False
            try:
                os.close(self.fd)   # closing drops a POSIX file lock
            except OSError:
                pass
            self.fd = None
        geocode_gate._tl.release()

    def __exit__(self, *exc):
        try:
            if self.fd is not None:
                stamp = ("%.3f" % time.time()).encode()
                if hasattr(os, "pwrite"):
                    os.ftruncate(self.fd, 0)
                    os.pwrite(self.fd, stamp, 0)
                else:
                    os.lseek(self.fd, 0, os.SEEK_SET)
                    os.write(self.fd, stamp)
                    os.ftruncate(self.fd, len(stamp))
        except (OSError, AttributeError):
            pass
        self._release()


class Ctx(object):
    def __init__(self, cfg, fx, fixture, now, force, demos, place_key):
        self.cfg, self.fx, self.fixture, self.now, self.force, self.demos, self.place_key = cfg, fx, fixture, now, force, demos, place_key
        root = kit.cache.default_root(APP)
        self.fresh, self.stale = {}, {}
        for s, d in cfg["sources"].items():
            self.fresh[s] = kit.Cache(APP, d["ttl"], shape=lambda v: isinstance(v, dict), root=root + "/fresh-" + s)
            self.stale[s] = kit.Cache(APP, cfg["stale_max_s"], shape=lambda v: isinstance(v, dict), root=root + "/stale-" + s)
        self.gate_root = root + "/gate"


def call(ctx, source, key, fetch_raw, norm):
    """One source: fresh cache, then the network, then an old copy. Returns the same record shape for every source."""
    res = {"ok": False, "data": None, "ms": None, "cached": False, "age": 0, "stale": False, "err": "", "kind": "fail"}
    demo = {"places": "demo-places-down", "bikes": "demo-bikes-down", "weather": "demo-weather-down", "wiki": "demo-wiki-down"}.get(source)
    ck = "%s|%s" % (source, key)
    if demo in ctx.demos:
        return fall(ctx, source, ck, res, "could not connect (demo)")
    if not ctx.force and not ctx.fixture:
        hit = ctx.fresh[source].get(ck)
        if hit is not None:
            res.update(ok=True, data=hit["d"], cached=True, age=ctx.fresh[source].age(ck) or 0, kind="ok")
            return res
    t0 = time.time()
    try:
        data = norm(fetch_raw())
    except Fail as e:
        return fall(ctx, source, ck, res, e.msg)
    except Exception:   # an odd answer (a null, a huge number, deep nesting) is unread, never a traceback
        return fall(ctx, source, ck, res, "unexpected answer")
    res.update(ok=True, data=data, ms=int((time.time() - t0) * 1000), kind="ok")
    if not ctx.fixture:
        ctx.fresh[source].put(ck, {"d": data})
        ctx.stale[source].put(ck, {"d": data})
    return res


def fall(ctx, source, ck, res, why):
    old = None if ctx.fixture else ctx.stale[source].get(ck)
    if old is not None:
        res.update(ok=True, data=old["d"], stale=True, age=ctx.stale[source].age(ck) or 0, err=why, kind="ok")
    else:
        res.update(err=why, kind="fail")
    return res


def geocode(ctx, text):
    cfg = ctx.cfg
    key = text.lower()

    def raw():
        if ctx.fixture:
            fx = ctx.fx["places"].get(key)
            if not fx:
                raise Fail("none", "not in the recorded sample")
            return fx["geocode"]
        with geocode_gate(ctx.gate_root, cfg["api"]["geocode_min_gap_s"]):   # Nominatim policy: one request a second
            d = http(cfg, "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode({"q": text, "format": "jsonv2", "limit": 1}))
        if not d:
            raise Fail("none", "no such place")
        return d
    return call(ctx, "geocode", key, raw, n_geocode)


def gather(ctx, g):
    cfg, lat, lon = ctx.cfg, g["lat"], g["lon"]
    fx = ctx.fx.get("places", {}).get(ctx.place_key, {}) if ctx.fixture else {}
    net = nearest_network(cfg, lat, lon)
    rad = cfg["radius_m"]

    def places_raw():
        if ctx.fixture:
            return fx["places"]
        flt = "".join('nwr%s(around:%d,%s,%s);' % (c["filter"], rad, lat, lon) for c in cfg["categories"])
        return http(cfg, "https://overpass-api.de/api/interpreter", form={"data": "[out:json][timeout:8];(%s);out center tags %d;" % (flt, cfg["places_limit"])})

    def bikes_raw():
        if net is None:
            raise Fail("none", "no bike share network near here")
        if ctx.fixture:
            return fx["bikes"]
        return http(cfg, "https://api.citybik.es/v2/networks/" + net)

    def weather_raw():
        if ctx.fixture:
            return fx["weather"]
        return http(cfg, "https://api.open-meteo.com/v1/forecast?" + urllib.parse.urlencode({"latitude": lat, "longitude": lon, "current": "temperature_2m,apparent_temperature,wind_speed_10m,weather_code",
                    "hourly": "temperature_2m,precipitation_probability", "timezone": "auto", "forecast_days": 2}))

    def wiki_raw():
        if ctx.fixture:
            return fx["wiki"]
        return http(cfg, "https://en.wikipedia.org/w/api.php?" + urllib.parse.urlencode({"action": "query", "list": "geosearch", "gscoord": "%s|%s" % (lat, lon), "gsradius": 1000, "gslimit": 8, "format": "json", "formatversion": 2}))

    pk = "%.4f,%.4f" % (lat, lon)
    ex = cf.ThreadPoolExecutor(max_workers=cfg["api"]["workers"])
    t0 = time.time()
    fut = {
        "places": ex.submit(call, ctx, "places", pk, places_raw, lambda r: n_places(r, cfg, lat, lon)),
        "bikes": ex.submit(call, ctx, "bikes", pk, bikes_raw, lambda r: n_bikes(r, cfg, lat, lon)),
        "weather": ex.submit(call, ctx, "weather", pk, weather_raw, n_weather),
        "wiki": ex.submit(call, ctx, "wiki", pk, wiki_raw, lambda r: n_wiki(r, lat, lon)),
    }
    out = {}
    for k, f in fut.items():
        left = max(0.1, cfg["api"]["deadline_s"] - (time.time() - t0))
        try:
            out[k] = f.result(timeout=left)
        except Exception:
            out[k] = {"ok": False, "data": None, "ms": None, "cached": False, "age": 0, "stale": False, "err": "timed out", "kind": "fail"}
    ex.shutdown(wait=False)
    out["_wall"] = int((time.time() - t0) * 1000)
    out["_net"] = net
    return out


# ------------------------------------------------------------------ stitching and the verdict

def stitch(ctx, g, r):
    cfg = ctx.cfg
    docks = r["bikes"]["data"]["stations"] if r["bikes"]["ok"] else None
    wx = r["weather"]["data"] if r["weather"]["ok"] else None
    rows = []
    for p in r["places"]["data"]["items"] if r["places"]["ok"] else []:
        dock = None
        if docks:
            dock = min(docks, key=lambda d: haversine(p["lat"], p["lon"], d["lat"], d["lon"]))
            dock = dict(dock, gap=haversine(p["lat"], p["lon"], dock["lat"], dock["lon"]))
        rows.append(dict(p, dock=dock, bearing=bearing_word(g["lat"], g["lon"], p["lat"], p["lon"])))
    return rows, docks, wx


def rain_start(wx):
    for t, temp, pr in wx["hours"]:
        if t >= wx["now"][:2] + ":00" and pr is not None and pr >= 50:
            return t
    return None


def window(wx, n=12):
    i = next((k for k, (t, _, _) in enumerate(wx["hours"]) if t[:2] == wx["now"][:2]), 0)
    return wx["hours"][i:i + n]


def verdict(ctx, g, r, places, docks, wx, wiki):
    sc = ctx.cfg["score"]
    comp, facts = {}, []
    if wx:
        lo, hi = sc["comfort_c"]
        t = wx["temp"]
        tcomf = 100.0 if lo <= t <= hi else max(0.0, 100.0 - sc["off_comfort_penalty_per_c"] * (lo - t if t < lo else t - hi))
        rain = max((pr or 0) for _, _, pr in window(wx, 6)) if window(wx, 6) else 0
        comp["weather"] = tcomf * (0.5 if rain >= sc["rain_pct_watch"] else 1.0)
        facts.append("%d C" % round(t))
        rs = rain_start(wx)
        facts.append(("rain from %s" % rs) if rs else "dry for the next hours")
    if places is not None:
        cafes = [p for p in places if p["cat"] == "cafe" and p["dist"] <= ctx.cfg["near_m"]]
        comp["cafes"] = min(100.0, 100.0 * len(cafes) / sc["cafes_full"])
        facts.append("%d %s within %d m" % (len(cafes), "cafe" if len(cafes) == 1 else "cafes", ctx.cfg["near_m"]))
    if docks is not None:
        comp["bikes"] = min(100.0, 100.0 * (docks[0]["bikes"] if docks else 0) / sc["bikes_full"])
    if wiki is not None:
        comp["landmarks"] = min(100.0, 100.0 * len(wiki) / sc["landmarks_full"])
    w = sc["weights"]
    tot = sum(w[k] for k in comp)
    total = int(round(sum(comp[k] * w[k] for k in comp) / tot)) if tot else None
    v = next(x for x in sc["verdicts"] if total >= x["min"]) if total is not None else None
    return {"total": total, "verdict": v, "parts": dict((k, int(round(x))) for k, x in comp.items()), "facts": facts, "missing": [k for k in w if k not in comp]}


# ------------------------------------------------------------------ rows

def osm_url(lat, lon, z=17):
    return "https://www.openstreetmap.org/?mlat=%s&mlon=%s#map=%d/%s/%s" % (lat, lon, z, lat, lon)


def badge_row(ctx, r):
    cfg = ctx.cfg
    bs, bits = [], []
    for s in ("places", "bikes", "weather", "wiki"):
        x = r[s]
        lab = cfg["sources"][s]["label"]
        if not x["ok"]:
            tone, txt = ("warn", "none nearby") if x["err"] in ("no bike share network near here",) else ("bad", "down")
        elif x["stale"]:
            tone, txt = "warn", "old copy"
        elif ctx.fixture:
            tone, txt = "ok", "sample"
        elif x["cached"]:
            tone, txt = "ok", "cached"
        else:
            tone, txt = "ok", "%d ms" % (x["ms"] or 0)
        bs.append(("%s %s" % (lab, txt), tone))
        bits.append("%s %s" % (lab, txt))
    return kit.safe_row("Sources", " · ".join(bits), icon="Globe", badges=bs, copy=False)


def overview(ctx, g, r, text):
    rows = []
    prow, docks, wx = stitch(ctx, g, r)
    plist = prow if r["places"]["ok"] else None
    wiki = r["wiki"]["data"] if r["wiki"]["ok"] else None
    v = verdict(ctx, g, r, plist, docks, wx, wiki)
    if ctx.fixture:
        rows.append(kit.safe_row("Sample data", "This is sample data. Real answers recorded 2026-11-15, no network.", icon="FileText", copy=False, badge="SAMPLE"))
    if v["total"] is None:
        rows.append(kit.safe_row("Verdict: not enough data", "No source answered", icon="AlertCircle", badge="NO DATA", copy=False))
    else:
        sub = ", ".join(v["facts"]) + ((" · not scored: " + ", ".join(v["missing"])) if v["missing"] else "")
        rows.append(kit.safe_row("Verdict · %s" % v["verdict"]["label"], sub, icon="CheckCircle2" if v["total"] >= 75 else "AlertCircle", badge=v["verdict"]["badge"] if not v["missing"] else "PARTIAL",
                            tile=kit.tile("Walk and coffee score", v["total"], "/100", 100, note=" · ".join("%s %d" % (k.capitalize(), x) for k, x in v["parts"].items())[:80]),
                            open_url=osm_url(g["lat"], g["lon"], 16), copy="%s: %s" % (g["name"], v["verdict"]["label"])))
    rows.append(badge_row(ctx, r))
    for c in ctx.cfg["categories"]:
        if plist is None:
            rows.append(kit.safe_row("%s · unavailable" % c["label"], "Overpass: " + r["places"]["err"], icon="AlertCircle", nav={"view": "places"}, copy=False))
            break
    if plist is not None and r["places"]["data"]["limited"]:
        rows.append(kit.safe_row("Places limited to the first %d results" % ctx.cfg["places_limit"], "Overpass cuts a long answer by id, not by distance, so the nearest places may be missing", icon="AlertCircle", badge="LIMITED", copy=False))
    if plist is not None:
        for c in ctx.cfg["categories"]:
            L = [p for p in plist if p["cat"] == c["id"]]
            rows.append(kit.safe_row("%s · %d within %d m" % (c["label"], len(L), ctx.cfg["radius_m"]), ("nearest: %s, %s" % (L[0]["name"], metres(L[0]["dist"]))) if L else "none found", icon=c["icon"], nav={"view": "places"}, copy=False))
    if r["bikes"]["ok"] and docks:
        d = docks[0]
        age = max(0, int(ctx.now - d["at"])) if d["at"] else None
        rows.append(kit.safe_row("Bike docks · %d bikes at the nearest" % d["bikes"], "%s, %s%s" % (d["name"], metres(d["dist"]), (" · updated %d s ago" % age) if age is not None else ""), icon="Navigation", nav={"view": "bikes"}, copy=False,
                            badge="LIVE" if age is not None and age <= 120 else "", tile=kit.tile("Bikes at nearest dock", d["bikes"], "", None, note=("updated %d s ago" % age) if age is not None else "")))
    else:
        rows.append(kit.safe_row("Bike docks · %s" % ("none nearby" if r["bikes"]["err"] == "no bike share network near here" or (r["bikes"]["ok"] and not docks) else "unavailable"), r["bikes"]["err"] or "no dock within %d m" % ctx.cfg["bike_max_m"], icon="Navigation", nav={"view": "bikes"}, copy=False))
    if wx:
        rs = rain_start(wx)
        rows.append(kit.safe_row("Weather · %d C, %s" % (round(wx["temp"]), ("rain from %s" % rs) if rs else "dry"), "feels like %s C, wind %s km/h" % (round(wx["feels"]) if wx["feels"] is not None else "?", round(wx["wind"]) if wx["wind"] is not None else "?"),
                            icon="CloudSun", nav={"view": "weather"}, copy=False, trend=[x[1] for x in window(wx)] or None, tile=kit.tile("Temperature", wx["temp"], "C", None, note="next 12 hours below")))
    else:
        rows.append(kit.safe_row("Weather · unavailable", r["weather"]["err"], icon="AlertCircle", nav={"view": "weather"}, copy=False))
    if wiki is not None:
        rows.append(kit.safe_row("Landmarks · %d nearby" % len(wiki), ("nearest: %s, %s" % (wiki[0]["title"], metres(wiki[0]["dist"]))) if wiki else "none within 1 km", icon="Landmark", nav={"view": "landmarks"}, copy=False))
    else:
        rows.append(kit.safe_row("Landmarks · unavailable", r["wiki"]["err"], icon="AlertCircle", nav={"view": "landmarks"}, copy=False))
    rows.append(kit.safe_row("Keys and sign-in styles", "how each API here asks for a key, and the one that needs yours", icon="Key", nav={"view": "keys"}, copy=False))   # no pane: the overview preview draws this row; the keys detail pane binds fields it lacks
    rows.append(kit.safe_row("About the data", "Map data (c) OpenStreetMap contributors, ODbL. Weather by Open-Meteo.com (CC BY 4.0). Landmarks from Wikipedia (CC BY-SA). Bikes by CityBikes (https://citybik.es)", icon="FileText", copy=False))
    rows.append(kit.refresh_row("overview", title="Check again", subtitle="Enter to fetch fresh data (bikes are kept 30 s)"))
    return rows


def back(note=True):
    """The detail panes (places, landmarks, keys) bind fields a Back row lacks and Back is selected first, so it draws the note view; the bikes table and weather chart plot every row and need none."""
    return kit.back_row("Back to the overview", view=kit.NOTE_VIEW if note else None)


def old_row(r, s, note=True):
    x = r[s]
    if not x["stale"]:
        return []
    why = "the source failed (%s); copy is %s old" % (x["err"], kit.fmt_duration(x["age"]))
    return [kit.note_row("Showing an old copy", why, icon="Clock", badge="OLD COPY") if note else kit.safe_row("Showing an old copy", why, icon="Clock", badge="OLD COPY", copy=False)]


def view_rows(ctx, view, g, r, text):
    prow, docks, wx = stitch(ctx, g, r)
    now = ctx.now
    if view == "places":
        if not r["places"]["ok"]:
            return [back(), kit.note_row("Places unavailable", "Overpass: " + r["places"]["err"], icon="AlertCircle")]
        out = [back()] + old_row(r, "places")
        if r["places"]["data"]["limited"]:
            out.append(kit.note_row("Limited to the first %d results" % ctx.cfg["places_limit"], "the nearest places may be missing: Overpass cuts by id, not distance", icon="AlertCircle", badge="LIMITED"))
        for p in prow[:40]:
            c = next(c for c in ctx.cfg["categories"] if c["id"] == p["cat"])
            d = p["dock"]
            dock = ("%s: %d bikes, %s free, %s away" % (d["name"], d["bikes"], "?" if d["free"] is None else d["free"], metres(d["gap"]))) if d else "no dock data"
            wxs = ("%d C, %s" % (round(wx["temp"]), ("rain from %s" % rain_start(wx)) if rain_start(wx) else "dry")) if wx else "no weather data"
            out.append(kit.safe_row(p["name"], "%s · %s %s · %s" % (c["label"][:-1].lower(), metres(p["dist"]), p["bearing"], ("open " + p["hours"]) if p["hours"] else "hours not listed"), icon=c["icon"],
                               open_url=osm_url(p["lat"], p["lon"]), copy="%s, %s" % (p["name"], g["name"]), pname=p["name"], dist="%s, %d min walk" % (metres(p["dist"]), max(1, round(p["dist"] / ctx.cfg["walk_m_per_min"]))),
                               hours=p["hours"] or "not listed", dock=dock, wx=wxs, chain=p["brand"] or "independent", src="OpenStreetMap contributors (ODbL)"))
        return out if len(out) > 1 else out + [kit.note_row("Nothing found", "no cafe or gym within %d m" % ctx.cfg["radius_m"], icon="MapPin")]
    if view == "bikes":
        if not r["bikes"]["ok"] or not docks:
            return [back(False), kit.safe_row("No bike docks", r["bikes"]["err"] or "none within %d m" % ctx.cfg["bike_max_m"], icon="Navigation", copy=False)]
        net = r["bikes"]["data"]["network"]
        return old_row(r, "bikes", False) + [kit.safe_row(d["name"], "%d bikes · %s free · %s%s" % (d["bikes"], "?" if d["free"] is None else d["free"], metres(d["dist"]), (" · updated %d s ago" % max(0, int(now - d["at"]))) if d["at"] else ""), icon="Navigation",
                                              open_url=osm_url(d["lat"], d["lon"]), dock=d["name"], bikes=d["bikes"], free=d["free"], dist=metres(d["dist"]), copy="%s, %s" % (d["name"], net)) for d in docks[:12]]
    if view == "weather":
        if not wx:
            return [back(False), kit.safe_row("Weather unavailable", r["weather"]["err"], icon="AlertCircle", copy=False)]
        return old_row(r, "weather", False) + [kit.safe_row("%s" % t, "%s C · rain chance %s%%" % (temp, pr if pr is not None else "?"), icon="CloudSun", label=t, value=temp, copy=False) for t, temp, pr in window(wx)]
    if view == "landmarks":
        if not r["wiki"]["ok"]:
            return [back(), kit.note_row("Landmarks unavailable", r["wiki"]["err"], icon="AlertCircle")]
        out = [back()] + old_row(r, "wiki")
        for w in r["wiki"]["data"]:
            out.append(kit.safe_row(w["title"], "%s %s" % (metres(w["dist"]), bearing_word(g["lat"], g["lon"], w["lat"], w["lon"])), icon="Landmark", open_url="https://en.wikipedia.org/?curid=%d" % w["page"],
                               pname=w["title"], dist=metres(w["dist"]), src="Wikipedia (CC BY-SA)", copy=w["title"]))
        return out if len(out) > 1 else out + [kit.note_row("No articles nearby", "none within 1 km", icon="Landmark")]
    return []


def keys_rows(ctx, g):
    cfg = ctx.cfg
    out = [back()]
    demo = "demo-secrets" in ctx.demos
    for a in cfg["auth_demo"]:
        name = a["secret"]
        sec = None
        if name:
            if demo:
                sec = "sample-secret-value" if name != "AROUND_BASIC_LOGIN" else "sample-user:sample-password"
            else:
                s = kit.get_secret(APP, name)
                sec = s.value if s else None
        hdr, qry, masked = build_auth(a["mode"], sec)
        if a["mode"] == "required free key" and not sec:
            out.append(kit.safe_row("Add your free NASA key to see the picture of the day", "%s needs a free key. Enter for the setup line" % a["service"], icon="Key", badge="SETUP", copy=kit.setup_hint(APP, name),
                               mode=a["mode"], how=a["send"], where="keychain or ~/.config/%s/.env" % APP, state="key missing", sample="sign up: " + cfg["keys"]["apod"]["signup"]))
            continue
        state = "no key needed" if not name else ("key found" if sec else ("not set (optional)" if a.get("optional") else "not set"))
        shown = masked if sec or not name else build_auth(a["mode"], "x")[2]
        out.append(kit.safe_row("%s · %s" % (a["mode"], state), "%s · %s: %s" % (a["service"][:50], "sends" if sec or not name else "would send", shown), icon="Key", copy=False, mode=a["mode"], how=a["send"], where="keychain or ~/.config/%s/.env" % APP if name else "none", state=state, sample=shown))
    out.append(kit.safe_row("Where keys live", "keychain first, then ~/.config/" + APP + "/.env (mode 0600). A shell variable never reaches the script under Bolt", icon="Shield", copy=False,
                       mode="storage", how="get_secret", where="keychain, .env", state="read when needed", sample="never in files, fixtures, cache or rows"))
    return out


OVERVIEW_PANE = ["    overview:", "      right_widget:", "        kind: entity_preview", "        mode: selected_row", "        bind:", '          title: "{{row.title}}"', '          subtitle: "{{row.subtitle}}"',
                 "          tiles_above:", '            title: "{{row.kpi_label}}"', '            value: "{{row.kpi_value}}"', '            unit: "{{row.kpi_unit}}"', '            max: "{{row.kpi_max}}"', '            trend: "{{row.trend}}"',
                 '            subtitle: "{{row.kpi_note}}"', '            badge: "{{row.kpi_badge}}"', '          body: "{{row.body}}"']   # the overview is a list of rows that drill into views: each row is drawn by this preview, and the views keep their own widgets


NOTE_PANE = ["    note:", "      right_widget:", "        kind: markdown", "        mode: selected_row", "        bind:", '          title: "{{row.title}}"', '          subtitle: "{{row.subtitle}}"', '          body: "{{row.body}}"']   # the pane of the Back, notice and hint rows: they carry none of the detail fields, so they draw their own words (kit.NOTE_VIEW)


def emit_yaml(cfg):
    app = cfg["app"]
    words = " ".join("{{scripts_dir}}/%s" % f for f in FILE_WORDS)
    cmd = "%s {{scripts_dir}}/" + _SELF + " {{view}} {{p1}} {{p2}} {{p3}} {{p4}} " + words
    ch = cfg["charts"]["weather"]
    L = ["# Generated by: python3 scripts/" + _SELF + " --emit-yaml (edit config.json, not this file)", "schema_version: 1", "runtime: bridge", "id: %s" % app["id"], "chip: %s" % app["chip"],
         "title: %s" % json.dumps(app["title"]), "icon: %s" % app["icon"], "description: %s" % json.dumps(app["description"]),
         'placeholder_examples: ["Bryant Park, New York", "Enter for the last place"]', "emits: Generic", "args:", '  - { name: view, from: "query.word(0)", default: overview }']
    for i in range(1, 5):
        L.append('  - { name: p%d, from: "query.word(%d)", default: "-" }' % (i, i))
    L += ["bridge:", "  command:"]
    for osn, py in (("macos", "python3"), ("linux", "python3"), ("windows", "python")):
        L.append('    %s: "%s"' % (osn, cmd % py))
    L += ["  parse: json", "  timeout_seconds: %d" % app["timeout"], "presentation:", "  widget: list", "  title_field: title", "  subtitle_field: subtitle", "  view_arg: view", "  right_widget:", *[l[4:] for l in OVERVIEW_PANE[2:]], "  views:", *OVERVIEW_PANE]
    L += ["    places:", "      right_widget:", "        kind: detail", "        mode: selected_row", "        bind:", '          title: "{{row.pname}}"', '          subtitle: "{{row.chain}}"', "          fields:",
          '            - { label: Distance, value: "{{row.dist}}" }', '            - { label: Hours, value: "{{row.hours}}" }', '            - { label: Nearest dock, value: "{{row.dock}}" }',
          '            - { label: Weather there, value: "{{row.wx}}" }', '            - { label: Source, value: "{{row.src}}" }']
    L += ["    bikes:", "      right_widget:", "        kind: table", "        mode: list_data", "        bind:", "          columns:", "            - { field: dock, label: Dock }",
          "            - { field: bikes, label: Bikes, align: right, total: sum }", "            - { field: free, label: Free, align: right, total: sum }", "            - { field: dist, label: Distance, align: right }"]
    L += ["    weather:", "      right_widget:", "        kind: chart", "        mode: list_data", "        bind:", '          type: "%s"' % ch["type"], '          x: "label"', '          y: "value"', "          label: %s" % json.dumps(ch["title"])]
    L += ["    landmarks:", "      right_widget:", "        kind: detail", "        mode: selected_row", "        bind:", '          title: "{{row.pname}}"', "          fields:",
          '            - { label: Distance, value: "{{row.dist}}" }', '            - { label: Source, value: "{{row.src}}" }']
    L += ["    keys:", "      right_widget:", "        kind: detail", "        mode: selected_row", "        bind:", '          title: "{{row.mode}}"', "          fields:",
          '            - { label: State, value: "{{row.state}}" }', '            - { label: Sent as, value: "{{row.sample}}" }', '            - { label: Sent in, value: "{{row.how}}" }', '            - { label: Read from, value: "{{row.where}}" }']
    L += NOTE_PANE
    L += ["actions:", '  - { id: open, kind: url, target: row, label: Open in Maps, url_template: "{{row.open_url}}" }', '  - { id: copy, kind: composer, target: row, label: Copy address, insert: "{{row.copy_text}}" }']
    return "\n".join(L) + "\n"


def main(argv):
    global APP
    cfg = load_json("config.json")
    APP = cfg["app"]["id"]   # a copy with a new id gets its own caches and its own key names
    if "--emit-yaml" in argv:
        sys.stdout.write(emit_yaml(cfg))
        return
    args = split_args(argv)
    view = "overview"
    if args and args[0] in VIEWS:
        view, args = args[0], args[1:]
    demos = [a for a in args if a in DEMOS]
    force = "refresh" in args
    args = [a for a in args if a not in DEMOS and a != "refresh"]
    fixture = bool(cfg["api"]["fixture_default"]) if os.environ.get("BOLT_APP_FIXTURE") not in ("0", "1") else os.environ["BOLT_APP_FIXTURE"] == "1"
    lastc = kit.Cache(APP, 86400, shape=lambda v: isinstance(v, dict) and isinstance(v.get("text"), str), root=kit.cache.default_root(APP) + "/last")
    text = kit.clean_text(" ".join(args), 120)
    if not text:
        last = lastc.get("last")
        if view == "keys":
            text = last["text"] if last else "Bryant Park, New York"
        elif not last:
            kit.emit([kit.safe_row("Type a place", "for example: =around Bryant Park, New York", icon="MapPin", copy=False)])
        else:
            text = last["text"]
    if len(text) < 2:
        kit.emit([kit.error_row("Type at least two characters of a place name", title="Not run")])
    fx = load_json("fixtures.json") if fixture else {}
    ctx = Ctx(cfg, fx, fixture, fx.get("_now") if fixture else time.time(), force, demos, text.lower())
    gr = geocode(ctx, text)
    if not gr["ok"]:
        if fixture and gr["err"] == "not in the recorded sample":
            kit.emit([kit.note_row("Not in the recorded sample", "This is sample data, which covers only: %s" % ", ".join(sorted(fx["places"])))])
        kit.emit([kit.note_row("Could not find that place", "The place finder said: %s" % gr["err"])])
    g = gr["data"]
    lastc.put("last", {"text": text})
    if view == "keys":
        kit.emit(keys_rows(ctx, g))
    r = gather(ctx, g)
    kit.emit(overview(ctx, g, r, text) if view == "overview" else (view_rows(ctx, view, g, r, text) or [back()]))


def run(argv):
    try:
        main(argv)
    except SystemExit:
        raise
    except kit.KitError as e:   # a row the contract refuses is the author's bug: say what it is
        kit.emit([kit.error_row("Row contract: %s" % kit.clean_text(str(e), 200), title="This app could not run")])
    except Exception as e:   # one plain row: never a traceback, and the message is not shown (it could carry a key)
        if os.environ.get("BOLT_APP_DEBUG"):   # bolt-apps run sets this: the real error goes to the terminal
            import traceback
            traceback.print_exc()
        kit.emit([kit.error_row("%s while building the rows. Run the script in a terminal to see why." % e.__class__.__name__)])


if __name__ == "__main__":
    run(sys.argv)
