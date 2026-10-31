"""A small JSON Schema checker for the row contract (the subset row.schema.json uses). Stdlib only."""
import json
import os
import re

_HERE = os.path.dirname(os.path.abspath(__file__))


def load_schema():
    with open(os.path.join(_HERE, "row_schema.json"), "r", encoding="utf-8") as f:
        return json.load(f)


def _ref(root, ref):
    node = root
    for part in ref.lstrip("#/").split("/"):
        node = node[part]
    return node


def _type_ok(v, t):
    if t == "string":
        return isinstance(v, str)
    if t == "number":
        return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and v not in (float("inf"), float("-inf"))
    if t == "boolean":
        return isinstance(v, bool)
    if t == "object":
        return isinstance(v, dict)
    if t == "array":
        return isinstance(v, list)
    return True


def check(value, schema, root, path="$"):
    """Return a list of "path: problem" strings. Empty list = valid."""
    if "$ref" in schema:
        return check(value, _ref(root, schema["$ref"]), root, path)
    errs = []
    if "const" in schema and (value != schema["const"] or type(value) is not type(schema["const"])):
        return ["%s: must be %r" % (path, schema["const"])]
    if "enum" in schema and value not in schema["enum"]:
        return ["%s: %r is not one of the allowed values" % (path, value if not isinstance(value, str) else value[:40])]
    if "oneOf" in schema:
        good = sum(1 for s in schema["oneOf"] if not check(value, s, root, path))
        if good != 1:
            return ["%s: does not match exactly one allowed shape" % path]
    t = schema.get("type")
    if t and not _type_ok(value, t):
        return ["%s: must be %s" % (path, t)]
    if isinstance(value, str):
        if "minLength" in schema and len(value) < schema["minLength"]:
            errs.append("%s: shorter than %d" % (path, schema["minLength"]))
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            errs.append("%s: longer than %d characters" % (path, schema["maxLength"]))
        if "pattern" in schema and not re.search(schema["pattern"].replace("$", "\\Z") if schema["pattern"].endswith("$") else schema["pattern"], value):
            errs.append("%s: does not match %s" % (path, schema["pattern"]))
    if isinstance(value, list):
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            errs.append("%s: more than %d items" % (path, schema["maxItems"]))
        if "minItems" in schema and len(value) < schema["minItems"]:
            errs.append("%s: fewer than %d items" % (path, schema["minItems"]))
        if "items" in schema:
            for i, it in enumerate(value):
                errs += check(it, schema["items"], root, "%s[%d]" % (path, i))
    if isinstance(value, dict):
        for r in schema.get("required", []):
            if r not in value:
                errs.append("%s: missing %s" % (path, r))
        props = schema.get("properties", {})
        for k, v in value.items():
            if k in props:
                errs += check(v, props[k], root, "%s.%s" % (path, k))
            elif schema.get("additionalProperties") is False:
                errs.append("%s: unknown field %s" % (path, k))
            elif isinstance(schema.get("additionalProperties"), dict):
                errs += check(v, schema["additionalProperties"], root, "%s.%s" % (path, k))
    return errs


def validate_rows(rows, manifest_actions=1):
    """Schema check plus the rules a JSON Schema cannot say: a tile with text needs a number, the footer count
    including the manifest's actions, and a nav row carries no actions. Same rules as `bolt-apps check`."""
    root = load_schema()
    errs = check(rows, root, root)
    if isinstance(rows, list):
        for i, r in enumerate(rows):
            if not isinstance(r, dict):
                continue
            acts = r.get("actions") if isinstance(r.get("actions"), list) else []
            if len(acts) > 3 - manifest_actions:
                errs.append("$[%d]: %d footer buttons; the footer shows 3 including the manifest's %d" % (i, len(acts), manifest_actions))
            if r.get("nav") and acts:
                errs.append("$[%d]: a row with nav must not carry actions" % i)
            tile_text = any(r.get(k) not in (None, "") for k in ("kpi_label", "kpi_unit", "kpi_max", "kpi_note", "kpi_foot"))
            v = r.get("kpi_value")
            if tile_text and (isinstance(v, bool) or not isinstance(v, (int, float))):
                errs.append("$[%d]: a tile needs a numeric kpi_value" % i)
    return errs
