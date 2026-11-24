#!/usr/bin/env python3
"""=unit-convert: type an amount, pick two units, get a result detail. A copyable layout example: typed input, result in a detail pane.

What it shows, in code you can read top to bottom:
  - a form in the app file (inputs: number and two selects) that the launcher passes to this script as words
  - the input checked again here (a number, two known units, the same kind of unit), with one plain row for a bad value
  - a result row first, then the same amount in the other units of that kind, all drawn by one detail pane
  - a Copy button (into the composer) with the result as plain text
It makes no network call and reads no file but its own config.json (the unit table). Edit config.json to add units."""
import os as _os
import sys as _sys

_sys.dont_write_bytecode = True   # Bolt installs the script folder as it is: no __pycache__ in it
_SELF = _os.path.basename(__file__)
_PFX = _SELF.partition("__")[0] + "__" if "__" in _SELF else ""   # Bolt keeps every app's scripts in ONE folder, so each file of this app is named <app id>__<name>
import importlib.util as _ilu
KIT_API = 1   # the kit interface this app was written for; Bolt's shared kit must offer the same
KIT_MIN = (0, 3, 10)   # with WANT_SHARED: the oldest shared kit this app accepts
WANT_SHARED = False   # True: prefer Bolt's shared kit (when it verifies and is new enough) over this app's own copy
_KIT_DIR = _os.path.dirname(_os.path.abspath(__file__))


def _load_kit_bytes(data, origin):
    import types
    mod = types.ModuleType("bolt_app_kit")
    mod.__file__ = origin
    _sys.modules["bolt_app_kit"] = mod
    try:
        exec(compile(data, origin, "exec"), mod.__dict__)
    except BaseException:
        _sys.modules.pop("bolt_app_kit", None)
        raise
    return mod


def _abs_dir(d, nt=_os.name == "nt"):
    """An absolute local folder. On Windows that means a drive letter and a root: a rooted path with no drive (it would follow the current drive) and a network share are refused."""
    if nt:
        import ntpath
        return bool(ntpath.splitdrive(d)[0]) and d[:1] not in "\\/" and ntpath.isabs(d)
    return _os.path.isabs(d)


def _shared_kit(own_path):
    """Bolt's shared kit, verified, or None. Never raises: any doubt means use the app's own copy (a real Ctrl-C still stops the app)."""
    d = _os.environ.get("BOLT_APP_SHARED_DIR")
    if not d or not _abs_dir(d):
        return None
    try:
        import hashlib, json
        def plain(p):
            return _os.path.isfile(p) and not _os.path.islink(p) and _os.path.getsize(p) <= 8 * 1024 * 1024
        mp = _os.path.join(d, "manifest.json")
        if not plain(mp):
            return None
        with open(mp, "rb") as f:
            m = json.loads(f.read().decode("utf-8"))
        k = m["kit"]
        name, want, ver = k["file"], k["sha256"], k["version"]
        if m.get("format") != 1 or k.get("api") != KIT_API or name != _os.path.basename(name) or not name.endswith(".py"):
            return None
        sp = _os.path.join(d, name)
        if not plain(sp):
            return None
        with open(sp, "rb") as f:
            data = f.read()
        have = hashlib.sha256(data).hexdigest()
        if have != want:
            return None
        same = False
        if _os.path.isfile(own_path):
            with open(own_path, "rb") as f:
                same = hashlib.sha256(f.read()).hexdigest() == have
        if not same and not (WANT_SHARED and tuple(int(x) for x in ver.split(".")) >= KIT_MIN):
            return None
        if not data.startswith(('"""bolt_app_kit %s, ' % ver).encode("utf-8")):
            return None   # the file does not say it is the version the manifest names: do not run it
        mod = _load_kit_bytes(data, sp)
        if getattr(mod, "__version__", None) != ver:
            _sys.modules.pop("bolt_app_kit", None)
            return None
        return mod
    except KeyboardInterrupt:
        raise   # the person pressed Ctrl-C: stop, do not carry on with another copy
    except BaseException:   # including SystemExit raised by the kit at import: the app's own copy still runs
        _sys.modules.pop("bolt_app_kit", None)
        return None


_own_kit = _os.path.join(_KIT_DIR, _PFX + "bolt_app_kit.py")   # the kit sits beside the script under this app's own name (python -I drops the script folder from the path, so it is loaded by path)
kit = _sys.modules.get("bolt_app_kit")   # already imported: the test suite does this; a normal run never has
if kit is None:
    kit = _shared_kit(_own_kit)
if kit is None and _os.path.exists(_own_kit):
    _spec = _ilu.spec_from_file_location("bolt_app_kit", _own_kit)
    kit = _ilu.module_from_spec(_spec)
    _sys.modules["bolt_app_kit"] = kit
    _spec.loader.exec_module(kit)
elif kit is None and _os.path.isdir(_os.path.join(_KIT_DIR, "bolt_app_kit")):   # a bolt_app_kit package folder beside the script
    _sys.path.insert(0, _KIT_DIR)
    import bolt_app_kit as kit
elif kit is None:
    raise SystemExit("script files must be named <app id>__<name>: this one is %s and %s was not found beside it. Rename the files back, and do not run the script through a link." % (_SELF, _PFX + "bolt_app_kit.py"))

import decimal
import json
import math
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
FILE_WORDS = tuple(_PFX + w for w in ("config.json", "bolt_app_kit.py",))   # the helper files the bridge command names, so Bolt shows them in the approval
NUMBER = re.compile(r"^[+-]?([0-9]{1,15})(\.[0-9]{1,12})?([eE][+-]?[0-9]{1,3})?\Z")
MAX_AMOUNT = 1e15   # a bigger amount is refused: the answer would be noise
MAX_RESULT = 1e30
ABSOLUTE_ZERO_C = {"C": -273.15, "F": -459.67, "K": 0.0}   # the lowest value of each temperature unit


def load_json(name):
    with open(os.path.join(HERE, _PFX + name), "r", encoding="utf-8") as f:
        return json.load(f)


def split_args(argv):
    a = list(argv[1:])
    n = len(FILE_WORDS)
    if len(a) >= n and [os.path.basename(x) for x in a[-n:]] == list(FILE_WORDS):
        a = a[:-n]
    return a


def kind_of(cfg, unit):
    return next((k for k, u in cfg["units"].items() if unit in u), None)


def to_celsius(v, unit):
    return v if unit == "C" else ((v - 32) * 5 / 9 if unit == "F" else v - 273.15)


def from_celsius(c, unit):
    return c if unit == "C" else (c * 9 / 5 + 32 if unit == "F" else c + 273.15)


def convert(cfg, v, a, b):
    """The value in unit b, and the formula as a sentence. Raises ValueError for units of different kinds."""
    ka, kb = kind_of(cfg, a), kind_of(cfg, b)
    if ka is None or ka != kb:
        raise ValueError("different kinds")
    if ka == "temperature":
        f = cfg["temperature_formulas"].get("%s>%s" % (a, b), "same unit")
        return from_celsius(to_celsius(v, a), b), f
    table = cfg["units"][ka]
    ratio = table[a] / table[b]
    return v * ratio, "multiply by %s" % num(ratio)


def num(x):
    """Six significant digits with no exponent for ordinary sizes (Decimal expands it properly), no trailing zeros, no -0.
    Below 1e-15 or from 1e15 up it keeps a clean scientific form such as 1.23457e+21."""
    if x == 0:
        return "0"
    s = "%.6g" % x
    if 1e-15 <= abs(x) < 1e15:
        s = format(decimal.Decimal(s), "f")
        if "." in s:
            s = s.rstrip("0").rstrip(".")
    return "0" if s in ("-0", "0") else s


def row_for(v, a, b, label=None, primary=False, cfg=None):
    out, formula = convert(cfg, v, a, b)
    reverse, _ = convert(cfg, 1, b, a)
    title = "%s %s = %s %s" % (num(v), a, num(out), b)
    return kit.row(title, formula, icon="arrow-left-right", copy_raw=title, badge="RESULT" if primary else "",
                   conv_result="%s %s" % (num(out), b), conv_formula=formula, conv_reverse="1 %s = %s %s" % (b, num(reverse), a),
                   conv_kind=kind_of(cfg, a))


def build(cfg, words):
    if len(words) != 3:
        return [kit.row("Fill the form", "an amount, then the unit to convert from and to", icon="Calculator", copy=False)]
    amount, a, b = words
    if not NUMBER.match(amount):
        return [kit.row("Not converted", "the amount must be a number, for example 12.5", icon="AlertCircle", copy=False)]
    v = float(amount)
    if not math.isfinite(v):
        return [kit.row("Not converted", "that number is too large", icon="AlertCircle", copy=False)]
    if abs(v) > MAX_AMOUNT:
        return [kit.row("Not converted", "that number is too large (up to 1e15)", icon="AlertCircle", copy=False)]
    if kind_of(cfg, a) is None or kind_of(cfg, b) is None:
        return [kit.row("Not converted", "pick units from the lists", icon="AlertCircle", copy=False)]
    if kind_of(cfg, a) != kind_of(cfg, b):
        return [kit.row("Not converted", "%s is a %s and %s is a %s: pick two of the same kind" % (a, kind_of(cfg, a), b, kind_of(cfg, b)), icon="AlertCircle", copy=False)]
    if kind_of(cfg, a) == "temperature" and v < ABSOLUTE_ZERO_C[a]:
        return [kit.row("Not converted", "%s %s is below absolute zero" % (num(v), a), icon="AlertCircle", copy=False)]
    for other in [b] + [u for u in cfg["units"][kind_of(cfg, a)] if u not in (a, b)]:
        out, _ = convert(cfg, v, a, other)
        if not math.isfinite(out) or abs(out) > MAX_RESULT:
            return [kit.row("Not converted", "the result is too large", icon="AlertCircle", copy=False)]
    rows = [row_for(v, a, b, primary=True, cfg=cfg)]
    for other in cfg["units"][kind_of(cfg, a)]:
        if other not in (a, b):
            rows.append(row_for(v, a, other, cfg=cfg))
    return rows


def emit_yaml(cfg):
    app = cfg["app"]
    words = " ".join("{{scripts_dir}}/%s" % f for f in FILE_WORDS)
    opts = ", ".join(json.dumps(u) for k in cfg["units"] for u in cfg["units"][k])
    L = ["# Generated by: python3 scripts/" + _SELF + " --emit-yaml (edit config.json, not this file)", "schema_version: 1", "runtime: bridge", "id: %s" % app["id"], "chip: %s" % app["chip"],
         "title: %s" % json.dumps(app["title"]), "icon: %s" % app["icon"], "description: %s" % json.dumps(app["description"]),
         'placeholder_examples: ["Fill the form and press Convert"]', "emits: Generic", "inputs:",
         '  - { name: "amount", type: "number", label: "Amount", required: true, placeholder: "12.5" }',
         '  - { name: "unit_from", type: "select", label: "From", default: %s, options: [%s] }' % (json.dumps(cfg["default_from"]), opts),
         '  - { name: "unit_to", type: "select", label: "To", default: %s, options: [%s] }' % (json.dumps(cfg["default_to"]), opts),
         "submit:", '  label: "Convert"', "bridge:", "  command:"]
    for osn, py in (("macos", "python3"), ("linux", "python3")):
        L.append(('    %s: "%s {{scripts_dir}}/' + _SELF + ' {{amount}} {{unit_from}} {{unit_to}} %s"') % (osn, py, words))
    L += ["  parse: json", "  timeout_seconds: 10", "presentation:", "  widget: list", "  title_field: title", "  subtitle_field: subtitle", "  right_widget:",
          "    kind: detail", "    mode: selected_row", "    bind:", '      title: "Conversion"', '      subtitle: "{{row.title}}"', "      fields:",
          '        - { label: "Result", value: "{{row.conv_result}}", copy: true }', '        - { label: "Formula", value: "{{row.conv_formula}}" }',
          '        - { label: "Reverse", value: "{{row.conv_reverse}}" }', '        - { label: "Kind", value: "{{row.conv_kind}}" }',
          "actions:", '  - { id: copy, kind: composer, target: row, label: Copy, insert: "{{row.copy_text}}" }']
    return "\n".join(L) + "\n"


def main(argv):
    cfg = load_json("config.json")
    if "--emit-yaml" in argv:
        sys.stdout.write(emit_yaml(cfg))
        return
    kit.emit(build(cfg, split_args(argv)))


def run(argv):
    try:
        main(argv)
    except SystemExit:
        raise
    except kit.KitError as e:
        kit.emit([kit.error_row("Row contract: %s" % kit.clean_text(str(e), 200), title="This app could not run")])
    except Exception as e:   # one plain row: never a traceback
        if os.environ.get("BOLT_APP_DEBUG"):
            import traceback
            traceback.print_exc()
        kit.emit([kit.error_row("%s while building the rows. Run the script in a terminal to see why." % e.__class__.__name__)])


if __name__ == "__main__":
    run(sys.argv)
