#!/usr/bin/env python3
"""=coroot [view] [word]: Coroot at a glance. Views: overview (tiles), apps (every service, unhealthy first), incidents (SLO incidents with the root cause Coroot found), nodes (table).
Reads three Coroot API answers (read-only GETs): overview/applications, overview/nodes and incidents. Ships pointed at the public demo (demo.coroot.com, anonymous read-only).
Your own Coroot: put COROOT_URL (and COROOT_API_KEY, COROOT_PROJECT if needed) in ~/.config/coroot/.env (mode 600). Sample mode (BOLT_APP_FIXTURE=1) reads recorded demo answers."""
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
import stat
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
FILE_WORDS = tuple(_PFX + w for w in ("config.json", "fixtures.json", "bolt_app_kit.py",))
VIEWS = ("overview", "apps", "incidents", "nodes")
APP = "coroot"
PROJECT = re.compile(r"^[A-Za-z0-9_-]{1,64}\Z")
HOST = re.compile(r"^[A-Za-z0-9.-]{1,253}\Z")
CHECKS = ("errors", "latency", "upstreams", "instances", "restarts", "cpu", "memory", "disk_io_load", "disk_usage", "network", "dns", "logs")
TONES = {"ok": "success", "warning": "warn", "critical": "danger", "info": "info"}


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


# ------------------------------------------------------------------ settings: the demo by default, your Coroot from ~/.config/coroot/.env

def settings(cfg):
    """base url, api key, project id. The .env file must be owner-only (mode 600) because it can hold the key. Only https, or http to this computer (a port-forward)."""
    api = cfg["api"]
    vals = {}
    path = os.path.expanduser(api["env_file"])
    if os.path.exists(path):
        if os.stat(path).st_mode & (stat.S_IRWXG | stat.S_IRWXO):
            raise Fail("setup", "%s must be owner-only: chmod 600 %s" % (api["env_file"], api["env_file"]))
        with open(path, "r", encoding="utf-8") as f:
            for line in f.read().splitlines():
                k, sep, v = line.partition("=")
                if sep and not line.lstrip().startswith("#"):
                    vals[k.strip()] = v.strip().strip("\"'")
    base = (vals.get("COROOT_URL") or api["base_url"]).rstrip("/")
    u = urllib.parse.urlparse(base)
    local = u.hostname in ("localhost", "127.0.0.1", "::1")
    if not (u.scheme == "https" or (u.scheme == "http" and local)) or not u.hostname or not HOST.match(u.hostname) or u.username or u.path not in ("", "/") or u.query:
        raise Fail("setup", "COROOT_URL must be https://host (or http://localhost:port), nothing after the host")
    proj = vals.get("COROOT_PROJECT", "")
    if proj and not PROJECT.match(proj):
        raise Fail("setup", "COROOT_PROJECT has a character a project id does not use")
    return {"base": base, "key": vals.get("COROOT_API_KEY", ""), "project": proj, "project_id": "", "demo": base == api["base_url"]}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        raise Fail("fail", "redirected: check COROOT_URL")


def http_json(cfg, st, path, budget):
    headers = {"User-Agent": cfg["api"]["user_agent"], "Accept": "application/json"}
    if st["key"]:
        headers["X-API-Key"] = st["key"]   # sent only to the one host in COROOT_URL
    try:
        with urllib.request.build_opener(_NoRedirect).open(urllib.request.Request(st["base"] + path, headers=headers), timeout=max(1.0, min(cfg["api"]["call_timeout_s"], budget))) as r:
            raw = r.read(cfg["api"]["max_bytes"] + 1)
    except Fail:
        raise
    except urllib.error.HTTPError as e:
        raise Fail("auth" if e.code in (401, 403) else ("notfound" if e.code == 404 else "fail"), "answered %d" % e.code)
    except http.client.HTTPException:
        raise Fail("fail", "the answer was cut short")
    except (urllib.error.URLError, OSError, ValueError) as e:
        raise Fail("fail", "timed out" if "timed out" in str(e) else "could not connect")
    if len(raw) > cfg["api"]["max_bytes"]:
        raise Fail("fail", "answer too large")
    try:
        return json.loads(raw.decode("utf-8", "replace"))
    except ValueError:
        raise Fail("fail", "answer was not JSON (a login page? check COROOT_API_KEY)")


# ------------------------------------------------------------------ reading Coroot's answers

def s(v, n=120):
    return kit.clean_text(v, n) if isinstance(v, str) else ""


def parts(app_id):
    """tbuzvelk:default:Deployment:user -> (namespace, kind, name). Coroot's id is project:namespace:kind:name."""
    p = app_id.split(":")
    return (p[1], p[2], ":".join(p[3:])) if len(p) >= 4 else ("", "", app_id)


def n_apps(raw):
    rows = raw.get("data", {}).get("applications") if isinstance(raw, dict) else None
    if not isinstance(rows, list):
        raise ValueError("no applications in the answer")
    out = []
    for a in rows:
        if not isinstance(a, dict) or not isinstance(a.get("id"), str):
            continue
        ns, kind, name = parts(a["id"])
        d = {"id": a["id"], "ns": s(ns, 40), "kind": s(kind, 30), "name": s(name, 80), "category": s(a.get("category"), 30), "status": s(a.get("status"), 12) or "unknown",
             "type": s((a.get("type") or {}).get("name"), 30)}
        for k in ("errors", "latency", "upstreams", "instances", "restarts", "cpu", "memory", "network", "logs"):
            v = a.get(k) or {}
            d[k] = s(v.get("value"), 40)
        bad = ["%s: %s" % (k.replace("_", " "), s((a.get(k) or {}).get("value"), 30) or (a.get(k) or {}).get("status")) for k in CHECKS if (a.get(k) or {}).get("status") in ("warning", "critical")]
        d["why"] = s("; ".join(bad), 120)
        d["failing"] = len(bad)
        d["checked"] = sum(1 for k in CHECKS if (a.get(k) or {}).get("status") in ("ok", "warning", "critical"))
        out.append(d)
    if rows and not out:
        raise ValueError("no application had an id")
    return out


def n_incidents(raw):
    rows = raw.get("data") if isinstance(raw, dict) else None
    if not isinstance(rows, list):
        raise ValueError("no incidents list in the answer")
    out = []
    for i in rows:
        if not isinstance(i, dict) or not isinstance(i.get("application_id"), str) or not isinstance(i.get("opened_at"), (int, float)):
            continue
        d, r = i.get("details") or {}, i.get("rca") or {}
        imp = lambda k: round(float((d.get(k) or {}).get("percentage") or 0), 1)
        res = i.get("resolved_at")
        ns, _, name = parts(i["application_id"])
        out.append({"key": s(i.get("key"), 24), "name": s(name, 80), "ns": s(ns, 40), "severity": s(i.get("severity"), 12) or "unknown",
                    "opened": int(i["opened_at"] / 1000), "resolved": int(res / 1000) if isinstance(res, (int, float)) and res else None, "avail": imp("availability_impact"), "lat": imp("latency_impact"),
                    "summary": s(r.get("short_summary"), 400), "cause": s(r.get("root_cause"), 400), "fix": s(r.get("immediate_fixes"), 400)})
    out.sort(key=lambda x: (x["resolved"] is not None, -x["opened"]))
    return out


def n_nodes(raw):
    rows = raw.get("data", {}).get("nodes") if isinstance(raw, dict) else None
    if not isinstance(rows, list):
        raise ValueError("no nodes in the answer")
    num = lambda v: int(round(v)) if isinstance(v, (int, float)) and not isinstance(v, bool) and 0 <= v <= 100000 else None
    return [{"name": s(n.get("name"), 60), "status": s((n.get("status") or {}).get("status"), 12) or "unknown", "az": s(n.get("availability_zone"), 30), "itype": s(n.get("instance_type"), 30),
             "cpu": num(n.get("cpu_percent")), "mem": num(n.get("memory_percent"))} for n in rows if isinstance(n, dict) and n.get("name")]


# ------------------------------------------------------------------ data: fresh cache, network, old copy

class Source(object):
    def __init__(self, cfg, st, fixture, fx, demos):
        self.cfg, self.st, self.fixture, self.fx, self.demos = cfg, st, fixture, fx, demos
        c = cfg["cache"]
        root = kit.cache.default_root(APP)
        ok = lambda v: isinstance(v, dict) and isinstance(v.get("rows"), list)
        self.tag = "%s|%s" % (st["base"], st["project"]) if st else "sample"
        self.fresh = kit.Cache(APP, c["ttl"], ok, root=root + "/fresh")
        self.old = kit.Cache(APP, c["stale_max"], ok, root=root + "/old")

    def project(self):
        if self.st["project"]:
            return self.st["project"]
        u = http_json(self.cfg, self.st, "/api/user", 8)
        pr = u.get("projects") if isinstance(u, dict) else None
        if not isinstance(pr, list) or not pr or not isinstance(pr[0], dict) or not PROJECT.match(str(pr[0].get("id", ""))):
            raise Fail("setup", "no project found: set COROOT_PROJECT in ~/.config/coroot/.env")
        return pr[0]["id"]

    def get(self, name, refresh=False):
        """(rows, state). rows is None when nothing can be shown."""
        key = "%s:%s" % (self.tag, name)
        norm = {"applications": n_apps, "incidents": n_incidents, "nodes": n_nodes}[name]
        if not refresh and not self.fixture:
            hit = self.fresh.get(key)
            if hit is not None:
                return hit["rows"], {"stale": None, "err": "", "cached": self.fresh.age(key) or 0}
        try:
            if "demo-offline" in self.demos:
                raise Fail("fail", "could not connect")
            if self.fixture:
                raw = self.fx[name]
                rows = norm({"data": raw if name == "incidents" else {name: raw}})
            else:
                p = "/api/project/%s/" % urllib.parse.quote(self.project(), safe="")
                path = {"applications": p + "overview/applications", "nodes": p + "overview/nodes", "incidents": p + "incidents"}[name]
                rows = norm(http_json(self.cfg, self.st, path, self.cfg["api"]["deadline_s"]))
        except Fail as e:
            return self._fallback(key, e.msg, e.kind)
        except Exception:
            return self._fallback(key, "unexpected answer")
        self.fresh.put(key, {"rows": rows})
        self.old.put(key, {"rows": rows})
        return rows, {"stale": None, "err": "", "cached": 0}

    def _fallback(self, key, why, kind="fail"):
        old = self.old.get(key)
        if old is not None:
            return old["rows"], {"stale": self.old.age(key) or 0, "err": why, "cached": 0, "kind": kind}
        return None, {"stale": None, "err": why, "cached": 0, "kind": kind}


# ------------------------------------------------------------------ rows

def back(sub="Back to the overview"):
    return kit.back_row(sub, view=kit.NOTE_VIEW)


def when(t):
    return time.strftime("%Y-%m-%d %H:%M", time.localtime(t))


def tags(fixture, st, state):
    out = []
    if fixture:
        out.append("sample data")
    elif st and st["demo"]:
        out.append("demo.coroot.com, public demo data")
    if state and state["stale"] is not None:
        out.append("old copy, %s old" % kit.fmt_duration(state["stale"]))
    return out


def banner(state):
    if state["stale"] is not None:
        return [kit.note_row("Showing an old copy", "Coroot is not answering (%s); this copy is %s old" % (state["err"], kit.fmt_duration(state["stale"])), icon="Clock", badge="OLD COPY")]
    return []


def offline_rows(state, view):
    kind = state.get("kind", "fail")
    title = {"auth": "Coroot refused the key", "setup": "Coroot is not set up"}.get(kind, "Could not reach Coroot")
    sub = {"auth": "%s. Check COROOT_API_KEY in ~/.config/coroot/.env" % state["err"], "setup": state["err"]}.get(kind, "%s. Check COROOT_URL, or try again" % state["err"])
    target = view if view in VIEWS else "overview"
    return ([back()] if view in ("apps", "incidents") else []) + [kit.note_row(title, sub, badge="OFFLINE" if kind == "fail" else "CHECK"), kit.refresh_row(target, title="Try again", subtitle="Enter to run again", pane=kit.NOTE_VIEW)]


def ratio(v):
    m = re.match(r"^(\d+)/(\d+)\Z", v or "")
    return (int(m.group(1)), int(m.group(2))) if m else None


def app_row(a, base, project):
    link = "%s/p/%s/app/%s" % (base, project, urllib.parse.quote(a["id"], safe=":")) if base and project else ""
    sub = a["why"] or " · ".join(x for x in (a["ns"], a["kind"]) if x)
    if a["why"]:
        sub = "%s · %s" % (a["ns"], sub)
    share = "%s (%s/%s): %s" % (a["name"], a["ns"], a["kind"], a["status"]) + (", latency %s" % a["latency"] if a["latency"] else "") + (", errors %s" % a["errors"] if a["errors"] else "")
    kw = dict(a_why=a["why"] or ("all checks pass" if a["status"] == "ok" else "no failing check reported"), triage_text=kit.safe_copy("Triage this Coroot service. %s in %s (%s) is %s. Failing: %s. Latency %s, errors %s. What are the likely causes and the first three things to check?" % (a["name"], a["ns"], a["kind"], a["status"], a["why"] or "none reported", a["latency"] or "unknown", a["errors"] or "none")), a_ns=a["ns"], a_kind=a["kind"], a_type=a["type"] or "-", a_latency=a["latency"] or "-", a_errors=a["errors"] or "-", a_up=a["upstreams"] or "-",
              a_inst=a["instances"] or "-", a_restarts=a["restarts"] or "none", a_net=a["network"] or "ok", share_text=kit.safe_copy(share), badges=[(a["status"].upper(), TONES.get(a["status"], ""))])
    if link:
        kw["open_url"] = link
    if a["checked"]:
        kw["tile"] = kit.safe_tile("Checks failing", a["failing"], max=a["checked"], note="of %d checks" % a["checked"], foot=a["why"] or "everything passes")
    return kit.safe_row(a["name"], sub, icon="Database" if "Database" in a["kind"] else "Activity", body="Copy summary puts this status on your clipboard.", copy=share, **kw)


def incident_row(i, base, project):
    dur = kit.fmt_duration((i["resolved"] or int(time.time())) - i["opened"])
    state = "resolved" if i["resolved"] else "OPEN"
    link = "%s/p/%s/incidents/%s" % (base, project, urllib.parse.quote(i["key"], safe="")) if base and project and i["key"] else ""
    share = "Incident %s on %s (%s): %s for %s. %s" % (i["key"], i["name"], i["severity"], state, dur, i["summary"] or "No root cause recorded.")
    kw = dict(i_app="%s / %s" % (i["ns"], i["name"]), i_sev=i["severity"], i_state=state, i_opened=when(i["opened"]), i_dur=dur, i_avail="%s%%" % i["avail"], i_lat="%s%%" % i["lat"],
              share_text=kit.safe_copy(share), badges=[(i["severity"].upper(), TONES.get(i["severity"], "")), (state.upper(), "danger" if not i["resolved"] else "success")],
              tile=kit.safe_tile("Latency impact", min(100, i["lat"]), unit="%", max=100, note="of requests slow", foot="availability impact %s%%" % i["avail"]))
    if link:
        kw["open_url"] = link
    bits = [("**Summary**\n" + i["summary"]) if i["summary"] else "", ("**Root cause**\n" + i["cause"]) if i["cause"] else "", ("**Fix now**\n" + i["fix"]) if i["fix"] else ""]
    body = "\n\n".join(x for x in bits if x) or "Coroot recorded no root cause for this incident."
    head = i["summary"].split(";")[0].strip() if i["summary"] else "%s SLO burn" % i["name"]
    kw["triage_text"] = kit.safe_copy("Triage this Coroot incident on %s (%s, %s for %s). Coroot's analysis: %s Suggest the fix order and what to verify after." % (i["name"], i["severity"], state, dur, i["summary"] or "none recorded."))
    return kit.safe_row(kit.clean_text(head, 90), "%s · %s · %s · %s" % (i["name"], when(i["opened"]), state, dur), icon="AlertCircle", body=body, copy=share, **kw)


def overview_rows(apps, incs, nodes, state, st, fixture):
    total = len(apps)
    ok = sum(1 for a in apps if a["status"] == "ok")
    bad = sum(1 for a in apps if a["status"] in ("warning", "critical"))
    rows = [kit.row("Services: %d of %d healthy" % (ok, total), "%d need attention. Enter lists them, unhealthy first" % bad, icon="Layers", nav={"view": "apps"}, badge="ALL OK" if not bad else "ATTENTION",
                    tile=kit.safe_tile("Healthy services", ok, max=total or None, note="of %d" % total, foot="%d warning or critical" % bad), body="Press Enter for the service list.")]
    if incs is not None:
        op = sum(1 for i in incs if not i["resolved"])
        rows.append(kit.row("Incidents: %d open, %d recent" % (op, len(incs)), "SLO incidents with Coroot's root cause. Enter lists them", icon="AlertCircle", nav={"view": "incidents"}, badge="OPEN" if op else "QUIET",
                            tile=kit.safe_tile("Open incidents", op, max=len(incs) or None, note="of %d recent" % len(incs), foot="SLO burn"), body="Press Enter for the incident list."))
    if nodes:
        cpus = [n["cpu"] for n in nodes if n["cpu"] is not None]
        avg = int(round(sum(cpus) / float(len(cpus)))) if cpus else 0
        rows.append(kit.row("Nodes: %d, CPU %d%% average" % (len(nodes), avg), "Enter for the table", icon="Cpu", nav={"view": "nodes"}, badge="BUSY" if avg >= 80 else "OK",
                            tile=kit.safe_tile("Average node CPU", avg, unit="%", max=100, note="%d nodes" % len(nodes), foot="memory in the table"), body="Press Enter for the node table."))
    t = tags(fixture, st, state)
    if t:
        rows[0] = dict(rows[0], kpi_badge="SAMPLE" if fixture else ("DEMO" if st and st["demo"] else "OLD COPY"), kpi_foot=kit.text("; ".join(t), 80))
    age = int(state["stale"] if state["stale"] is not None else (state.get("cached") or 0))
    rows.append(kit.row("Check again", "Enter to fetch fresh data past the cache", icon="RefreshCw", nav={"view": "overview", "arg": "refresh"}, copy=False, tile=kit.safe_tile("Data age", age, unit="s", note="Enter to refresh"),
                        body="Press Enter to fetch fresh data."))
    return rows


def build(view, word, apps, incs, nodes, state, st, fixture):
    base, proj = (st["base"], st["project_id"]) if st else ("", "")
    head = [back()] + ([kit.note_row("Sample data", "Recorded answers from the public demo, no network", icon="FileText", badge="SAMPLE")] if fixture else []) + banner(state)
    if view == "apps":
        order = {"critical": 0, "warning": 1, "info": 2, "unknown": 3, "ok": 4}
        w = word.lower()
        items = sorted([a for a in apps if not w or w in (a["name"] + " " + a["ns"] + " " + a["kind"]).lower()], key=lambda a: (order.get(a["status"], 3), a["name"]))[:50]
        return head + ([app_row(a, base, proj) for a in items] or [kit.note_row("No match", "no service matches %s" % kit.clean_text(word, 40), icon="Activity")])
    if view == "incidents":
        return head + ([incident_row(i, base, proj) for i in incs[:40]] or [kit.note_row("No incidents", "Coroot has no SLO incident in its window", icon="ShieldCheck", badge="QUIET")])
    rows = [kit.row(n["name"], "CPU %s%% · memory %s%% · %s · %s" % (n["cpu"], n["mem"], n["az"], n["itype"]), icon="Cpu", badges=[("BUSY", "warn")] if (n["cpu"] or 0) >= 80 or (n["mem"] or 0) >= 85 else None, node=n["name"], cpu=n["cpu"] or 0, mem=n["mem"] or 0, az=n["az"], itype=n["itype"]) for n in nodes]
    t = tags(fixture, st, state)
    if t and rows:
        rows[0] = dict(rows[0], subtitle=kit.text("%s · %s" % (rows[0]["subtitle"], ", ".join(t)), 200))
    return rows or [kit.note_row("No nodes", "Coroot reports no nodes", icon="Cpu")]


# ------------------------------------------------------------------ the app file, written from config.json

def _tile_bind(ind):
    pad = " " * ind
    return [pad + 'title: "{{row.kpi_label}}"', pad + 'value: "{{row.kpi_value}}"', pad + 'unit: "{{row.kpi_unit}}"', pad + 'max: "{{row.kpi_max}}"', pad + 'subtitle: "{{row.kpi_note}}"',
            pad + 'badge: "{{row.kpi_badge}}"', pad + 'footer: "{{row.kpi_foot}}"']


def _preview(fields):
    return ["kind: entity_preview", "mode: selected_row", "bind:", '  title: "{{row.title}}"', '  subtitle: "{{row.subtitle}}"', "  tiles_above:"] + _tile_bind(4) + ["  fields:"] + \
           ['    - { label: %s, value: "{{row.%s}}" }' % (l, k) for l, k in fields] + ['  body: "{{row.body}}"', "  actions:", '    - "open"', '    - "copy"', '    - "triage"']


_APPS = _preview([("WHY", "a_why"), ("NAMESPACE", "a_ns"), ("KIND", "a_kind"), ("TYPE", "a_type"), ("LATENCY", "a_latency"), ("ERRORS", "a_errors"), ("UPSTREAMS", "a_up"), ("INSTANCES", "a_inst"), ("RESTARTS", "a_restarts"), ("NETWORK", "a_net")])
_INC = _preview([("APP", "i_app"), ("SEVERITY", "i_sev"), ("STATE", "i_state"), ("OPENED", "i_opened"), ("DURATION", "i_dur"), ("AVAILABILITY", "i_avail"), ("LATENCY", "i_lat")])
_TILES = ["kind: cards", "mode: list_data", "bind:", '  layout: "tiles"'] + _tile_bind(2)
_NOTE = ["kind: markdown", "mode: selected_row", "bind:", '  title: "{{row.title}}"', '  subtitle: "{{row.subtitle}}"', '  body: "{{row.body}}"']


def _indent(lines, n):
    return [" " * n + x for x in lines]


def emit_yaml(cfg):
    app = cfg["app"]
    words = " ".join("{{scripts_dir}}/%s" % f for f in FILE_WORDS)
    L = ["# Generated by: python3 scripts/" + _SELF + " --emit-yaml (edit config.json, not this file)", "schema_version: 1", "runtime: bridge", "id: %s" % app["id"], "chip: %s" % app["chip"],
         "title: %s" % json.dumps(app["title"]), "icon: %s" % app["icon"], "description: %s" % json.dumps(app["description"]), 'placeholder_examples: ["Enter for the overview", "apps checkout", "incidents", "nodes"]',
         "emits: Generic", "args:", '  - { name: view, from: "query.word(0)", default: overview }', '  - { name: arg, from: "query.word(1)", default: "-" }', '  - { name: arg2, from: "query.word(2)", default: "-" }', "bridge:", "  command:"]
    for osn, py in (("macos", "python3"), ("linux", "python3"), ("windows", "python")):
        L.append(('    %s: "%s {{scripts_dir}}/' + _SELF + ' {{view}} {{arg}} {{arg2}} %s"') % (osn, py, words))
    L += ["  parse: json", "  timeout_seconds: %d" % app["timeout"], "presentation:", "  widget: list", "  title_field: title", "  subtitle_field: subtitle", "  view_arg: view", "  right_widget:"]
    L += _indent(_APPS, 4)
    L += ["  views:", "    overview:", "      right_widget:"] + _indent(_TILES, 8)
    L += ["    apps:", "      right_widget:"] + _indent(_APPS, 8) + ["    incidents:", "      right_widget:"] + _indent(_INC, 8)
    L += ["    nodes:", "      right_widget:", "        kind: table", "        mode: list_data", "        bind:", "          columns:", "            - { field: node, label: Node }", "            - { field: cpu, label: CPU, align: right, unit: \"%\" }",
          "            - { field: mem, label: Memory, align: right, unit: \"%\" }", "            - { field: az, label: Zone }", "            - { field: itype, label: Type }", "          sort: { field: cpu, dir: desc }"]
    L += ["    note:", "      right_widget:"] + _indent(_NOTE, 8)
    L += ["actions:", '  - { id: open, kind: url, target: row, label: "Open in Coroot", url_template: "{{row.open_url}}" }', '  - { id: copy, kind: composer, target: row, label: "Copy summary", insert: "{{row.share_text}}" }', '  - { id: triage, kind: composer, target: row, label: "Triage with AI", insert: "{{row.triage_text}}" }']
    return "\n".join(L) + "\n"


# ------------------------------------------------------------------ main

def main(argv):
    cfg = load_json("config.json")
    if "--emit-yaml" in argv:
        sys.stdout.write(emit_yaml(cfg))
        return
    words = split_args(argv)
    demos = [w for w in words if w == "demo-offline"]
    words = [w for w in words if w not in demos]
    first = words[0].lower() if words else ""
    view = first if first in VIEWS else ("apps" if first else "overview")
    rest = words[1:] if first in VIEWS else words
    word = kit.clean_text(" ".join(rest), 40)
    refresh = word == "refresh"
    if refresh:
        word = ""
    env = os.environ.get("BOLT_APP_FIXTURE")
    fixture = (env == "1") if env in ("0", "1") else bool(cfg["api"]["fixture_default"])
    fx = load_json("fixtures.json") if fixture else {}
    st = None
    if not fixture:
        try:
            st = settings(cfg)
        except Fail as e:
            kit.emit(offline_rows({"err": e.msg, "kind": e.kind, "stale": None, "cached": 0}, view))
    src = Source(cfg, st, fixture, fx, demos)
    if st and "demo-offline" not in demos:
        try:
            st["project_id"] = src.project()
        except Fail as e:
            kit.emit(offline_rows({"err": e.msg, "kind": e.kind, "stale": None, "cached": 0}, view))
    need = {"overview": ("applications", "incidents", "nodes"), "apps": ("applications",), "incidents": ("incidents",), "nodes": ("nodes",)}[view]
    with cf.ThreadPoolExecutor(max_workers=3) as ex:
        res = dict(zip(need, ex.map(lambda n: src.get(n, refresh), need)))
    state = res[need[0]][1]
    if res[need[0]][0] is None:
        kit.emit(offline_rows(state, view))
    g = lambda n: res[n][0] if n in res else None
    if view == "overview":
        kit.emit(overview_rows(g("applications"), g("incidents"), g("nodes"), state, st, fixture))
    kit.emit(build(view, word, g("applications"), g("incidents"), g("nodes"), state, st, fixture))


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
