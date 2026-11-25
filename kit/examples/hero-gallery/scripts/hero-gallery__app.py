#!/usr/bin/env python3
"""=hero-gallery: a list of pictures; the preview pane shows the selected one full width at the top (the entity_preview `hero`, Bolt 182 and later).

What it shows, in code you can read top to bottom:
  - the pictures are drawn here with the standard library (no network, no picture file): small PNGs made from integers, so the output is the same everywhere
  - kit.hero_fields() turns the picture bytes into the row fields img1..imgN (a row text field is cut at 4,000 characters; the kit splits the picture and checks the 1 MiB and 16 part limits)
  - kit.hero_src_template(n) is the app file's hero src: "{{row.img1}}{{row.img2}}..."
  - a picture that is refused (too big) leaves the row without a hero: the pane is drawn as it was, nothing breaks
  - one row has no picture on purpose, to show the pane without a hero
Needs Bolt 182: a Bolt 0.1.181 refuses a whole pack that uses `hero`, so bolt-app.json says min_bolt_version 0.1.182."""
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

import json
import os
import struct
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
FILE_WORDS = tuple(_PFX + w for w in ("config.json", "bolt_app_kit.py",))   # the helper files the bridge command names, so Bolt shows them in the approval
MAX_PARTS = kit.HERO_MAX_PARTS   # the hero src may join at most 16 references (about 47 KB of picture)


load_json = kit.json_loader(HERE, _PFX)


def png(width, height, pixel):
    """A PNG (8-bit RGB) from pixel(x, y) -> (r, g, b). Plain zlib and struct: no picture library."""
    raw = bytearray()
    for y in range(height):
        raw.append(0)
        for x in range(width):
            raw.extend(pixel(x, y))

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")


def draw(p):
    """The picture's bytes, from its entry in config.json. Integer maths only, so it is the same on every machine."""
    w, h = p["width"], p["height"]
    if p["kind"] == "vertical gradient":
        a, b = p["from"], p["to"]
        g = p.get("grain", 0)   # a little repeatable noise, so the picture is big enough to need several row fields

        def pixel(x, y):
            n = (x * 73856093 ^ y * 19349663) & 0xFFFF   # an integer hash: the same on every machine
            return tuple(max(0, min(255, a[i] + (b[i] - a[i]) * y // (h - 1) + (((n >> (3 * i)) % (2 * g + 1)) - g if g else 0))) for i in range(3))
        return png(w, h, pixel)
    if p["kind"] == "diagonal stripes":
        cols, band = p["colors"], p["band"]
        return png(w, h, lambda x, y: tuple(cols[((x + y) // band) % len(cols)]))
    cols, ring = p["colors"], p["ring"]   # rings around the middle
    cx, cy = w // 2, h // 2
    return png(w, h, lambda x, y: tuple(cols[(int(((x - cx) ** 2 + (y - cy) ** 2) ** 0.5) // ring) % len(cols)]))


def picture_row(cfg, p):
    """One row: the text, and the picture as img1..imgN plus its alt, caption and credit. A picture the kit refuses leaves the row without them (no hero, same pane)."""
    extra = {}
    try:
        extra.update(kit.hero_fields(draw(p)))
        extra.update(hero_alt=p["alt"], hero_caption=p["caption"], hero_credit=cfg["credit"])
    except kit.KitError:
        extra = {}
    return kit.row(p["title"], p["subtitle"], icon="Image", body="%s. The picture above is drawn by the script, %d by %d pixels." % (p["kind"].capitalize(), p["width"], p["height"]),
                   badge="CC0", **extra)


def build(cfg):
    rows = [picture_row(cfg, p) for p in cfg["pictures"]]
    rows.append(kit.row("No picture", "a row without a picture: the pane shows no hero", icon="Image", body="This row has no img fields, so hero.src is empty and the pane is drawn as it was before Bolt 182.", badge="TEXT"))
    return rows


def emit_yaml(cfg):
    app = cfg["app"]
    words = " ".join("{{scripts_dir}}/%s" % f for f in FILE_WORDS)
    n = max(len([k for k in picture_row(cfg, p) if k.startswith("img")]) for p in cfg["pictures"])
    src = kit.hero_src_template(n)
    L = ["# Generated by: python3 scripts/" + _SELF + " --emit-yaml (edit config.json, not this file)", "schema_version: 1", "runtime: bridge", "id: %s" % app["id"], "chip: %s" % app["chip"],
         "title: %s" % json.dumps(app["title"]), "icon: %s" % app["icon"], "description: %s" % json.dumps(app["description"]),
         'placeholder_examples: ["Press Enter to see the pictures"]', "emits: Generic", "bridge:", "  command:"]
    for osn, py in (("macos", "python3"), ("linux", "python3")):
        L.append(('    %s: "%s {{scripts_dir}}/' + _SELF + ' %s"') % (osn, py, words))
    L += ["  parse: json", "  timeout_seconds: 10", "presentation:", "  widget: list", "  title_field: title", "  subtitle_field: subtitle", "  right_widget:",
          "    kind: entity_preview", "    mode: selected_row", "    bind:", "      hero:", '        src: "%s"' % src, '        alt: "{{row.hero_alt}}"', '        caption: "{{row.hero_caption}}"',
          '        credit: "{{row.hero_credit}}"', '      title: "{{row.title}}"', '      subtitle: "{{row.subtitle}}"', '      body: "{{row.body}}"', "      actions: [copy]",
          "actions:", '  - { id: copy, kind: composer, target: row, label: Copy, insert: "{{row.title}}" }']
    return "\n".join(L) + "\n"


def main(argv):
    cfg = load_json("config.json")
    if "--emit-yaml" in argv:
        sys.stdout.write(emit_yaml(cfg))
        return
    kit.emit(build(cfg))


if __name__ == "__main__":
    kit.run_guarded(main, sys.argv, debug=bool(os.environ.get("BOLT_APP_DEBUG")))
