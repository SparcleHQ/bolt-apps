#!/usr/bin/env python3
"""Thin entry for the shared Bolt App engine (kit/python/bolt_app_engine.py). Nothing to edit here: edit config.json and fixtures.json.

The engine is kept once in the toolkit. `bolt-apps pack` puts it in the pack beside this file as <app id>__bolt_app_engine.py
(Bolt installs every script into one folder, so a pack must carry what it runs). Beside the toolkit (check, run, new) it is found by the
BOLT_APPS_ENGINE_FILE the toolkit sets, or in the clone this folder sits in.
Usage: engine.py <view> <arg>  |  engine.py --emit-yaml"""
import os as _os

_HERE = _os.path.dirname(_os.path.abspath(__file__))
_PATH = _os.path.join(_HERE, _os.path.basename(__file__).partition("__")[0] + "__bolt_app_engine.py")   # a pack: beside this file, named for the app
if not _os.path.isfile(_PATH):   # the toolkit (never an installed app: a pack always has the file beside the script)
    _ENV = _os.environ.get("BOLT_APPS_ENGINE_FILE", "")
    _PATH = _ENV if _os.path.basename(_ENV) == "bolt_app_engine.py" and _os.path.isfile(_ENV) else ""
    _D = _HERE
    for _ in range(6):
        if _PATH:
            break
        _D = _os.path.dirname(_D)
        if _os.path.isfile(_os.path.join(_D, "kit", "python", "bolt_app_engine.py")):
            _PATH = _os.path.join(_D, "kit", "python", "bolt_app_engine.py")
    if not _PATH:
        raise SystemExit("the shared engine file is not beside this script. Re-pack the app with ./bolt-apps pack, or run it through ./bolt-apps check or run.")
_THIN_ENTRY = True
with open(_PATH, encoding="utf-8") as _F:
    exec(compile(_F.read(), _PATH, "exec"), globals())   # the engine runs as this script: same __file__, __name__ and config beside it
