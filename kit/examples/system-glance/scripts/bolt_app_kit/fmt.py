"""Number and time formatting. One rounding rule for display, thresholds and badges: rnd()."""
import math
import time as _time

from .text import clean_text

UNKNOWN = "unknown"


def rnd(x):
    """The one rounding rule: floor(x + 0.5). Used for every displayed number, threshold test and badge, so the
    figure on screen and the decision made from it can never disagree. (Python's round() is banker's rounding.)"""
    return int(math.floor(float(x) + 0.5))


def _num(x):
    if isinstance(x, bool) or not isinstance(x, (int, float)):
        return None  # strict: a numeric string is not a number
    try:
        f = float(x)
    except (OverflowError, ValueError):
        return None
    return f if math.isfinite(f) else None


def fmt_pct(x, decimals=0):
    """A percentage 0..100 as text, rounded by rnd(). `unknown` for a missing or non-finite value, never "0%"."""
    f = _num(x)
    if f is None:
        return UNKNOWN
    if decimals <= 0:
        return "%d%%" % rnd(f)
    k = 10 ** decimals
    return ("%." + str(decimals) + "f%%") % (rnd(f * k) / k)


_UNITS = ("B", "KB", "MB", "GB", "TB", "PB")


def fmt_bytes(n):
    """Binary sizes (1024) with a short unit: 512 B, 1.5 KB, 12 MB, 1.2 TB. Under 10 of a unit gets one decimal."""
    f = _num(n)
    if f is None or f < 0:
        return UNKNOWN
    i = 0
    while f >= 1024 and i < len(_UNITS) - 1:
        f /= 1024.0
        i += 1
    if i == 0:
        return "%d B" % rnd(f)
    if rnd(f * 10) < 100:
        v = rnd(f * 10) / 10.0
        return ("%d %s" % (v, _UNITS[i])) if v == int(v) else ("%.1f %s" % (v, _UNITS[i]))
    return "%d %s" % (rnd(f), _UNITS[i])


def fmt_duration(seconds):
    """45 s, 3 min, 2 h 5 min, 3 d 4 h. Two units at most."""
    f = _num(seconds)
    if f is None or f < 0:
        return UNKNOWN
    s = rnd(f)
    if s < 90:
        return "%d s" % s
    m = rnd(s / 60.0)
    if m < 90:
        return "%d min" % m
    h, mm = divmod(m, 60)
    if h < 48:
        return "%d h %d min" % (h, mm) if mm else "%d h" % h
    d, hh = divmod(rnd(m / 60.0), 24)
    return "%d d %d h" % (d, hh) if hh else "%d d" % d


def fmt_count(n, one=None, many=None):
    """12,345 with thousands separators; with `one` ("port") also the noun: "1 port", "3 ports"."""
    f = _num(n)
    if f is None:
        return UNKNOWN
    k = rnd(f)
    s = "{:,}".format(k)
    if one is None:
        return s
    return "%s %s" % (s, one if k == 1 else (many or one + "s"))


def fmt_time(ts, now=None, mode="relative"):
    """`relative`: just now, 12 s ago, 5 min ago, 3 h ago, 2 d ago. `clock`: 2026-10-30 14:05 UTC.
    Both are deterministic given `now`. Local time is never used (it makes output depend on the machine)."""
    f = _num(ts)
    if f is None:
        return UNKNOWN
    if mode == "clock":
        return _time.strftime("%Y-%m-%d %H:%M UTC", _time.gmtime(f))
    age = (_time.time() if now is None else float(now)) - f
    if age < 0:
        return "in the future"
    if age < 5:
        return "just now"
    return fmt_duration(age) + " ago"


def plain_number(x):
    """The number a tile carries: whole above 100, one decimal below, by rnd(). None if not a finite number."""
    f = _num(x)
    if f is None:
        return None
    if abs(f) >= 100 or f == int(f) and abs(f) < 1e15:
        return rnd(f)
    return rnd(f * 10) / 10.0


def label(s, limit=40):
    return clean_text(s, limit)
