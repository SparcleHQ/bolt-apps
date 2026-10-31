"""Builders for the row contract, and emit(). Builders raise KitError on a contract violation (an author bug that
tests and `bolt-apps check` catch); they never turn bad data into a plausible value."""
import json
import math
import re
import sys
import os

from .fmt import plain_number
from .icons_data import ICONS
from .schema import validate_rows
from .text import clean_lines, clean_text, neutralise_braces, safe_copy, text

LABEL_MAX = 14
FOOTER_MAX = 3
UNIT_MAX = 4
_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}\Z")
_NAV = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}\Z")
_FIELD = re.compile(r"^[a-z][a-z0-9_]{0,31}\Z")
_RESERVED = frozenset(("id", "title", "subtitle", "description", "icon", "body", "pane", "category", "url", "copy_text",
                       "copy_value", "nav", "actions", "badges", "kpi_label", "kpi_value", "kpi_unit", "kpi_max",
                       "kpi_note", "kpi_foot", "kpi_badge"))
DEFAULT_ICON = "Plug"


class KitError(ValueError):
    pass


def _icon(name):
    if name not in ICONS:
        raise KitError("icon %r is not in the launcher icon map (see kit/schema/icons.json)" % (name,))
    return name


def tile(label, value, unit="", max=None, note="", foot=""):
    """A KPI tile. `value` must be a finite number, or None when the thing was not read (then no tile at all:
    the launcher draws only numbers, and a tile without one shows "-" and "no value"). A string, bool, NaN or
    infinity raises KitError instead of being shown as a dash."""
    if value is None:
        return None
    n = plain_number(value)
    if n is None:
        raise KitError("tile value must be a finite number or None, got %r" % (value,))
    unit = text(unit)
    if len(unit) > UNIT_MAX:
        raise KitError("tile unit %r is longer than %d characters (the launcher cuts it)" % (unit, UNIT_MAX))
    t = {"label": text(label, 40), "value": n, "unit": unit, "max": "", "note": text(note, 80), "foot": text(foot, 80)}
    if max is not None:
        m = plain_number(max)
        if m is None:
            raise KitError("tile max must be a finite number or None")
        t["max"] = m
    return t


def action_copy(id, label, text_, safe=True):
    """A footer button that places text in the composer (Bolt never runs it). `safe` passes it through safe_copy,
    the allowlist for text a person will paste into a terminal or chat."""
    return _action(id, "composer", label, insert=safe_copy(text_) if safe else clean_lines(text_, 40, 10000), target="row")


def action_chain(id, label, target_chip, query=""):
    """A footer button that runs another app (or another view of this one) with a query."""
    return _action(id, "utility", label, target_chip=target_chip, query_template=neutralise_braces(clean_text(query, 512)))


def action_url(id, label, url_template):
    if not isinstance(url_template, str) or clean_text(url_template) != url_template.strip() or len(url_template) > 2048:
        raise KitError("url_template must be clean text up to 2048 characters")
    if not re.match(r"^https?://[A-Za-z0-9.-]+([:/?#].*)?\Z", url_template):
        raise KitError("url_template must start with http:// or https:// and a literal host: a placeholder may never supply the scheme or host")
    return _action(id, "url", label, url_template=url_template)


def _action(id, kind, label, **kw):
    if not isinstance(id, str) or not _ID.match(id):
        raise KitError("action id %r must match %s" % (id, _ID.pattern))
    lab = clean_text(label)
    if not lab or len(lab) > LABEL_MAX:
        raise KitError("action label %r must be 1 to %d characters (longer labels vanish from the footer)" % (lab, LABEL_MAX))
    a = {"id": id, "kind": kind, "label": lab}
    a.update(kw)
    return a


def kv_fields(**kw):
    """Free fields for a manifest to bind as {{row.x}}: values are cleaned text."""
    out = {}
    for k, v in kw.items():
        if not _FIELD.match(k) or k in _RESERVED:
            raise KitError("field name %r is not allowed" % k)
        out[k] = v
    return out


def chips(items, sep=", ", limit=400):
    """A comma list for a `kind: chips` field, each item cleaned so it cannot contain the separator."""
    return text(sep.join(clean_text(i).replace(",", " ") for i in items if clean_text(i)), limit)


def row(title, subtitle="", icon=DEFAULT_ICON, body="", nav=None, actions=None, tile=None, badge="", copy=True,
        badges=None, pane=None, category=None, url=None, id=None, manifest_actions=1, **fields):
    """One row. Every string is cleaned (control, bidi, zero-width, tag characters out; `{{` broken). `copy`
    True copies "title - subtitle" through safe_copy, a string/list copies that, False/nav rows copy nothing.
    A nav row has no actions. A row has at most 3 - manifest_actions footer buttons."""
    r = {"title": text(title, 160) or "Untitled", "subtitle": text(subtitle, 200), "icon": _icon(icon),
         "body": clean_lines(body)}
    if id is not None:
        if not _ID.match(str(id)):
            raise KitError("row id %r is not valid" % (id,))
        r["id"] = str(id)
    if nav is not None:
        if actions:
            raise KitError("a row with nav takes no actions: one Enter, no guessing")
        r["nav"] = _nav(nav)
        r["actions"] = []
    else:
        acts = [a for a in (actions or []) if a]
        if len(acts) > FOOTER_MAX - manifest_actions:
            raise KitError("too many footer actions: %d (the footer shows %d including the manifest's %d)" % (len(acts), FOOTER_MAX, manifest_actions))
        ids = [a["id"] for a in acts]
        if len(set(ids)) != len(ids):
            raise KitError("duplicate action ids")
        r["actions"] = acts
    if badges:
        r["badges"] = [{"label": text(b[0], 24), "tone": text(b[1], 16) if len(b) > 1 else ""} for b in badges[:4]]
    if pane:
        if not _NAV.match(pane) or ".." in pane:
            raise KitError("pane %r is not a valid view name" % pane)
        r["pane"] = pane
    if category:
        r["category"] = text(category, 64)
    if url:
        if not re.match(r"^https?://[\x21-\x7e]+\Z", url) or len(url) > 2048 or "{" in url or "}" in url:
            raise KitError("url must be a clean http(s) link")
        r["url"] = url
    tl = tile or {}
    r.update({"kpi_label": tl.get("label", ""), "kpi_value": tl.get("value", ""), "kpi_unit": tl.get("unit", ""),
              "kpi_max": tl.get("max", ""), "kpi_note": tl.get("note", ""), "kpi_foot": tl.get("foot", ""),
              "kpi_badge": text(badge, 24)})
    if nav is not None or copy is False:
        r["copy_text"] = ""
    elif copy is True:
        r["copy_text"] = safe_copy("%s - %s" % (r["title"], r["subtitle"]) if r["subtitle"] else r["title"])
    else:
        r["copy_text"] = safe_copy(copy)
    for k, v in kv_fields(**fields).items():
        r[k] = v if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) else ("" if v is None else text(str(v), 4000))
    return r


def _nav(nav):
    if nav == {"back": True}:
        return {"back": True}
    if isinstance(nav, dict) and set(nav) <= set(("view", "arg")) and isinstance(nav.get("view"), str) and _NAV.match(nav["view"]) \
            and (nav.get("arg") is None or (isinstance(nav["arg"], str) and _NAV.match(nav["arg"]) and ".." not in nav["arg"])) and ".." not in nav["view"]:
        return dict((k, v) for k, v in nav.items() if v is not None)
    raise KitError("nav must be {'back': True} or {'view': name, 'arg': token}")


def back_row(subtitle="", view=None, label="Back"):
    return row(label, subtitle, icon="arrow-left", nav={"back": True}, pane=view, copy=False)


def refresh_row(view, title="Scan again", subtitle="Enter to refresh", icon="RefreshCw"):
    return row(title, subtitle, icon=icon, nav={"view": view, "arg": "refresh"}, pane=view, copy=False)


def error_row(message, title="This app could not run"):
    return row(title, message, icon="AlertCircle", copy=False)


class Headline(object):
    """A summary line that cannot lie: all_clear is False whenever any section is unread."""
    __slots__ = ("text", "tone", "all_clear", "unread")

    def __init__(self, text_, tone, all_clear, unread):
        self.text, self.tone, self.all_clear, self.unread = text_, tone, all_clear, unread

    def __str__(self):
        return self.text


def headline(probes, findings=0, ok_text="All clear", subject="sections"):
    if not probes:
        return Headline("Nothing was read", "warn", False, [])
    """`probes` is {name: Probe} (or {name: bool ok}). Unread sections come first: "Not all read: ports, net".
    Findings next. Only when everything was read and nothing was found does it say ok_text."""
    unread = sorted(n for n, p in probes.items() if not (p if isinstance(p, bool) else p.ok))
    if unread:
        return Headline("Not all %s read: %s" % (subject, ", ".join(clean_text(u, 24) for u in unread[:6])), "warn", False, unread)
    if findings:
        return Headline("%d to look at" % findings, "warn", False, [])
    return Headline(ok_text, "ok", True, [])


def unsupported_row(os_, platforms):
    """The one row an app prints on an OS it does not support. Plain words, no stack trace."""
    return error_row("This app supports %s. This device is %s." % (", ".join(platforms), os_), title="Not available on this system")


def error_payload(problems):
    return [error_row("Output failed the row contract: %s" % "; ".join(problems[:2]))]


def emit(rows, out=None, exit=True):
    """Validate, then print the rows as compact ASCII JSON. An invalid payload prints ONE error row instead and
    exits 3 (so tests and `bolt-apps check` fail it). With exit=True (default) the process ends without
    waiting for stray threads, as the launcher expects; exit=False returns the JSON text (tests)."""
    problems = validate_rows(rows)
    code = 0
    if problems:
        rows, code = error_payload(problems), 3
    s = json.dumps(rows, separators=(",", ":"), ensure_ascii=True, allow_nan=False)
    if exit is False:
        return s
    w = out or sys.stdout
    w.write(s)
    w.flush()
    os._exit(code)
