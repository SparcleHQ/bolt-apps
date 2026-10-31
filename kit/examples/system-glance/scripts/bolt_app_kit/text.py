"""Text safety and eliding. Pure stdlib. One place for what every app needs."""
import re
import unicodedata

_DROP_CATS = frozenset(("Cs", "Co", "Cn", "Cf", "Cc"))
# Blank-filler letters the launcher also treats as hidden (user-app-actions.ts HIDDEN_CHARS), plus Braille blank.
_FILLERS = frozenset("ᅟᅠㅤﾠ⠀͏")
_MAX_MARKS = 2
_WS = re.compile(r"\s+")
ELLIPSIS = "…"


def clean_text(s, limit=None):
    """One line of plain text. Control, format (bidi, zero-width, tag), surrogate, private-use and
    unassigned characters are removed; tabs, newlines and line/paragraph separators become spaces;
    blank fillers become spaces; stacked combining marks are capped at 2; whitespace collapses.
    Non-strings give "". `limit` elides the end (never use it for hosts: see host_label)."""
    if not isinstance(s, str):
        return ""
    out = []
    marks = 0
    for ch in s:
        cat = unicodedata.category(ch)
        if ch in "\t\n\r\x0b\x0c" or cat in ("Zl", "Zp", "Zs") or ch in _FILLERS:
            out.append(" ")
            marks = 0
        elif cat in _DROP_CATS:
            continue
        elif cat == "Mn" or cat == "Me" or cat == "Mc":
            if not out or out[-1] == " ":
                continue  # a mark with nothing to attach to
            marks += 1
            if marks <= _MAX_MARKS:
                out.append(ch)
        else:
            marks = 0
            out.append(ch)
    t = _WS.sub(" ", "".join(out)).strip()
    return elide_end(t, limit) if limit is not None else t


def clean_lines(s, max_lines=40, limit=8000):
    """Multi-line text (a markdown body): each line goes through clean_text, blank lines kept as
    paragraph breaks (at most one in a row), capped by lines and characters."""
    if not isinstance(s, str):
        return ""
    lines, blank = [], False
    for raw in s.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        t = clean_text(raw)
        if t:
            lines.append(t)
            blank = False
        elif lines and not blank:
            lines.append("")
            blank = True
    return neutralise_braces("\n".join(lines[:max_lines]).strip())[:limit]


def neutralise_braces(s):
    """Break up every `{{` and `}}` so the launcher cannot expand row text as a template. Idempotent."""
    return re.sub(r"\}(?=\})", "} ", re.sub(r"\{(?=\{)", "{ ", s))


def text(s, limit=None):
    """clean_text + neutralise_braces: the default for any string that goes into a row. Braces are broken
    first and the limit applied after, so the result never exceeds `limit`."""
    t = neutralise_braces(clean_text(s))
    return elide_end(t, limit) if limit is not None else t


def elide_end(s, n):
    """Cut to at most n characters, ending in an ellipsis. Not for hosts or origins."""
    if n is None or len(s) <= n:
        return s
    if n <= 1:
        return ELLIPSIS[:n]
    return s[: n - 1].rstrip() + ELLIPSIS


def elide_left(s, n):
    """Keep the END (paths, file names). At most n characters, starting with an ellipsis."""
    if n is None or len(s) <= n:
        return s
    if n <= 1:
        return ELLIPSIS[:n]
    return ELLIPSIS + s[-(n - 1):].lstrip()


_SLD = frozenset(("co", "com", "org", "net", "gov", "edu", "ac", "or", "ne", "go"))
# Hosting suffixes where the next label to the left is the owner (not a full public suffix list).
_PRIVATE_SUFFIX = frozenset(("github.io", "pages.dev", "blogspot.com", "herokuapp.com", "vercel.app", "netlify.app",
                             "workers.dev", "appspot.com", "azurewebsites.net", "cloudfront.net", "web.app", "firebaseapp.com"))
_V4 = re.compile(r"^\d{1,3}(\.\d{1,3}){3}$")


def _host_of(raw):
    s = clean_text(raw).strip().lower()
    s = re.sub(r"^[a-z][a-z0-9+.-]*://", "", s)
    s = re.split(r"[/?#\\]", s, maxsplit=1)[0]
    s = s.rsplit("@", 1)[-1]  # userinfo can never decide what the host looks like
    if s.startswith("["):
        return s.split("]", 1)[0] + "]"
    return re.sub(r":\d*$", "", s).rstrip(".")


HOST_TOO_LONG = "(host too long)"


def host_full(origin):
    """The whole cleaned host, for a tooltip or a separate field next to a shortened host_label."""
    return _host_of(origin)


def host_label(origin, max_len=32):
    """A host or origin for display, within max_len. Never cut inside a label: the whole host if it fits, else
    whole leading labels are dropped (marked with an ellipsis) and the registrable domain (example.com,
    example.co.uk, owner.github.io) is always kept whole. If even that does not fit, the fixed marker
    "(host too long)" is returned and the caller shows host_full() elsewhere. So `login.example.com.evil.net`
    can never read as `login.example.com...`, and a punycode or look-alike host is never cut mid-label.
    Userinfo, scheme, port and path are removed."""
    h = _host_of(origin)
    if not h:
        return ""
    if len(h) <= max_len:
        return h
    if _V4.match(h) or h.startswith("["):
        return HOST_TOO_LONG
    labels = h.split(".")
    keep = 3 if len(labels) >= 3 and ((len(labels[-1]) == 2 and labels[-2] in _SLD) or ".".join(labels[-2:]) in _PRIVATE_SUFFIX) else 2
    cur = labels
    while len(cur) > keep:
        cur = cur[1:]
        cand = ELLIPSIS + ".".join(cur)
        if len(cand) <= max_len:
            return cand
    reg = ".".join(labels[-keep:])
    return reg if len(reg) <= max_len else HOST_TOO_LONG


# ---- text that is copied to the clipboard (port of bolt_safenet.safe_text / copy_value / copy_ok) ----
_ALLOWED_PUNCT = frozenset(".,:_-/@+%'\"#?*=~^[]")
_BRACKETS = {ord("("): "[", ord(")"): "]", ord("{"): "[", ord("}"): "]"}


def _copy_char_ok(ch):
    c = unicodedata.category(ch)
    return ch == " " or ch in _ALLOWED_PUNCT or c[0] in ("L", "M") or c == "Nd"


def safe_text(s, cap=300):
    """Allowlist for text a person will paste into a terminal or chat: NFKC, then letters, digits, marks,
    the ASCII space and . , : _ - / @ + % ' " # ? * = ~ ^ [ ]. Parentheses and braces become brackets.
    Everything else (; | & < > $ ! backslash, backtick, every control, format and bidi character) becomes
    a space. A word starting with = is stripped (zsh expands it). Whitespace collapses."""
    s = unicodedata.normalize("NFKC", clean_text(str(s))).translate(_BRACKETS)
    keep = "".join(ch if _copy_char_ok(ch) else " " for ch in s)
    keep = re.sub(r"(^|(?<= ))=+", "", keep)
    return " ".join(keep.split())[:cap].strip()


def safe_copy(lines, cap=300):
    """Clipboard text: one bullet per line ("- " first, so the first shell token is `-`, never a command).
    `lines` is a string, or a list of strings; a ("sub", text) tuple is indented under its bullet. Every
    line is safe_text output. Fails closed if the result does not pass copy_ok."""
    if isinstance(lines, str):
        lines = [lines]
    out = []
    for item in lines:
        sub = isinstance(item, tuple)
        t = safe_text(item[1] if sub else item, cap)
        if t:
            out.append(("-   " if sub else "- ") + t)
    v = "\n".join(out)
    return v if copy_ok(v) else "- Copy blocked: text failed the safety check"


def copy_ok(v):
    return bool(v) and all(ln.startswith("- ") and all(_copy_char_ok(ch) for ch in ln) for ln in v.split("\n"))
