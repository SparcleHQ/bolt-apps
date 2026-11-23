#!/usr/bin/env python3
"""=obs [view] [word]: one view over the monitoring tools a team runs. Each source (Prometheus, Coroot; Datadog, Grafana, Dynatrace next) is read by a small adapter into the same
model: services (name, status) and alerts (name, service, severity, since). Services are joined across sources by name, so one row says what every tool thinks of "checkout".
Views: overview (tiles), services (joined, worst first), alerts (firing, worst first), sources (health table).
Sources and keys: ~/.config/obs/sources.json lists them (no secrets in it); each key sits in the keychain or in ~/.config/obs/.env (mode 600). With no file it shows two public demos.
Sample mode (BOLT_APP_FIXTURE=1) reads answers recorded from those demos."""
import base64
import ipaddress
import os
import sys

sys.dont_write_bytecode = True
_SELF = os.path.basename(__file__)
_PFX = _SELF.partition("__")[0] + "__" if "__" in _SELF else ""
import importlib.util as _ilu
_spec = _ilu.spec_from_file_location("bolt_app_kit", os.path.join(os.path.dirname(os.path.abspath(__file__)), _PFX + "bolt_app_kit.py"))
kit = sys.modules.get("bolt_app_kit")
if kit is None and os.path.exists(_spec.origin):
    kit = _ilu.module_from_spec(_spec)
    sys.modules["bolt_app_kit"] = kit
    _spec.loader.exec_module(kit)
elif kit is None:
    raise SystemExit("script files must be named <app id>__<name>: this one is %s and %s was not found beside it." % (_SELF, _PFX + "bolt_app_kit.py"))

import concurrent.futures as cf
import http.client
import json
import re
import shutil
import stat
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
FILE_WORDS = tuple(_PFX + w for w in ("config.json", "fixtures.json", "bolt_app_kit.py",))
VIEWS = ("overview", "services", "alerts", "sources", "trend", "chart", "table")   # at most 8 views in an app file; the service drill lives inside services (arg key.<name>)
APP = "obs"
NAME = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}\Z")
HOST = re.compile(r"^[A-Za-z0-9.-]{1,253}\Z")
SECRET_NAME = re.compile(r"^[A-Z][A-Z0-9_]{2,63}\Z")
RANK = {"ok": 0, "unknown": 0, "warn": 1, "crit": 2}
TOKEN = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}\Z")   # what a nav arg may be
SAFE_NAME = re.compile(r"^[A-Za-z0-9_.:-]{1,64}\Z")   # a service name allowed into a PromQL label or a link
LINK_KINDS = ("open", "logs", "traces")
TONE = {"ok": "success", "warn": "warn", "crit": "danger", "unknown": ""}
WORD = {"ok": "OK", "warn": "WARN", "crit": "CRIT", "unknown": "?"}


def load_json(name):
    with open(os.path.join(HERE, _PFX + name), "r", encoding="utf-8") as f:
        return json.load(f)


def split_args(argv):
    a = list(argv[1:])
    n = len(FILE_WORDS)
    if len(a) >= n and [os.path.basename(x) for x in a[-n:]] == list(FILE_WORDS):
        a = a[:-n]
    return [w for w in a if w != "-"]


class Fail(Exception):
    def __init__(self, kind, msg):
        Exception.__init__(self, msg)
        self.kind, self.msg = kind, msg


def s(v, n=120):
    return kit.clean_text(v, n) if isinstance(v, str) else ""


# ------------------------------------------------------------------ sources: which tools, where, and how each one signs in

def _owner_only(path, what):
    st = os.stat(path).st_mode
    if st & (stat.S_IRWXG | stat.S_IRWXO):
        raise Fail("setup", "%s must be owner-only: chmod 600 %s" % (what, what))


def _url_ok(url):
    u = urllib.parse.urlparse(url)
    host = u.hostname or ""
    try:
        loop = ipaddress.ip_address(host).is_loopback
    except ValueError:
        loop = host == "localhost"
    named = bool(HOST.match(host)) or loop   # a dotted name, or an IP literal (the IPv6 loopback has colons)
    return (u.scheme == "https" or (u.scheme == "http" and loop)) and named and not u.username and not u.query and not u.fragment and u.path in ("", "/")


def _link_ok(tpl):
    """A link template: https (or http to this computer), at most one placeholder, {service}, and nothing else in braces."""
    if not isinstance(tpl, str) or len(tpl) > 500 or re.search(r"\{(?!service\})|(?<!\{service)\}", tpl.replace("{service}", "")):
        return False
    u = urllib.parse.urlparse(tpl.replace("{service}", "x"))
    return u.scheme in ("https", "http") and _url_ok("%s://%s" % (u.scheme, u.netloc)) and not u.username


def read_sources(cfg):
    """The list of sources: the user's file when there is one, else the two public demos. A source is {name, type, url, auth}. auth is one of
    {"kind": "none"}, {"kind": "bearer", "secret": NAME}, {"kind": "basic", "user": U, "secret": NAME}, {"kind": "header", "header": H, "secret": NAME}.
    The file names keys, it never holds them."""
    path = os.path.expanduser(cfg["api"]["sources_file"])
    if os.path.exists(path):
        st = os.stat(path).st_mode
        if st & (stat.S_IWGRP | stat.S_IWOTH):
            raise Fail("setup", "%s must not be writable by others" % cfg["api"]["sources_file"])
        try:
            with open(path, "r", encoding="utf-8") as f:
                raw = json.load(f)
        except ValueError:
            raise Fail("setup", "%s is not valid JSON" % cfg["api"]["sources_file"])
        listed, user = (raw.get("sources") if isinstance(raw, dict) else raw), True
        aliases = raw.get("aliases", {}) if isinstance(raw, dict) else {}
    else:
        listed, user, aliases = cfg["default_sources"], False, {}
    if not isinstance(listed, list) or not 1 <= len(listed) <= 12:
        raise Fail("setup", "sources must be a list of 1 to 12")
    out, seen = [], set()
    for r in listed:
        if not isinstance(r, dict) or not NAME.match(str(r.get("name", ""))) or r.get("name") in seen:
            raise Fail("setup", "every source needs a unique lowercase name (letters, digits, hyphen)")
        seen.add(r["name"])
        if r.get("type") not in ADAPTERS:
            raise Fail("setup", "source %s: type must be one of %s" % (r["name"], ", ".join(sorted(ADAPTERS))))
        if r["type"] in CLI_TYPES:   # a CLI source has no url and no key here: the CLI keeps its own sign-in (for aws: aws sso login)
            for k in ("profile", "region"):
                if r.get(k) is not None and not re.match(r"^[A-Za-z0-9_.@:-]{1,64}\Z", str(r[k])):
                    raise Fail("setup", "source %s: %s has a character it should not" % (r["name"], k))
            out.append({"name": r["name"], "type": r["type"], "url": "cli:" + r["type"], "auth": {"kind": "none"}, "project": "", "demo": False, "links": {}, "trend_query": None, "profile": str(r.get("profile") or ""), "region": str(r.get("region") or "")})
            continue
        if not isinstance(r.get("url"), str) or not _url_ok(r["url"].rstrip("/")):
            raise Fail("setup", "source %s: url must be https://host (or http to this computer), nothing after the host" % r["name"])
        auth = r.get("auth") or {"kind": "none"}
        kind = auth.get("kind")
        if kind not in ("none", "bearer", "basic", "header"):
            raise Fail("setup", "source %s: auth.kind must be none, bearer, basic or header" % r["name"])
        if kind != "none" and not SECRET_NAME.match(str(auth.get("secret", ""))):
            raise Fail("setup", "source %s: auth.secret must name the key, like PROM_TOKEN (UPPER_CASE)" % r["name"])
        if kind == "header" and not re.match(r"^[A-Za-z][A-Za-z0-9-]{0,40}\Z", str(auth.get("header", ""))):
            raise Fail("setup", "source %s: auth.header must be a header name like X-API-Key" % r["name"])
        prefix = r.get("path") or ""
        if prefix and (not isinstance(prefix, str) or not re.match(r"^/[A-Za-z0-9_./-]{1,100}\Z", prefix) or ".." in prefix or prefix.endswith("/")):
            raise Fail("setup", "source %s: path must look like /select/0/prometheus (no .. and no trailing slash)" % r["name"])
        links = r.get("links") or {}
        if not isinstance(links, dict) or any(k not in LINK_KINDS or not _link_ok(v) for k, v in links.items()):
            raise Fail("setup", "source %s: links must use open, logs or traces, each an https address with at most {service} in it" % r["name"])
        tl = r.get("trend_label")
        tq = r.get("trend_query")
        if tq is not None and (not isinstance(tq, str) or len(tq) > 300):
            raise Fail("setup", "source %s: trend_query must be a string of at most 300 characters" % r["name"])
        out.append({"name": r["name"], "type": r["type"], "url": r["url"].rstrip("/"), "auth": auth, "project": str(r.get("project", "")), "demo": not user, "links": links, "trend_query": tq, "trend_label": s(tl, 40) if isinstance(tl, str) else "", "prefix": prefix})
    al = {}
    for k, v in (aliases.items() if isinstance(aliases, dict) else []):
        if isinstance(k, str) and isinstance(v, str):
            al[norm(k, cfg)] = norm(v, cfg)
    return out, al


def credentials(cfg, src):
    """Headers for one source. The key comes from the keychain or the owner-only .env, never from a file listing sources. Returns (headers, problem)."""
    auth = src["auth"]
    if auth["kind"] == "none":
        return {}, ""
    sec = kit.get_secret(APP, auth["secret"], env_file=os.path.expanduser(cfg["api"]["env_file"]))
    val = getattr(sec, "value", None)
    if not val:
        why = getattr(sec, "problem", "") or "no key found"
        return {}, "%s. %s" % (why, kit.setup_hint(APP, auth["secret"]))
    if auth["kind"] == "bearer":
        return {"Authorization": "Bearer " + val}, ""
    if auth["kind"] == "basic":
        tok = base64.b64encode(("%s:%s" % (auth.get("user", ""), val)).encode("utf-8")).decode("ascii")
        return {"Authorization": "Basic " + tok}, ""
    return {auth["header"]: val}, ""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        raise Fail("fail", "redirected: check the source url")


def http_json(cfg, src, headers, path, budget):
    h = {"User-Agent": cfg["api"]["user_agent"], "Accept": "application/json"}
    h.update(headers)   # the key goes only to this source's own host
    try:
        with urllib.request.build_opener(_NoRedirect).open(urllib.request.Request(src["url"] + path, headers=h), timeout=max(1.0, min(cfg["api"]["call_timeout_s"], budget))) as r:
            raw = r.read(cfg["api"]["max_bytes"] + 1)
    except Fail:
        raise
    except urllib.error.HTTPError as e:
        raise Fail("auth" if e.code in (401, 403) else "fail", "answered %d" % e.code)
    except http.client.HTTPException:
        raise Fail("fail", "the answer was cut short")
    except (urllib.error.URLError, OSError, ValueError) as e:
        raise Fail("fail", "timed out" if "timed out" in str(e) else "could not connect")
    if len(raw) > cfg["api"]["max_bytes"]:
        raise Fail("fail", "answer too large")
    try:
        return json.loads(raw.decode("utf-8", "replace"))
    except ValueError:
        raise Fail("fail", "answer was not JSON (a login page? check the key)")


# ------------------------------------------------------------------ names: one service, many spellings

def norm(name, cfg):
    """checkout-api, Checkout_API and checkout-api-deployment are the same service for joining: lowercase, letters and digits only, a known suffix dropped."""
    parts = [p for p in re.split(r"[^a-z0-9]+", str(name).lower()) if p]
    while len(parts) > 1 and parts[-1] in cfg["correlate"]["strip_suffixes"]:
        parts.pop()
    return "".join(parts)


# ------------------------------------------------------------------ adapters: each returns {"services": [...], "alerts": [...]} in the one model
# service: {name, status ok|warn|crit|unknown, detail}.  alert: {name, service, severity warn|crit, since (epoch s or None), summary, state firing|pending|resolved}

def _sev(v):
    v = str(v or "").lower()
    return "crit" if v in ("critical", "crit", "page", "error", "high", "p1", "sev1", "disaster") else "warn"


def _epoch(iso):
    m = re.match(r"^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)", str(iso or ""))
    if not m:
        return None
    import calendar
    return calendar.timegm(tuple(int(x) for x in m.groups()) + (0, 0, 0))


def prom_read(cfg, src, headers, budget, fx=None):
    get = (lambda p: fx[p]) if fx is not None else (lambda p: http_json(cfg, src, headers, p, budget))
    pre = src.get("prefix", "")
    up = get("up") if fx is not None else get(pre + "/api/v1/query?query=" + urllib.parse.quote("up"))
    try:
        al = get("alerts") if fx is not None else get(pre + "/api/v1/alerts")
    except Fail as e:
        if e.kind == "auth":
            raise
        al = {"status": "success", "data": {"alerts": []}}   # services still count when a server has no alerts endpoint
    if not isinstance(up, dict) or up.get("status") != "success" or not isinstance(al, dict) or al.get("status") != "success":
        raise Fail("fail", "not a Prometheus answer")
    jobs = {}
    for r in (up.get("data") or {}).get("result", []):
        m = r.get("metric") or {}
        job = s(m.get("job"), 60)
        try:
            v = float((r.get("value") or [0, "0"])[1])
        except (TypeError, ValueError):
            continue
        if job:
            t = jobs.setdefault(job, [0, 0])
            t[0] += 1
            t[1] += 1 if v >= 1 else 0
    alerts = []
    for a in (al.get("data") or {}).get("alerts", []):
        lab, ann = a.get("labels") or {}, a.get("annotations") or {}
        svc = s(lab.get("service") or lab.get("app") or lab.get("job") or lab.get("namespace") or "unknown", 60)
        alerts.append({"name": s(lab.get("alertname"), 80) or "alert", "service": svc, "severity": _sev(lab.get("severity")), "since": _epoch(a.get("activeAt")),
                       "summary": s(ann.get("title") or ann.get("summary") or ann.get("description"), 200), "state": "firing" if a.get("state") == "firing" else "pending"})
    services = []
    for job, (n, upn) in jobs.items():
        st = "ok" if upn == n else ("crit" if upn == 0 else "warn")
        services.append({"name": job, "status": st, "detail": "%d of %d targets up" % (upn, n)})
    return {"services": services, "alerts": alerts}


COROOT_STATUS = {"ok": "ok", "info": "ok", "warning": "warn", "critical": "crit"}


def coroot_read(cfg, src, headers, budget, fx=None):
    if fx is not None:
        proj, apps, incs = "tbuzvelk", fx["applications"], fx["incidents"]
        extra_a, extra_r = fx.get("alerts", []), fx.get("risks", [])
    else:
        proj = src["project"]
        if not proj:
            u = http_json(cfg, src, headers, "/api/user", budget)
            pr = u.get("projects") if isinstance(u, dict) else None
            if not isinstance(pr, list) or not pr or not re.match(r"^[A-Za-z0-9_-]{1,64}\Z", str((pr[0] or {}).get("id", ""))):
                raise Fail("setup", "no Coroot project found: set \"project\" for this source")
            proj = pr[0]["id"]
        base = "/api/project/%s/" % urllib.parse.quote(proj, safe="")
        apps = (http_json(cfg, src, headers, base + "overview/applications", budget).get("data") or {}).get("applications")
        incs = http_json(cfg, src, headers, base + "incidents", budget).get("data")
        extra_a, extra_r = [], []
        for path, key, store in (("alerts", "alerts", extra_a), ("overview/risks", "risks", extra_r)):   # newer Coroot answers these; an older one may not, so a missing endpoint is skipped
            try:
                got = ((http_json(cfg, src, headers, base + path, budget) or {}).get("data") or {}).get(key) or []
            except Fail as e:
                if e.kind == "auth":
                    raise
                got = []
            store.extend(got if isinstance(got, list) else [])
    if not isinstance(apps, list) or not isinstance(incs, list):
        raise Fail("fail", "not a Coroot answer")
    services = []
    for a in apps:
        if not isinstance(a, dict) or not isinstance(a.get("id"), str):
            continue
        p = a["id"].split(":")
        name = ":".join(p[3:]) if len(p) >= 4 else a["id"]
        bad = [k.replace("_", " ") for k in ("errors", "latency", "upstreams", "instances", "restarts", "cpu", "memory", "network", "logs") if (a.get(k) or {}).get("status") in ("warning", "critical")]
        services.append({"name": s(name, 80), "status": COROOT_STATUS.get(a.get("status"), "unknown"), "detail": s("; ".join(bad), 100) or s(a.get("status"), 12)})
    alerts = []
    for i in incs:
        if not isinstance(i, dict) or not isinstance(i.get("application_id"), str) or not isinstance(i.get("opened_at"), (int, float)):
            continue
        p = i["application_id"].split(":")
        res = i.get("resolved_at")
        r = i.get("rca") or {}
        alerts.append({"name": "SLO incident", "service": s(":".join(p[3:]) if len(p) >= 4 else i["application_id"], 80), "severity": _sev(i.get("severity")), "since": int(i["opened_at"] / 1000),
                       "summary": s(r.get("short_summary"), 200) or "SLO burn", "state": "resolved" if res else "firing"})
    return {"services": services, "alerts": alerts + coroot_extras(extra_a, extra_r)}


def coroot_extras(alerts_raw, risks_raw):
    """Coroot's own Alerts page (rules such as Log errors or Low disk space) and its Risks page (for example an unreplicated database). Alerts are firing alerts; a risk is a standing condition, not an alert, so it carries state "risk"."""
    out = []
    for x in alerts_raw:
        if not isinstance(x, dict) or x.get("resolved_at") or x.get("manually_resolved_at") or x.get("suppressed") is True or not isinstance(x.get("application_id"), str):
            continue
        p = x["application_id"].split(":")
        op = x.get("opened_at")
        op = int(op) if isinstance(op, (int, float)) or (isinstance(op, str) and op.isdigit()) else None
        out.append({"name": s(x.get("rule_name"), 80) or "Coroot alert", "service": s(":".join(p[3:]) if len(p) >= 4 else x["application_id"], 80), "severity": _sev(x.get("severity")),
                    "since": int(op / 1000) if op else None, "summary": s(x.get("summary"), 200) or s(x.get("rule_name"), 80), "state": "firing"})
    for r in risks_raw:
        if not isinstance(r, dict) or not isinstance(r.get("application_id"), str):
            continue
        p = r["application_id"].split(":")
        desc = next((v["description"] for v in r.values() if isinstance(v, dict) and isinstance(v.get("description"), str)), "")
        kind = s((r.get("key") or {}).get("type") if isinstance(r.get("key"), dict) else "", 60).replace("-", " ")
        out.append({"name": "Risk: %s" % (kind or "standing condition"), "service": s(":".join(p[3:]) if len(p) >= 4 else r["application_id"], 80), "severity": _sev(r.get("severity")),
                    "since": None, "summary": s(desc, 200) or kind, "state": "risk"})
    return out


SP_STATUS = {"operational": "ok", "degraded_performance": "warn", "partial_outage": "warn", "under_maintenance": "warn", "major_outage": "crit"}
SP_INDICATOR = {"none": "ok", "minor": "warn", "major": "crit", "critical": "crit", "maintenance": "warn"}
SP_IMPACT = {"critical": "crit", "major": "crit", "minor": "warn", "none": "warn", "maintenance": "warn"}


def statuspage_read(cfg, src, headers, budget, fx=None):
    """Any Atlassian Statuspage (githubstatus.com, cloudflarestatus.com, status.openai.com and many vendors): GET /api/v2/summary.json, no key.
    The page itself is one service; its top-level components are services (a child component is listed only when it is not operational), and open incidents are alerts."""
    raw = fx["summary"] if fx is not None else http_json(cfg, src, headers, "/api/v2/summary.json", budget)
    comps = raw.get("components") if isinstance(raw, dict) else None
    if not isinstance(comps, list) or not isinstance(raw.get("page"), dict):
        raise Fail("fail", "not a Statuspage answer")
    page = s(raw["page"].get("name"), 60) or src["name"]
    ind = (raw.get("status") or {}).get("indicator")
    services = [{"name": page, "status": SP_INDICATOR.get(ind, "unknown"), "detail": s((raw.get("status") or {}).get("description"), 100)}]
    for c in comps:
        if not isinstance(c, dict) or not c.get("name"):
            continue
        st = SP_STATUS.get(c.get("status"), "unknown")
        if c.get("group_id") and st == "ok":
            continue
        services.append({"name": s(c["name"], 80), "status": st, "detail": s(str(c.get("status", "")).replace("_", " "), 40)})
    alerts = []
    for i in raw.get("incidents") or []:
        if not isinstance(i, dict) or not i.get("name"):
            continue
        ups = i.get("incident_updates") or []
        body = s((ups[0] or {}).get("body"), 200) if ups and isinstance(ups[0], dict) else ""
        affected = [c.get("name") for c in (i.get("components") or []) if isinstance(c, dict) and c.get("name")]
        alerts.append({"name": s(i["name"], 90), "service": s(affected[0], 80) if affected else page, "severity": SP_IMPACT.get(i.get("impact"), "warn"), "since": _epoch(i.get("created_at")),
                       "summary": body or s(i.get("status"), 30), "state": "firing"})
    return {"services": services, "alerts": alerts}


ND_STATUS = {"CRITICAL": "crit", "WARNING": "warn"}


def netdata_read(cfg, src, headers, budget, fx=None):
    """A Netdata agent or parent, no key on a public one: GET /api/v1/alarms?active. The host is one service; every WARNING or CRITICAL alarm is an alert."""
    raw = fx["alarms"] if fx is not None else http_json(cfg, src, headers, "/api/v1/alarms?active", budget)
    al = raw.get("alarms") if isinstance(raw, dict) else None
    if not isinstance(al, dict):
        raise Fail("fail", "not a Netdata answer")
    host = s(raw.get("hostname"), 60) or src["name"]
    alerts, worst = [], "ok"
    for k, a in al.items():
        if not isinstance(a, dict) or a.get("status") not in ND_STATUS:
            continue
        sev = ND_STATUS[a["status"]]
        worst = "crit" if sev == "crit" or worst == "crit" else "warn"
        val = a.get("value")
        alerts.append({"name": s("%s (%s)" % (a.get("name") or k, a.get("chart")) if a.get("chart") else (a.get("name") or k), 90), "service": host, "severity": sev, "since": a.get("last_status_change") if isinstance(a.get("last_status_change"), int) else None,
                       "summary": s(a.get("info"), 160) or ("%s on %s: %s %s" % (s(a.get("name"), 50), s(a.get("chart"), 50), val if isinstance(val, (int, float)) and not isinstance(val, bool) else "?", s(a.get("units"), 10))),
                       "state": "firing"})
    return {"services": [{"name": host, "status": worst, "detail": "%d active alarm%s" % (len(alerts), "" if len(alerts) == 1 else "s")}], "alerts": alerts}


def grafana_read(cfg, src, headers, budget, fx=None):
    """Grafana-managed alert rules: GET /api/prometheus/grafana/api/v1/rules (anonymous on a public Grafana; a service-account token otherwise).
    A folder is a service whose status is its worst rule; a firing or pending rule is an alert, attached to its service_name, service, app or job label when it has one."""
    raw = fx["rules"] if fx is not None else http_json(cfg, src, headers, "/api/prometheus/grafana/api/v1/rules", budget)
    groups = (raw.get("data") or {}).get("groups") if isinstance(raw, dict) else None
    if not isinstance(groups, list):
        raise Fail("fail", "not a Grafana rules answer")
    folders, alerts = {}, []
    for g in groups:
        if not isinstance(g, dict):
            continue
        folder = s(g.get("file"), 70) or s(g.get("name"), 70) or "alerts"
        cur = folders.setdefault(folder, "ok")
        for r in g.get("rules") or []:
            if not isinstance(r, dict) or r.get("state") not in ("firing", "pending"):
                continue
            lab, ann = r.get("labels") or {}, r.get("annotations") or {}
            sev = "crit" if r["state"] == "firing" and _sev(lab.get("severity")) == "crit" else "warn"
            folders[folder] = "crit" if sev == "crit" or folders[folder] == "crit" else "warn"
            act = next((a.get("activeAt") for a in (r.get("alerts") or []) if isinstance(a, dict) and a.get("activeAt")), None)
            svc = s(lab.get("service_name") or lab.get("service") or lab.get("app") or lab.get("job") or folder, 70)
            alerts.append({"name": s(r.get("name"), 90) or "alert rule", "service": svc, "severity": sev, "since": _epoch(act),
                           "summary": s(ann.get("summary") or ann.get("description"), 200) or ("rule is %s in %s" % (r["state"], folder)), "state": "firing" if r["state"] == "firing" else "pending"})
    return {"services": [{"name": f, "status": st, "detail": "worst rule state"} for f, st in folders.items()], "alerts": alerts}


CLI_TYPES = ("aws-cloudwatch",)
CLI_DIRS = ("/opt/homebrew/bin", "/usr/local/bin", os.path.expanduser("~/.local/bin"), "/usr/bin", "/bin")


def find_cli(name):
    """A launcher app starts with a short PATH, so look in the usual places too. Returns the full path or None."""
    return shutil.which(name, path=os.pathsep.join([os.environ.get("PATH", "")] + list(CLI_DIRS)))


def run_cli(cmd, budget):
    """One program, an argument list (no shell), no stdin, a time limit, a small environment. Returns parsed JSON."""
    env = dict((k, v) for k, v in os.environ.items() if k in ("HOME", "PATH", "LANG", "TZ", "TMPDIR", "SSL_CERT_FILE", "SSL_CERT_DIR", "AWS_CA_BUNDLE") or k.startswith("AWS_"))
    try:
        r = subprocess.run(cmd, stdin=subprocess.DEVNULL, capture_output=True, timeout=max(2.0, budget), env=env)
    except subprocess.TimeoutExpired:
        raise Fail("fail", "the %s command timed out" % os.path.basename(cmd[0]))
    except OSError:
        raise Fail("setup", "could not start %s" % os.path.basename(cmd[0]))
    if r.returncode != 0:
        err = r.stderr.decode("utf-8", "replace")
        low = err.lower()
        if "sso" in low or "expired" in low or "unable to locate credentials" in low or "token" in low and "invalid" in low:
            raise Fail("auth", "not signed in: run aws sso login (or aws configure) in a terminal")
        raise Fail("fail", "%s exited %d" % (os.path.basename(cmd[0]), r.returncode))
    try:
        return json.loads(r.stdout.decode("utf-8", "replace"))
    except ValueError:
        raise Fail("fail", "the command did not print JSON")


def aws_read(cfg, src, headers, budget, fx=None):
    """CloudWatch alarms that are in ALARM, through the aws CLI the person already signed in to. Services come from the alarm's dimensions; CloudWatch lists no services of its own."""
    if fx is not None:
        raw = fx
    else:
        exe = find_cli("aws")
        if not exe:
            raise Fail("setup", "the aws CLI is not installed: https://aws.amazon.com/cli/")
        cmd = [exe, "cloudwatch", "describe-alarms", "--state-value", "ALARM", "--output", "json", "--max-items", "100"]
        if src.get("profile"):
            cmd += ["--profile", src["profile"]]
        if src.get("region"):
            cmd += ["--region", src["region"]]
        raw = run_cli(cmd, budget)
    if not isinstance(raw, dict):
        raise Fail("fail", "not an aws answer")
    alerts = []
    for a in (raw.get("MetricAlarms") or []) + (raw.get("CompositeAlarms") or []):
        if not isinstance(a, dict) or not a.get("AlarmName"):
            continue
        dims = dict((d.get("Name"), d.get("Value")) for d in (a.get("Dimensions") or []) if isinstance(d, dict))
        svc = next((dims[k] for k in ("ServiceName", "FunctionName", "DBInstanceIdentifier", "ClusterName", "LoadBalancer", "InstanceId", "QueueName", "TableName") if dims.get(k)), None) or a.get("Namespace") or "aws"
        name = s(a["AlarmName"], 80)
        alerts.append({"name": name, "service": s((lambda p: p[1] if len(p) == 3 else p[-1])(str(svc).split("/")), 60), "severity": "crit" if re.search(r"crit|sev-?1|\bp1\b|page", name, re.I) else "warn",
                       "since": _epoch(a.get("StateUpdatedTimestamp")), "summary": s(a.get("AlarmDescription") or a.get("StateReason"), 200) or name, "state": "firing"})
    return {"services": [], "alerts": alerts}


ADAPTERS = {"prometheus": prom_read, "coroot": coroot_read, "statuspage": statuspage_read, "netdata": netdata_read, "grafana": grafana_read, "aws-cloudwatch": aws_read}


# ------------------------------------------------------------------ one source, safely: fresh cache, network, old copy

class Hub(object):
    def __init__(self, cfg, fixture, fx, demos):
        self.cfg, self.fixture, self.fx, self.demos = cfg, fixture, fx, demos
        ok = lambda v: isinstance(v, dict) and isinstance(v.get("services"), list) and isinstance(v.get("alerts"), list)
        root = kit.cache.default_root(APP)
        self.fresh = kit.Cache(APP, cfg["cache"]["ttl"], ok, root=root + "/fresh")
        self.old = kit.Cache(APP, cfg["cache"]["stale_max"], ok, root=root + "/old")

    def read(self, src, refresh):
        """{name, type, ok, err, kind, ms, stale, services, alerts}. One source failing never blanks the others."""
        t0 = time.time()
        res = {"name": src["name"], "type": src["type"], "ok": False, "err": "", "kind": "", "ms": 0, "stale": None, "services": [], "alerts": [], "demo": src["demo"]}
        key = "%s|%s|%s|%s|%s" % (src["name"], src["type"], src["url"], src.get("profile", ""), src.get("region", ""))
        if not refresh and not self.fixture:
            hit = self.fresh.get(key)
            if hit is not None:
                res.update(ok=True, services=hit["services"], alerts=hit["alerts"], ms=0, cached=self.fresh.age(key) or 0)
                return res
        try:
            if "demo-offline" in self.demos:
                raise Fail("fail", "could not connect")
            if self.fixture:
                data = ADAPTERS[src["type"]](self.cfg, src, {}, 0, fx=self.fx[src["name"]])
            else:
                headers, problem = ({}, "") if src["type"] in CLI_TYPES else credentials(self.cfg, src)
                if problem:
                    raise Fail("setup", problem)
                data = ADAPTERS[src["type"]](self.cfg, src, headers, self.cfg["api"]["deadline_s"])
        except Fail as e:
            return self._fallback(res, key, e.msg, e.kind, t0)
        except Exception:
            return self._fallback(res, key, "unexpected answer", "fail", t0)
        if not self.fixture:   # sample answers never go into the real cache, or a live run would show them as if they were yours
            self.fresh.put(key, data)
            self.old.put(key, data)
        res.update(ok=True, services=data["services"], alerts=data["alerts"], ms=int((time.time() - t0) * 1000))
        return res

    def _fallback(self, res, key, why, kind, t0):
        old = None if self.fixture else self.old.get(key)
        res.update(err=why, kind=kind, ms=int((time.time() - t0) * 1000))
        if old is not None:
            res.update(ok=True, stale=self.old.age(key) or 0, services=old["services"], alerts=old["alerts"])
        return res


# ------------------------------------------------------------------ the join: services by name across sources, alerts attached

def join(results, cfg, aliases):
    """Group every source's services and alerts by normalised name (aliases map one spelling onto another). Each group knows what each source said."""
    groups = {}
    key = lambda n: aliases.get(norm(n, cfg), norm(n, cfg))
    keyed = {}
    for r in results:
        for sv in r["services"]:
            g = groups.setdefault(key(sv["name"]), {"name": sv["name"], "by": {}, "alerts": [], "key": key(sv["name"])})
            g["by"][r["name"]] = sv
            if len(sv["name"]) < len(g["name"]):
                g["name"] = sv["name"]
        for al in r["alerts"]:
            g = groups.setdefault(key(al["service"]), {"name": al["service"], "by": {}, "alerts": [], "key": key(al["service"])})
            g["alerts"].append(dict(al, source=r["name"]))
    w = cfg["correlate"]["window_s"]
    out = []
    for g in groups.values():
        firing = [a for a in g["alerts"] if a["state"] == "firing"]
        risks = [a for a in g["alerts"] if a["state"] == "risk"]
        st = max([RANK[v["status"]] for v in g["by"].values()] + [RANK[a["severity"]] for a in firing] + [0])
        worst = ("ok", "warn", "crit")[st]
        seen = sorted(set(list(g["by"]) + [a["source"] for a in firing]))
        said = set(("ok" if RANK[v["status"]] == 0 else "bad") for v in g["by"].values() if v["status"] != "unknown")
        bad_sources = sorted(set([n for n, v in g["by"].items() if RANK[v["status"]] > 0] + [a["source"] for a in firing]))
        flag = ""
        if len(bad_sources) >= 2:
            flag = "AGREE"       # two or more tools see a problem on the same service
            times = sorted(a["since"] for a in firing if a["since"])
            if len(times) >= 2 and times[-1] - times[0] <= w:
                flag = "TOGETHER"   # and their alerts started within the window
        elif len(g["by"]) >= 2 and said == set(("ok", "bad")):
            flag = "DISAGREE"    # one tool says fine while another does not
        out.append({"name": g["name"], "key": g["key"], "status": worst, "by": g["by"], "alerts": g["alerts"], "firing": firing, "risks": risks, "sources": seen, "bad_sources": bad_sources, "flag": flag})
    out.sort(key=lambda x: (-RANK[x["status"]], -len(x["firing"]), x["name"].lower()))
    return out


# ------------------------------------------------------------------ links and trend

def links_for(g, srcmap):
    """open, logs and traces addresses for one joined service, from the sources that know it (bad ones first). {service} becomes that source's own name for the service, percent-encoded."""
    order = sorted(set(list(g["by"]) + [a["source"] for a in g["alerts"]]), key=lambda n: (n not in g["bad_sources"], n))
    out = {}
    for n in order:
        src = srcmap.get(n)
        if not src:
            continue
        svc = g["by"][n]["name"] if n in g["by"] else g["name"]
        for k, tpl in (src.get("links") or {}).items():
            if k not in out:
                out[k] = tpl.replace("{service}", urllib.parse.quote(svc, safe=""))
    return out


DEFAULT_TREND = 'avg(up{job="{service}"})'


def trend_points(cfg, src, headers, svc, budget, fx=None, query=None):
    """[(epoch, value)] for the last 3 hours from a Prometheus source: a trend_query with {service}, or the share of targets up. The name goes into a PromQL label, so only plain names are allowed."""
    if src["type"] != "prometheus" or not SAFE_NAME.match(svc):
        return []
    if fx is not None:
        raw = fx.get("range")
    else:
        q = (query or src.get("trend_query") or DEFAULT_TREND).replace("{service}", svc)
        end = int(time.time())
        raw = http_json(cfg, src, headers, src.get("prefix", "") + "/api/v1/query_range?" + urllib.parse.urlencode({"query": q, "start": end - 10800, "end": end, "step": 300}), budget)
    try:
        res = raw["data"]["result"]
        vals = res[0]["values"] if res else []
        return [(int(float(a)), float(b)) for a, b in vals][-40:]
    except (KeyError, TypeError, ValueError, IndexError):
        return []


def pick_trend(cfg, src, headers, svc, budget, fx=None):
    """(label, points): the source's own trend_query if it names one, else the first candidate in config that has at least 5 points and is not a flat line; the last resort is whatever came back first."""
    if fx is not None:
        return s(fx.get("range_label"), 40) or "trend", trend_points(cfg, src, headers, svc, budget, fx=fx)
    cands = [(src.get("trend_label") or "your query", src["trend_query"])] if src.get("trend_query") else [(c["label"], c["query"]) for c in cfg["trend"]]
    first = ("", [])
    for label, q in cands:
        try:
            pts = trend_points(cfg, src, headers, svc, budget, query=q)
        except Fail:
            continue
        if len(pts) >= 5 and max(v for _, v in pts) != min(v for _, v in pts):
            return label, pts
        if pts and not first[1]:
            first = (label, pts)
    return first


BLOCKS = "\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588"


def spark(vals):
    """A text sparkline from block characters, so a trend shows in any pane that draws text."""
    if not vals:
        return ""
    lo, hi = min(vals), max(vals)
    if hi == lo:
        return BLOCKS[0] * len(vals)
    return "".join(BLOCKS[min(7, int((v - lo) / (hi - lo) * 7.999))] for v in vals)


def bars(n, mx, width=12):
    return "\u2588" * max(1, int(round(width * n / float(mx)))) if n and mx else ""


class History(object):
    """A local history of the overview numbers, one point per run at least a minute apart, kept in the kit cache for a week. It starts when you install the app: nothing here is fetched from any source."""
    def __init__(self, cfg, sig):
        ok = lambda v: isinstance(v, dict) and isinstance(v.get("pts"), list)
        self.c = kit.Cache(APP, 7 * 86400, ok, root=kit.cache.default_root(APP) + "/history")
        self.keep, self.gap, self.sig = cfg["history"]["keep"], cfg["history"]["min_gap_s"], sig

    def add(self, snap):
        cur = self.c.get("history") or {}
        pts = cur.get("pts", []) if cur.get("sig") == self.sig else []
        if not pts or snap["t"] - pts[-1]["t"] >= self.gap:
            pts = (pts + [snap])[-self.keep:]
            self.c.put("history", {"sig": self.sig, "pts": pts})
        return pts


def snapshot(results, groups):
    firing = [a for g in groups for a in g["firing"]]
    return {"t": int(time.time()), "firing": len(firing), "crit": sum(1 for a in firing if a["severity"] == "crit"), "services": len(groups),
            "ok": sum(1 for g in groups if g["status"] == "ok"), "up": sum(1 for r in results if r["ok"] and r["stale"] is None)}


# ------------------------------------------------------------------ rows

def back(sub="Back to the overview"):
    return kit.back_row(sub, view=kit.NOTE_VIEW)


def ago(t):
    return "%s ago" % kit.fmt_duration(max(0, int(time.time()) - t)) if t else "time unknown"


def banner(results, fixture):
    rows = []
    if fixture:
        rows.append(kit.note_row("Sample data", "Recorded answers from two public demos, no network", icon="FileText", badge="SAMPLE"))
    for r in results:
        if r["err"] and r["stale"] is not None:
            rows.append(kit.note_row("%s: old copy" % r["name"], "%s (%s). Copy is %s old" % (r["name"], r["err"], kit.fmt_duration(r["stale"])), icon="Clock", badge="OLD COPY"))
        elif r["err"]:
            rows.append(kit.note_row("%s: %s" % (r["name"], "needs setup" if r["kind"] == "setup" else ("sign-in refused" if r["kind"] == "auth" else "unreachable")), r["err"], icon="AlertCircle", badge="CHECK" if r["kind"] != "fail" else "OFFLINE"))
    return rows


def service_row(g, srcmap=None, nav=False, trend=None, label=""):
    per = " · ".join("%s %s" % (n, WORD[v["status"]].lower()) for n, v in sorted(g["by"].items()))
    extra = (" · %d alert%s firing" % (len(g["firing"]), "" if len(g["firing"]) == 1 else "s") if g["firing"] else "") + (" · %d risk%s" % (len(g["risks"]), "" if len(g["risks"]) == 1 else "s") if g["risks"] else "")
    lines = ["**%s** (%s)" % (g["name"], g["status"].upper())] + ["- %s: %s%s" % (n, WORD[v["status"]], (", " + v["detail"]) if v["detail"] else "") for n, v in sorted(g["by"].items())]
    if g["firing"]:
        lines += ["", "**Firing now**"] + ["- %s (%s, %s): %s" % (a["name"], a["source"], a["severity"], a["summary"] or "no summary") for a in g["firing"][:5]]
    if g["risks"]:
        lines += ["", "**Risks**"] + ["- %s" % (a["summary"] or a["name"]) for a in g["risks"][:5]]
    if g["firing"]:
        crit = sum(1 for a in g["firing"] if a["severity"] == "crit")
        warn = len(g["firing"]) - crit
        mx = max(crit, warn, 1)
        lines += ["", "**Severity**", "`crit  %-12s %d`" % (bars(crit, mx), crit), "`warn  %-12s %d`" % (bars(warn, mx), warn)]
    if trend:
        vals = [v for _, v in trend]
        lines += ["", "**Trend, last 3 hours%s**" % ((" (" + label + ")") if label else ""), "`%s`" % spark(vals), "low %.3g, high %.3g, now %.3g" % (min(vals), max(vals), vals[-1])]
    share = "%s: %s across %s%s" % (g["name"], g["status"].upper(), ", ".join(g["sources"]) or "no source", ("; firing: " + ", ".join(a["name"] for a in g["firing"][:4])) if g["firing"] else "")
    badges = [(WORD[g["status"]], TONE[g["status"]])] + ([(g["flag"], "danger" if g["flag"] != "DISAGREE" else "warn")] if g["flag"] else [])
    triage = "Triage this service. %s is %s across my monitoring tools: %s.%s What are the likely causes and the first three checks?" % (
        g["name"], g["status"].upper(), "; ".join("%s says %s" % (n, v["status"]) for n, v in sorted(g["by"].items())) or "no source lists it",
        (" Firing: " + "; ".join("%s (%s)" % (a["name"], a["summary"]) for a in g["firing"][:3]) + ".") if g["firing"] else "")
    lk = links_for(g, srcmap or {})
    kw = dict((k + "_url", v) for k, v in lk.items())
    if nav:
        kw["nav"] = {"view": "services", "arg": "key." + g["key"]}
    if trend:
        kw["trend"] = [round(v, 3) for _, v in trend]
    return kit.safe_row(g["name"], per + extra, icon="Activity", badges=badges, body="\n".join(lines), copy=False if nav else share, s_status=g["status"].upper(), s_sources=", ".join(g["sources"]) or "-",
                        s_alerts=str(len(g["firing"])), s_signal={"AGREE": "Several tools see a problem", "TOGETHER": "Several tools, started together", "DISAGREE": "Tools disagree", "": "-"}[g["flag"]],
                        share_text=kit.safe_copy(share), triage_text=kit.safe_copy(triage),
                        tile=kit.safe_tile("Sources seeing a problem", len(g["bad_sources"]), max=max(1, len(g["sources"])), note="of %d that know it" % len(g["sources"]), foot=g["flag"].lower() or "no cross-tool signal"), **kw)


def alert_row(a, srcmap=None):
    share = "%s on %s (%s, %s): %s. %s" % (a["name"], a["service"], a["source"], a["severity"], ago(a["since"]), a["summary"])
    src = (srcmap or {}).get(a["source"]) or {}
    lk = dict((k + "_url", v.replace("{service}", urllib.parse.quote(a["service"], safe=""))) for k, v in (src.get("links") or {}).items())
    when = "standing risk" if a["state"] == "risk" else ago(a["since"])
    return kit.safe_row("%s · %s" % (a["name"], a["service"]), "%s · %s · %s" % (a["source"], a["severity"], when), icon="AlertCircle", **lk,
                        badges=[(a["severity"].upper(), TONE[a["severity"]]), (a["state"].upper(), {"firing": "danger", "pending": "warn", "resolved": "success", "risk": "info"}.get(a["state"], ""))], body=a["summary"] or "No summary from the source.", copy=share,
                        s_status=a["severity"].upper(), s_sources=a["source"], s_alerts="1", s_signal=ago(a["since"]), share_text=kit.safe_copy(share),
                        triage_text=kit.safe_copy("Triage this alert from %s. %s on %s, %s, %s. %s What should I check first?" % (a["source"], a["name"], a["service"], a["severity"], ago(a["since"]), a["summary"])))


def overview_rows(results, groups, fixture, any_demo, hist=None):
    up = sum(1 for r in results if r["ok"] and r["stale"] is None)
    total = len(groups)
    ok = sum(1 for g in groups if g["status"] == "ok")
    firing = [a for g in groups for a in g["firing"]]
    crit = sum(1 for a in firing if a["severity"] == "crit")
    multi = [g for g in groups if g["flag"]]
    rows = [
        kit.row("Sources: %d of %d answering" % (up, len(results)), ", ".join("%s %s" % (r["name"], "ok" if r["ok"] and r["stale"] is None else ("old" if r["ok"] else "down")) for r in results), icon="Database",
                nav={"view": "sources"}, badge="ALL UP" if up == len(results) else "CHECK", tile=kit.safe_tile("Sources answering", up, max=len(results), note="of %d" % len(results), foot="Enter for the table"), body="Press Enter for the source table."),
        kit.row("Services: %d of %d healthy" % (ok, total), "joined by name across %d sources" % len(results), icon="Layers", nav={"view": "services"}, badge="ALL OK" if ok == total else "ATTENTION",
                tile=kit.safe_tile("Healthy services", ok, max=total or None, note="of %d" % total, foot="worst first"), body="Press Enter for the joined service list."),
        kit.row("Alerts: %d firing, %d critical" % (len(firing), crit), "from every source, worst first", icon="AlertCircle", nav={"view": "alerts"}, badge="CRITICAL" if crit else ("FIRING" if firing else "QUIET"),
                tile=kit.safe_tile("Firing alerts", len(firing), max=max(1, len(firing)), note="%d critical" % crit, foot="all sources"), body="Press Enter for the alert list."),
        kit.row("Cross-tool: %d services" % len(multi), "two or more tools agree there is a problem, or disagree", icon="ShieldAlert", nav={"view": "services"}, badge="LOOK" if multi else "NONE",
                tile=kit.safe_tile("Cross-tool signals", len(multi), max=max(1, total), note="agree, together or disagree", foot="joined by service name"), body="Services where tools agree, started together, or disagree."),
    ]
    def tk(vals):
        return {"trend": vals[-24:], "delta": vals[-1] - vals[0], "since": "over %d runs" % len(vals)} if len(vals) >= 3 else {}
    hist = hist or []
    rows[1] = dict(rows[1], **tk([p["ok"] for p in hist]))
    rows[2] = dict(rows[2], **tk([p["firing"] for p in hist]))
    unhealthy = sum(1 for r in results for sv in r["services"] if RANK[sv["status"]] > 0)
    nrisk = sum(len(g["risks"]) for g in groups)
    rows += [
        kit.row("Risks: %d standing" % nrisk, "conditions such as an unreplicated database, not alerts", icon="ShieldAlert", nav={"view": "services", "arg": "risk"}, badge="RISKS" if nrisk else "NONE",
                tile=kit.safe_tile("Standing risks", nrisk, max=max(nrisk, 1), note="across %d services" % len([g for g in groups if g["risks"]]), foot="Enter for the services"), body="Press Enter for the services that carry a risk."),
        kit.row("Alerts by source: a chart", "%d firing, as bars" % len(firing), icon="AlertCircle", nav={"view": "chart"}, badge="CHART",
                tile=kit.safe_tile("Firing by source", len(firing), max=max(len(firing), 1), note="across %d sources" % len(results), foot="Enter for the bar chart"), body="Press Enter for the bar chart."),
        kit.row("Unhealthy by source: a chart", "%d services need attention" % unhealthy, icon="Layers", nav={"view": "chart", "arg": "unhealthy"}, badge="CHART",
                tile=kit.safe_tile("Unhealthy by source", unhealthy, max=max(unhealthy, 1), note="warn or critical", foot="Enter for the bar chart"), body="Press Enter for the bar chart."),
        kit.row("Alert table: sortable", "%d firing or pending, worst first" % len([a for g in groups for a in g["alerts"] if a["state"] in ("firing", "pending")]), icon="List", nav={"view": "table"}, badge="TABLE",
                tile=kit.safe_tile("Alert table", len(firing), max=max(len(firing), 1), note="rows", foot="Enter for the table"), body="Press Enter for a sortable table."),
    ]
    tag = ("SAMPLE" if fixture else ("DEMO" if any_demo else ""))
    if tag:
        rows[0] = dict(rows[0], kpi_badge=tag, kpi_foot=kit.text("public demo data" if not fixture else "recorded answers", 80))
    rows.append(kit.row("Check again", "Enter to fetch fresh data past the cache", icon="RefreshCw", nav={"view": "overview", "arg": "refresh"}, copy=False, tile=kit.safe_tile("Sources", len(results), note="Enter to refresh"), body="Press Enter to fetch fresh data."))
    return rows


def build(view, word, results, groups, fixture, srcmap=None, trend=None):
    if view == "services" and (word or "").lower().startswith("key."):
        view, word = "service", word[4:]
    head = [back()] + banner(results, fixture)
    w = word.lower()
    if view == "services":
        flt = {"bad": ("warn", "crit"), "crit": ("crit",), "warn": ("warn",), "ok": ("ok",), "cross": None}.get(w)   # =obs services bad | crit | warn | ok | cross
        if w in ("bad", "crit", "warn", "ok"):
            items = [g for g in groups if g["status"] in flt][:50]
        elif w == "risk":
            items = [g for g in groups if g["risks"]][:50]
        elif w == "cross":
            items = [g for g in groups if g["flag"]][:50]
        else:
            items = [g for g in groups if not w or w in g["name"].lower()][:50]
        return head + ([service_row(g, srcmap, nav=True) for g in items] or [kit.note_row("No match", "no service matches %s" % kit.clean_text(word, 40), icon="Activity")])
    if view == "chart":   # =obs chart (firing alerts by source) or =obs chart unhealthy (unhealthy services by source)
        bad = (word or "").lower() == "unhealthy"
        per = {}
        for r in results:
            per[r["name"]] = sum(1 for sv in r["services"] if RANK[sv["status"]] > 0) if bad else len([a for a in r["alerts"] if a["state"] == "firing"])
        what = "unhealthy services" if bad else "firing alerts"
        return [kit.row(n, "%d %s" % (c, what), icon="Layers" if bad else "AlertCircle", src=n, n=c) for n, c in sorted(per.items(), key=lambda x: (-x[1], x[0]))] or [kit.note_row("No sources", "nothing to chart", icon="Database")]
    if view == "table":
        now = int(time.time())
        al = sorted([a for g in groups for a in g["alerts"] if a["state"] in ("firing", "pending")], key=lambda a: (-RANK[a["severity"]], -(a["since"] or 0)))[:50]
        return [kit.row("%s · %s" % (a["name"], a["service"]), "%s · %s" % (a["source"], a["severity"]), icon="AlertCircle", sev=WORD[a["severity"]], alert=a["name"], service=a["service"], source=a["source"],
                        age=int((now - a["since"]) // 60) if a["since"] else 0) for a in al] or [kit.note_row("Nothing firing", "no source reports a firing alert", icon="ShieldCheck", badge="QUIET")]
    if view in ("service", "trend"):
        g = next((x for x in groups if x["key"] == word), None) if TOKEN.match(word or "") else None
        if g is None:
            return [back("Back to services"), kit.note_row("Service not found", "no source lists %s" % kit.clean_text(word, 40), icon="Activity")]
        pts = [p for lp in (trend or {}).values() for p in lp[1]]
        if view == "trend":
            if not pts:
                return [kit.note_row("No trend", "no source returned a time series for %s" % g["name"], icon="TrendingUp")]
            return [kit.row(time.strftime("%H:%M", time.localtime(ts)), "%.3f" % v, icon="TrendingUp", t=time.strftime("%H:%M", time.localtime(ts)), v=round(v, 3)) for ts, v in pts]
        first = next(iter(trend or {}), None)
        lab, fpts = (trend or {}).get(first, ("", [])) if first else ("", [])
        rows = [back("Back to services")] + [service_row(g, srcmap, trend=fpts, label=lab)] + head[1:]
        for n, v in sorted(g["by"].items()):
            lk = dict((k + "_url", tpl.replace("{service}", urllib.parse.quote(v["name"], safe=""))) for k, tpl in ((srcmap or {}).get(n) or {}).get("links", {}).items())
            rows.append(kit.safe_row("%s: %s" % (n, WORD[v["status"]]), v["detail"] or "no detail", icon="Database", badges=[(WORD[v["status"]], TONE[v["status"]])], body="%s says %s for %s%s" % (n, WORD[v["status"]], v["name"], (": " + v["detail"]) if v["detail"] else ""),
                                     copy="%s: %s %s" % (n, v["name"], WORD[v["status"]]), s_status=WORD[v["status"]], s_sources=n, s_alerts=str(len([a for a in g["firing"] if a["source"] == n])), s_signal="-", **lk))
        rows += [alert_row(a, srcmap) for a in g["firing"][:10]] + [alert_row(a, srcmap) for a in g["risks"][:5]]
        if pts:
            rows.append(kit.row("Trend, last 3 hours", "%s · %d points · Enter for the chart" % (lab or "series", len(pts)), icon="TrendingUp", nav={"view": "trend", "arg": g["key"]}, copy=False, body="A line chart of the source's time series.", s_status="-", s_sources=", ".join(trend), s_alerts="-", s_signal="-"))
        return rows
    if view == "alerts":
        now = int(time.time())
        live = lambda a: a["state"] in ("firing", "pending") or (a["state"] == "resolved" and a["since"] and now - a["since"] < 86400)   # firing, pending, and resolved in the last day
        al = sorted([a for g in groups for a in g["alerts"] if live(a) and (not w or w in (a["name"] + a["service"]).lower())], key=lambda a: ({"firing": 0, "pending": 1}.get(a["state"], 2), -RANK[a["severity"]], -(a["since"] or 0)))[:50]
        return head + ([alert_row(a, srcmap) for a in al] or [kit.note_row("Nothing firing", "no source reports an alert, firing or recent", icon="ShieldCheck", badge="QUIET")])
    rows = [kit.row(r["name"], "%s · %s" % (r["type"], "answering" if r["ok"] and r["stale"] is None else (r["err"] or "no answer")), icon="Database", node=r["name"], kind=r["type"],
                    state="ok" if r["ok"] and r["stale"] is None else ("old copy" if r["ok"] else "down"), ms=r["ms"], services=len(r["services"]), alerts=len([a for a in r["alerts"] if a["state"] == "firing"])) for r in results]
    return rows or [kit.note_row("No sources", "add one in ~/.config/obs/sources.json", icon="Database")]


# ------------------------------------------------------------------ the app file, written from config.json

def _tile_bind(ind):
    pad = " " * ind
    return [pad + 'title: "{{row.kpi_label}}"', pad + 'value: "{{row.kpi_value}}"', pad + 'unit: "{{row.kpi_unit}}"', pad + 'max: "{{row.kpi_max}}"', pad + 'subtitle: "{{row.kpi_note}}"',
            pad + 'badge: "{{row.kpi_badge}}"', pad + 'footer: "{{row.kpi_foot}}"']


_PREVIEW = ["kind: entity_preview", "mode: selected_row", "bind:", '  title: "{{row.title}}"', '  subtitle: "{{row.subtitle}}"', "  tiles_above:"] + _tile_bind(4) + [
    "  fields:", '    - { label: STATUS, value: "{{row.s_status}}" }', '    - { label: SOURCES, value: "{{row.s_sources}}" }', '    - { label: FIRING, value: "{{row.s_alerts}}" }', '    - { label: SIGNAL, value: "{{row.s_signal}}" }',
    '  body: "{{row.body}}"', "  actions:", '    - "open"', '    - "logs"', '    - "traces"', '    - "copy"', '    - "triage"']
_TILES = ["kind: cards", "mode: list_data", "bind:", '  layout: "tiles"'] + _tile_bind(2) + ['  delta: "{{row.delta}}"', '  delta_label: "{{row.since}}"', '  trend: "{{row.trend}}"']
_NOTE = ["kind: markdown", "mode: selected_row", "bind:", '  title: "{{row.title}}"', '  subtitle: "{{row.subtitle}}"', '  body: "{{row.body}}"']


def _indent(lines, n):
    return [" " * n + x for x in lines]


def emit_yaml(cfg):
    app = cfg["app"]
    words = " ".join("{{scripts_dir}}/%s" % f for f in FILE_WORDS)
    L = ["# Generated by: python3 scripts/" + _SELF + " --emit-yaml (edit config.json, not this file)", "schema_version: 1", "runtime: bridge", "id: %s" % app["id"], "chip: %s" % app["chip"],
         "title: %s" % json.dumps(app["title"]), "icon: %s" % app["icon"], "description: %s" % json.dumps(app["description"]), 'placeholder_examples: ["Enter for the overview", "services bad", "services cross", "alerts", "sources"]',
         "emits: Generic", "args:", '  - { name: view, from: "query.word(0)", default: overview }', '  - { name: arg, from: "query.word(1)", default: "-" }', '  - { name: arg2, from: "query.word(2)", default: "-" }', "bridge:", "  command:"]
    for osn, py in (("macos", "python3"), ("linux", "python3"), ("windows", "python")):
        L.append(('    %s: "%s {{scripts_dir}}/' + _SELF + ' {{view}} {{arg}} {{arg2}} %s"') % (osn, py, words))
    L += ["  parse: json", "  timeout_seconds: %d" % app["timeout"], "presentation:", "  widget: list", "  title_field: title", "  subtitle_field: subtitle", "  view_arg: view", "  right_widget:"]
    L += _indent(_PREVIEW, 4)
    L += ["  views:", "    overview:", "      right_widget:"] + _indent(_TILES, 8)
    L += ["    services:", "      right_widget:"] + _indent(_PREVIEW, 8) + ["    alerts:", "      right_widget:"] + _indent(_PREVIEW, 8)
    L += ["    trend:", "      right_widget:", "        kind: chart", "        mode: list_data", "        bind:", "          type: line", "          x: t", "          y: v", '          label: "Trend, last 3 hours"']
    L += ["    sources:", "      right_widget:", "        kind: table", "        mode: list_data", "        bind:", "          columns:", "            - { field: node, label: Source }", "            - { field: kind, label: Type }",
          "            - { field: state, label: State }", "            - { field: services, label: Services, align: right }", "            - { field: alerts, label: Firing, align: right }", "            - { field: ms, label: Ms, align: right }"]
    L += ["    chart:", "      right_widget:", "        kind: chart", "        mode: list_data", "        bind:", "          type: bar", "          x: src", "          y: n", '          label: "Count by source"']
    L += ["    table:", "      right_widget:", "        kind: table", "        mode: list_data", "        bind:", "          columns:", "            - { field: sev, label: Level }", "            - { field: alert, label: Alert }", "            - { field: service, label: Service }",
          "            - { field: source, label: Source }", "            - { field: age, label: Minutes, align: right }"]
    L += ["    note:", "      right_widget:"] + _indent(_NOTE, 8)
    L += ["actions:", '  - { id: open, kind: url, target: row, label: "Open", url_template: "{{row.open_url}}" }', '  - { id: logs, kind: url, target: row, label: "Logs", url_template: "{{row.logs_url}}" }', '  - { id: traces, kind: url, target: row, label: "Traces", url_template: "{{row.traces_url}}" }', '  - { id: copy, kind: composer, target: row, label: "Copy summary", insert: "{{row.share_text}}" }', '  - { id: triage, kind: composer, target: row, label: "Triage with AI", insert: "{{row.triage_text}}" }']
    return "\n".join(L) + "\n"


# ------------------------------------------------------------------ main

def offline(msg, kind, view):
    kit.emit(([back()] if view in ("services", "alerts") else []) + [kit.note_row("Observability is not set up" if kind == "setup" else "Could not read sources", msg, badge="CHECK"), kit.refresh_row(view if view in VIEWS else "overview", title="Try again", subtitle="Enter to run again", pane=kit.NOTE_VIEW)])


def main(argv):
    cfg = load_json("config.json")
    if "--emit-yaml" in argv:
        sys.stdout.write(emit_yaml(cfg))
        return
    words = split_args(argv)
    demos = [w for w in words if w == "demo-offline"]
    words = [w for w in words if w not in demos]
    first = words[0].lower() if words else ""
    alias = first == "service"   # =obs service <name> is the drill typed by hand
    view = first if first in VIEWS else ("services" if first else "overview")
    rest = words[1:] if (first in VIEWS or alias) else words
    word = kit.clean_text(" ".join(rest), 40)
    refresh = word == "refresh"
    if refresh:
        word = ""
    env = os.environ.get("BOLT_APP_FIXTURE")
    fixture = (env == "1") if env in ("0", "1") else bool(cfg["api"]["fixture_default"])
    fx = load_json("fixtures.json") if fixture else {}
    try:
        sources, aliases = ([dict(r, auth={"kind": "none"}, project="", demo=True, links={}, trend_query=r.get("trend_query"), trend_label=r.get("trend_label", ""), prefix=r.get("path", "")) for r in cfg["default_sources"]], {}) if fixture else read_sources(cfg)
    except Fail as e:
        offline(e.msg, e.kind, view)
    hub = Hub(cfg, fixture, fx, demos)
    with cf.ThreadPoolExecutor(max_workers=min(8, len(sources))) as ex:
        results = list(ex.map(lambda r: hub.read(r, refresh), sources))
    if not any(r["ok"] for r in results) and view != "sources":
        kit.emit(([back()] if view in ("services", "alerts") else []) + banner(results, fixture) + [kit.refresh_row(view if view in VIEWS else "overview", title="Try again", subtitle="Enter to run again", pane=kit.NOTE_VIEW)])
    groups = join(results, cfg, aliases)
    srcmap = dict((s_["name"], s_) for s_ in sources)
    trend = {}
    if alias:
        word = "key." + aliases.get(norm(word, cfg), norm(word, cfg))
    if (view == "services" and word.lower().startswith("key.")) or view == "trend":
        g_ = next((x for x in groups if x["key"] == (word[4:] if word.lower().startswith("key.") else word)), None)
        for n, v in (g_["by"].items() if g_ else []):
            src = srcmap.get(n)
            if not src or src["type"] != "prometheus":
                continue
            try:
                hdr = {} if fixture else credentials(cfg, src)[0]
                lab, pts = pick_trend(cfg, src, hdr, v["name"], cfg["api"]["deadline_s"], fx=fx.get(n) if fixture else None)
            except Fail:
                lab, pts = "", []
            if pts:
                trend[n] = (lab, pts)
    if view == "overview":
        hist = fx.get("history", []) if fixture else History(cfg, ",".join(sorted(s_["name"] for s_ in sources))).add(snapshot(results, groups))
        kit.emit(overview_rows(results, groups, fixture, any(r["demo"] for r in results), hist))
    kit.emit(build(view, word, results, groups, fixture, srcmap, trend))


def run(argv):
    try:
        main(argv)
    except SystemExit:
        raise
    except kit.KitError as e:
        kit.emit([kit.error_row("Row contract: %s" % kit.clean_text(str(e), 200), title="This app could not run")])
    except Exception as e:
        if os.environ.get("BOLT_APP_DEBUG"):
            import traceback
            traceback.print_exc()
        kit.emit([kit.error_row("%s while building the rows. Run the script in a terminal to see why." % e.__class__.__name__)])


if __name__ == "__main__":
    run(sys.argv)
