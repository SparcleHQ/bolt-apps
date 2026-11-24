// bolt-apps check (script apps): run an app's script the way the launcher does, against recorded command output.
// Built: clean subprocess with a minimal environment and a temp HOME; stub commands on a controlled PATH;
// per-OS fixture sets (--os); hung-command mode with a total-time assertion; hostile-data fuzz; golden snapshots;
// schema validation of every output; footer button and label limits; the numeric tile rule; text safety scan;
// vendored-kit divergence guard. Not built: see docs/kit-design.md, section 5, "Not built".
import fs from 'node:fs';
import { RULES, parseBoltVersion } from './boltrules.mjs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { ENGINE_SRC, thinAppDir } from './engine.mjs';
import { fileURLToPath } from 'node:url';
import { pythonCmd } from './python.mjs';
import { isNavToken, assessYaml } from './assess.mjs';
import { parseYaml, get, str, notYamlHint } from './yamlsubset.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const KIT_ROOT = path.resolve(here, '..', '..', 'kit');
export const KIT_PY = path.join(KIT_ROOT, 'python', 'bolt_app_kit');
const SCHEMA = JSON.parse(fs.readFileSync(path.join(KIT_ROOT, 'schema', 'row.schema.json'), 'utf8'));
export const OSES = ['macos', 'linux', 'windows'];
const PY_PLATFORM = { macos: 'darwin', linux: 'linux', windows: 'win32' };
export const hostOs = () => ({ darwin: 'macos', linux: 'linux', win32: 'windows' })[process.platform] || 'other';
const BRIDGE_LIMIT_S = 20, DEFAULT_MAX_S = 18;

// ---- the JSON Schema subset row.schema.json uses ----
const resolve = (root, ref) => ref.replace(/^#\//, '').split('/').reduce((n, k) => n[k], root);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const typeOk = (v, t) => t === 'string' ? typeof v === 'string' : t === 'number' ? isNum(v) : t === 'boolean' ? typeof v === 'boolean' : t === 'object' ? v !== null && typeof v === 'object' && !Array.isArray(v) : t === 'array' ? Array.isArray(v) : true;
export function schemaCheck(v, s, root = SCHEMA, p = '$') {
	if (s.$ref) return schemaCheck(v, resolve(root, s.$ref), root, p);
	if ('const' in s && v !== s.const) return [`${p}: must be ${JSON.stringify(s.const)}`];
	if (s.enum && !s.enum.includes(v)) return [`${p}: ${JSON.stringify(String(v).slice(0, 40))} is not one of the allowed values`];
	if (s.oneOf) return s.oneOf.filter((o) => !schemaCheck(v, o, root, p).length).length === 1 ? [] : [`${p}: does not match exactly one allowed shape`];
	if (s.type && !typeOk(v, s.type)) return [`${p}: must be ${s.type}`];
	const e = [];
	if (typeof v === 'string') {
		const n = [...v].length;
		if (s.minLength != null && n < s.minLength) e.push(`${p}: shorter than ${s.minLength}`);
		if (s.maxLength != null && n > s.maxLength) e.push(`${p}: longer than ${s.maxLength} characters`);
		if (s.pattern && !new RegExp(s.pattern).test(v)) e.push(`${p}: does not match ${s.pattern}`);
	}
	if (Array.isArray(v)) {
		if (s.maxItems != null && v.length > s.maxItems) e.push(`${p}: more than ${s.maxItems} items`);
		if (s.minItems != null && v.length < s.minItems) e.push(`${p}: fewer than ${s.minItems} items`);
		if (s.uniqueItems && new Set(v.map((x) => JSON.stringify(x))).size !== v.length) e.push(`${p}: items must be unique`);
		if (s.items) v.forEach((x, i) => e.push(...schemaCheck(x, s.items, root, `${p}[${i}]`)));
	} else if (v !== null && typeof v === 'object') {
		for (const r of s.required || []) if (!(r in v)) e.push(`${p}: missing ${r}`);
		for (const [k, x] of Object.entries(v)) {
			if (s.properties && k in s.properties) e.push(...schemaCheck(x, s.properties[k], root, `${p}.${k}`));
			else if (s.additionalProperties === false) e.push(`${p}: unknown field ${k}`);
			else if (s.additionalProperties && typeof s.additionalProperties === 'object') e.push(...schemaCheck(x, s.additionalProperties, root, `${p}.${k}`));
		}
	}
	return e;
}

// ---- platforms / requires in bolt-app.json ----
const REQ_INTERP = ['python', 'node', 'sh', 'powershell'];
export function platformFindings(app) {
	const out = [], E = (code, message) => out.push({ level: 'error', code, message, path: 'bolt-app.json' });
	if ('platforms' in app) {
		const p = app.platforms;
		if (!Array.isArray(p) || !p.length || p.some((x) => !OSES.includes(x)) || new Set(p).size !== p.length) E('platforms_invalid', `platforms must be a non-empty list of unique values from ${OSES.join(', ')}`);
	}
	if ('min_bolt_version' in app && !(typeof app.min_bolt_version === 'string' && parseBoltVersion(app.min_bolt_version))) E('min_bolt_version_invalid', 'min_bolt_version must be a dotted version such as "0.1.182"');
	if ('requires' in app) {
		const r = app.requires;
		if (!Array.isArray(r) || r.length > 8 || r.some((x) => !x || typeof x !== 'object' || !REQ_INTERP.includes(x.interpreter) || (x.min_version !== undefined && !/^\d+(\.\d+){0,2}$/.test(String(x.min_version))) || Object.keys(x).some((k) => !['interpreter', 'min_version', 'platforms'].includes(k)) || (x.platforms !== undefined && (!Array.isArray(x.platforms) || x.platforms.some((q) => !OSES.includes(q))))))
			E('requires_invalid', `requires must be a list of { interpreter: ${REQ_INTERP.join('|')}, min_version: "3.9", platforms?: [...] }`);
	}
	return out;
}

// ---- kit vendoring and the divergence guard ----
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
// Every entry is hashed or reported; nothing is skipped silently. __pycache__ contents are ignored by design.
function walkKit(dir) {
	const files = [], problems = [];
	const walk = (d, rel) => {
		for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
			const r = rel ? `${rel}/${e.name}` : e.name;
			if (e.isSymbolicLink()) { problems.push(`${r}: symlink`); files.push(`L:${r}`); continue; }
			if (e.isDirectory()) { if (e.name === '__pycache__') continue; problems.push(`${r}: unexpected directory`); walk(path.join(d, e.name), r); continue; }
			if (!e.isFile()) { problems.push(`${r}: not a regular file`); continue; }
			if (!/\.(py|json)$/.test(e.name)) problems.push(`${r}: unexpected file type`);
			files.push(r);
		}
	};
	walk(dir, '');
	return { files, problems };
}
export function treeHash(dir) {
	return sha(walkKit(dir).files.map((f) => (f.startsWith('L:') ? `${f}\n` : `${f}\0${sha(fs.readFileSync(path.join(dir, f)))}\n`)).join(''));
}
export function kitTreeProblems(dir) {
	const { files, problems } = walkKit(dir);
	const expected = new Set(walkKit(KIT_PY).files);
	for (const f of files) if (!f.startsWith('L:') && !expected.has(f)) problems.push(`${f}: not part of the kit`);
	return [...new Set(problems)];
}
export const kitVersion = () => /__version__\s*=\s*"([^"]+)"/.exec(fs.readFileSync(path.join(KIT_PY, '__init__.py'), 'utf8'))[1];
// A path named in check.json must stay inside the app folder, never be the folder itself, and no component of it
// (below the app folder) may be a symlink. `name` pins the final component.
export function inside(appDir, rel, name) {
	const base = path.resolve(appDir), p = path.resolve(base, String(rel));
	if (p === base || !p.startsWith(base + path.sep)) throw new Error(`"${rel}" in check.json points outside the app folder`);
	if (name && path.basename(p) !== name) throw new Error(`"${rel}" must end in ${name}`);
	let cur = base;
	for (const part of path.relative(base, p).split(path.sep)) {
		cur = path.join(cur, part);
		let st; try { st = fs.lstatSync(cur); } catch { break; }
		if (st.isSymbolicLink()) throw new Error(`"${rel}" goes through a symlink (${part}); refusing`);
	}
	let anc = p; while (!fs.existsSync(anc)) anc = path.dirname(anc);
	const realBase = fs.realpathSync(base), realAnc = fs.realpathSync(anc);
	if (realAnc !== realBase && !realAnc.startsWith(realBase + path.sep)) throw new Error(`"${rel}" resolves outside the app folder`);
	return p;
}
// Flat mode: the whole kit as ONE file, scripts/<app id>__bolt_app_kit.py, because Bolt installs scripts into one shared folder (so every file is named for its app)
// and a package folder cannot be installed by older Bolt versions. The file holds the kit's own source strings and builds the same package in memory
// when imported, so the code that runs is the code in kit/python/bolt_app_kit, byte for byte. The lock lives beside
// check.json (author side, never packed).
// A JSON value as a Python literal with single-quoted strings: no escaped double quotes, so a web address inside it is
// not read as one with a backslash by the install prompt's text search.
function pyLit(v) {
	if (v === null) return 'None';
	if (v === true) return 'True';
	if (v === false) return 'False';
	if (typeof v === 'number') return String(v);
	if (typeof v === 'string') return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
	if (Array.isArray(v)) return `[${v.map(pyLit).join(', ')}]`;
	return `{${Object.entries(v).map(([k, x]) => `${pyLit(k)}: ${pyLit(x)}`).join(', ')}}`;
}
export const FLAT_NAME = 'bolt_app_kit.py';
// Bolt keeps every app's scripts in one shared folder, so the vendored kit is named for its app: <app id>__bolt_app_kit.py. The script loads it by that name.
export function flatName(appDir) { try { const id = JSON.parse(fs.readFileSync(path.join(appDir, 'bolt-app.json'), 'utf8')).id; if (typeof id === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(id)) return `${id}__${FLAT_NAME}`; } catch { /* no listing: the plain name */ } return FLAT_NAME; }
const ORDER = ['text', 'fmt', 'icons_data', 'schema', 'probe', 'cache', 'rows'];
export function flatKitSource() {
	const names = fs.readdirSync(KIT_PY).filter((f) => f.endsWith('.py') && f !== '__init__.py').map((f) => f.slice(0, -3)).sort();
	const mods = [...ORDER.filter((n) => names.includes(n)), ...names.filter((n) => !ORDER.includes(n))];
	const src = Object.fromEntries(mods.map((n) => [n, fs.readFileSync(path.join(KIT_PY, `${n}.py`), 'utf8')]));
	const py = (v) => JSON.stringify(v).split(String.fromCharCode(0x2028)).join('\\u2028').split(String.fromCharCode(0x2029)).join('\\u2029');
	return `"""bolt_app_kit ${kitVersion()}, single-file build. Generated by: bolt-apps kit vendor --flat. Do not edit: re-vendor.

Bolt installs scripts into one flat folder, so the kit ships as this one file. Importing it builds the package
bolt_app_kit in memory from the kit's own modules (embedded below), so the behaviour is the kit's, unchanged."""
import sys as _sys
import types as _types

_ORDER = ${py(mods)}
_SOURCES = ${py(src)}
_SCHEMA = ${pyLit(JSON.parse(fs.readFileSync(path.join(KIT_PY, 'row_schema.json'), 'utf8')))}
_INIT = ${py(fs.readFileSync(path.join(KIT_PY, '__init__.py'), 'utf8'))}


def _build():
    pkg = _sys.modules[__name__]
    pkg.__path__ = []
    pkg.__package__ = __name__
    for name in _ORDER:
        m = _types.ModuleType(__name__ + "." + name)
        m.__package__ = __name__
        m.__file__ = __file__ + "!" + name + ".py"
        _sys.modules[m.__name__] = m
        exec(compile(_SOURCES[name], m.__file__, "exec"), m.__dict__)
        setattr(pkg, name, m)
    _sys.modules[__name__ + ".schema"].load_schema = lambda: _SCHEMA
    exec(compile(_INIT, __file__ + "!__init__.py", "exec"), pkg.__dict__)


_build()
`;
}
const kitIsFlat = (cfg) => String(cfg.kit || '').endsWith('.py');
const flatLockPath = (appDir) => path.join(appDir, 'bolt_app_kit.lock.json');
export function vendorKit(appDir, opts = {}) {
	const cfgFile = path.join(appDir, 'check.json');
	const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
	if (opts.flat && !kitIsFlat(cfg)) {
		// switch the app to flat mode: name the single file in check.json and remove the folder build that would shadow it
		const old = inside(appDir, cfg.kit || 'scripts/bolt_app_kit', 'bolt_app_kit');
		if (fs.existsSync(old)) { if (!fs.lstatSync(old).isDirectory()) throw new Error('the kit path is not a directory; refusing'); fs.rmSync(old, { recursive: true }); }
		fs.rmSync(`${old}.lock.json`, { force: true });
		cfg.kit = path.posix.join(path.posix.dirname(cfg.script || 'scripts/x.py'), flatName(appDir));
		fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n');
	}
	if (kitIsFlat(cfg) && path.posix.basename(String(cfg.kit)) !== flatName(appDir)) throw new Error(`the kit is named ${path.posix.basename(String(cfg.kit))}, but every file of an app must be named <app id>__<name>. Apps built before this change: remove the old app in Bolt (Settings, User Apps, Remove), run ./bolt-apps new <template> <id>, then copy your own config.json and fixtures.json over the new ones and re-run ./bolt-apps check.`);
	if (kitIsFlat(cfg)) {
		const dest = inside(appDir, cfg.kit, flatName(appDir));
		if (fs.existsSync(dest) && !fs.lstatSync(dest).isFile()) throw new Error('the kit path is not a file; refusing');
		const body = flatKitSource();
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.writeFileSync(dest, body);
		const lock = { name: 'bolt_app_kit', version: kitVersion(), flat: true, sha256: sha(Buffer.from(body)) };
		fs.writeFileSync(flatLockPath(appDir), JSON.stringify(lock, null, 2) + '\n');
		return { dest, lock };
	}
	const dest = inside(appDir, cfg.kit || 'scripts/bolt_app_kit', 'bolt_app_kit');
	if (fs.existsSync(dest)) { if (!fs.lstatSync(dest).isDirectory()) throw new Error('the kit path is not a directory; refusing'); fs.rmSync(dest, { recursive: true }); }
	fs.mkdirSync(dest, { recursive: true });
	for (const f of fs.readdirSync(KIT_PY)) if (f.endsWith('.py') || f.endsWith('.json')) fs.copyFileSync(path.join(KIT_PY, f), path.join(dest, f));
	const lock = { name: 'bolt_app_kit', version: kitVersion(), sha256: treeHash(dest) };
	fs.writeFileSync(`${dest}.lock.json`, JSON.stringify(lock, null, 2) + '\n');
	return { dest, lock };
}
function flatKitGuard(appDir, cfg) {
	const out = [], E = (code, message) => out.push({ level: 'error', code, message, path: cfg.kit });
	let dest;
	try { dest = inside(appDir, cfg.kit, flatName(appDir)); } catch (e) { E('path_outside_app', e.message); return out; }
	if (path.dirname(path.resolve(appDir, cfg.script || '')) !== path.dirname(dest)) { E('kit_not_beside_script', 'the kit that runs is the <app id>__bolt_app_kit.py next to the script; check.json kit must name that file'); return out; }
	if (fs.existsSync(path.join(path.dirname(dest), 'bolt_app_kit'))) { E('kit_modified', 'a bolt_app_kit folder sits next to bolt_app_kit.py and Python would import the folder instead. Remove it'); return out; }
	if (!fs.existsSync(dest) || !fs.existsSync(flatLockPath(appDir))) { E('kit_not_vendored', 'the kit is not vendored: run bolt-apps kit vendor --flat <app>'); return out; }
	let lock; try { lock = JSON.parse(fs.readFileSync(flatLockPath(appDir), 'utf8')); } catch { E('kit_lock_unreadable', 'bolt_app_kit.lock.json is not JSON'); return out; }
	const have = sha(fs.readFileSync(dest));
	if (have !== lock.sha256) E('kit_modified', 'bolt_app_kit.py differs from its lock (someone edited it). Re-vendor, do not edit');
	else if (lock.version === kitVersion() && lock.sha256 !== sha(Buffer.from(flatKitSource()))) E('kit_diverged', `the vendored kit says ${lock.version} but differs from this repo's ${lock.version}`);
	else if (lock.version !== kitVersion()) out.push({ level: cfg.allow_outdated_kit === true ? 'warning' : 'error', code: 'kit_outdated', message: `app is pinned to kit ${lock.version}; this toolkit has ${kitVersion()}. Re-vendor, or set allow_outdated_kit in check.json after reviewing the older kit`, path: cfg.kit });
	return out;
}
export function kitGuard(appDir, cfg) {
	if (kitIsFlat(cfg)) return flatKitGuard(appDir, cfg);
	const out = [], E = (code, message) => out.push({ level: 'error', code, message, path: cfg.kit || 'scripts/bolt_app_kit' });
	let dest;
	try { dest = inside(appDir, cfg.kit || 'scripts/bolt_app_kit', 'bolt_app_kit'); } catch (e) { E('path_outside_app', e.message); return out; }
	if (path.join(path.dirname(path.resolve(appDir, cfg.script || '')), 'bolt_app_kit') !== dest) { E('kit_not_beside_script', 'the kit that runs is the bolt_app_kit next to the script; check.json kit must name that folder'); return out; }
	if (!fs.existsSync(dest) || !fs.existsSync(`${dest}.lock.json`)) { E('kit_not_vendored', 'the kit is not vendored: run bolt-apps kit vendor <app>'); return out; }
	let lock; try { lock = JSON.parse(fs.readFileSync(`${dest}.lock.json`, 'utf8')); } catch { E('kit_lock_unreadable', 'bolt_app_kit.lock.json is not JSON'); return out; }
	const tp = kitTreeProblems(dest);
	if (tp.length) E('kit_modified', `the kit directory holds entries that are not the kit: ${tp.slice(0, 4).join('; ')}`);
	else if (treeHash(dest) !== lock.sha256) E('kit_modified', 'the vendored kit differs from its lock (someone edited it). Re-vendor, do not edit');
	else if (lock.version === kitVersion() && lock.sha256 !== treeHash(KIT_PY)) E('kit_diverged', `the vendored kit says ${lock.version} but differs from this repo's ${lock.version}`);
	else if (lock.version !== kitVersion()) out.push({ level: cfg.allow_outdated_kit === true ? 'warning' : 'error', code: 'kit_outdated', message: `app is pinned to kit ${lock.version}; this toolkit has ${kitVersion()}. Re-vendor, or set allow_outdated_kit in check.json after reviewing the older kit`, path: cfg.kit });
	return out;
}


// ---- what the launcher can draw in the right pane (userAppPane.ts): a row `pane` names a view that declares a selected_row preview; a tiles grid (cards, list_data) is drawn for the
// whole run, one tile per row, at most 24 rows, and a row with no kpi_value is an empty tile. Static facts from the app file plus the rows a case printed.
const ROW_PANE_KINDS = ['entity_preview', 'detail', 'markdown', 'json_tree', 'chart', 'table', 'card'];   // sanitizeRowPane accepts only these per row
export function presentationOf(appDir) {
	try {
		const ud = path.join(appDir, 'utilities'), y = fs.readdirSync(ud).find((f) => /\.ya?ml$/.test(f)); if (!y) return null;
		const root = parseYaml(fs.readFileSync(path.join(ud, y), 'utf8')), pres = get(root, 'presentation')?.value;
		const widget = (n) => { const w = get(n, 'right_widget')?.value; if (!w) return null; const bind = get(w, 'bind')?.value, bound = str(get(bind, 'value')?.value), vf = /^\{\{\s*row\.([A-Za-z0-9_]+)\s*\}\}$/.exec(bound || ''); const fields = new Set(); const walk = (n) => { if (!n) return; if (n.t === 's') for (const m of String(n.v).matchAll(/\{\{\s*row\.([A-Za-z0-9_]+)/g)) fields.add(m[1]); else if (n.t === 'm') n.entries.forEach((e) => walk(e.value)); else if (n.t === 'l') n.items.forEach(walk); }; walk(bind); return { kind: str(get(w, 'kind')?.value), mode: str(get(w, 'mode')?.value), layout: str(get(bind, 'layout')?.value), valueField: vf ? vf[1] : 'kpi_value', fields: [...fields] }; };
		const views = new Map(); const vs = get(pres, 'views')?.value;
		for (const e of vs?.entries || []) views.set(e.key, widget(e.value) );
		return { top: widget(pres), views, viewArg: str(get(pres, 'view_arg')?.value) };
	} catch { return null; }
}
// kpiTile.ts parseWidgetNumber (strict): a number, or a string like 12, 1,234.5, -3%, $4 or 1e3; "n/a", "-" and "" are not numbers and draw a "-" tile
const NUMBER_RE = /^[-+]?[$\u20ac\u00a3\u00a5]?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?([eE][-+]?\d+)?%?$/;
export function widgetNumber(v) {
	let n;
	if (typeof v === 'number') n = v; else if (typeof v === 'string' && NUMBER_RE.test(v.trim())) n = Number(v.trim().replace(/[$\u20ac\u00a3\u00a5,%]/g, '')); else return null;
	return Number.isFinite(n) && Math.abs(n) <= 1e15 ? n : null;
}
export function paneProblems(pres, rows, view, opts = {}) {
	const out = [], E = (code, message) => out.push({ level: 'error', code, message });
	if (!pres || !Array.isArray(rows)) return out;
	// the launcher draws the view named by the first word; a first word that is not a declared view (a place, a repo, a host name) is drawn by the APP-LEVEL right_widget
	const fallback = pres.viewArg && view !== 'overview' && !pres.views.has(view);
	const shown = fallback ? '(app-level)' : (pres.views.has(view) ? view : 'overview');
	const own = fallback ? null : pres.views.get(shown), w = own || pres.top;
	const goodPane = (r) => r && typeof r.pane === 'string' && (r.pane !== shown && pres.views.has(r.pane)) && (() => { const pw = pres.views.get(r.pane); return pw && (pw.mode || 'selected_row') === 'selected_row' && ROW_PANE_KINDS.includes(pw.kind); })();
	// Bolt applies the 24-tile cap and the "no value" tile only to a tiles layout (bind.layout: tiles). The default grid layout caps at 500 and needs no number.
	if (w && w.kind === 'cards' && w.mode === 'list_data' && w.layout === 'tiles') {
		if (rows.length > 24) E('tile_cap', `the view "${shown}" draws a tile per row and at most 24 rows: this run printed ${rows.length}. Send 24 or fewer, or give the view a selected_row preview instead of a tiles grid`);
		const vf = w.valueField, loose = rows.filter((r) => !goodPane(r)), empty = loose.filter((r) => r && widgetNumber(r[vf]) === null).length;
		// a tiles view draws a tile per row and shows "-" for a row with no number, so a non-data row (a label, a hint, a retry or a Back row) is an empty tile; a run of one row (a lone setup or error state) is allowed
		const noVal = (r) => r && widgetNumber(r[vf]) === null;
		// Bolt maps EVERY row to a tile (CardsWidget kpiCapped.rows.map(kpiTile)): it skips no row kind, so a refresh row and a Back row are empty "no value" tiles like any other label row
		// allowed: a run with no data row at all (a lone setup, error or retry state)
		const bare = rows.some((r) => !noVal(r)) ? loose.filter((r) => noVal(r)) : [];
		if (bare.length) E('tile_row_without_value', `the view "${shown}" is a tiles view (cards, bind.layout tiles) and ${bare.length} of ${rows.length} rows carry no ${vf}: ${bare.slice(0, 3).map((r) => JSON.stringify(String(r.title).slice(0, 40))).join(', ')}. Each draws as an empty "-" tile (Bolt draws a tile for every row, a refresh or Back row included). Give the row a number (for a refresh row: kpi_label 'Data age', kpi_value seconds since the copy was made, kpi_unit 's'), put the text on a real tile (badge or footer), or move the refresh and Back rows to a view that is not a tiles grid`);
		// the 8-row floor keeps a lone setup or error row in a tiles view from being refused; a run of 8 or more rows where half have no tile is a grid of empty tiles
		if (rows.length >= 8 && empty * 2 >= rows.length) E('empty_tile_grid', `the view "${shown}" draws a tile per row (cards, tiles), but ${empty} of ${rows.length} rows carry no ${vf} and no valid pane, so they draw as empty tiles ("no value"). Give those rows a tile, or give the view a selected_row preview (entity_preview) in presentation.views.${shown}.right_widget`);
	}
	const seen = new Set();
	for (const r of rows) {
		if (!r || typeof r.pane !== 'string' || !r.pane || r.pane === shown || seen.has(r.pane)) continue; seen.add(r.pane);   // a pane naming the view the run is on is drawn by that view's own widget
		if (!pres.views.has(r.pane)) { E('pane_no_view', `a row names pane "${r.pane}", which is not a view in presentation.views: the launcher ignores the pane`); continue; }
		const pw = pres.views.get(r.pane);
		if (!pw) { if (r.pane !== shown) E('pane_no_widget', `a row names pane "${r.pane}", but that view declares no right_widget: the launcher ignores the pane. Add a selected_row preview (entity_preview) to presentation.views.${r.pane}.right_widget`); }
		else if ((pw.mode || 'selected_row') !== 'selected_row') E('pane_list_data', `a row names pane "${r.pane}", but that view's right_widget is mode ${pw.mode}: a row pane must be a selected_row view (list_data views are drawn for the whole run, never per row)`);
		else if (!ROW_PANE_KINDS.includes(pw.kind)) E('pane_kind', `a row names pane "${r.pane}", whose right_widget kind ${pw.kind} is never drawn per row (only ${ROW_PANE_KINDS.join(', ')} are): use entity_preview`);
	}
	return out;
}

// A demo in sample mode must SAY so where the person can see it: a tile badge, footer or note in a tiles grid, a row title everywhere else (chart and table data views are plotted, so they carry none).
export function sampleVisibleProblems(pres, rows, view) {
	if (!pres || !Array.isArray(rows) || rows.length < 2) return [];
	const shown = pres.views.has(view) ? view : 'overview', w = pres.views.get(shown) || pres.top;
	const say = (s) => /sample/i.test(String(s || ''));
	const tiles = w && w.kind === 'cards' && w.layout === 'tiles', quiet = w && !['entity_preview', 'markdown'].includes(w.kind) && !tiles;
	const ok = tiles ? rows.some((r) => say(r.kpi_badge) || say(r.kpi_foot) || say(r.kpi_note)) : quiet ? rows.some((r) => say(r.subtitle) || say(r.title)) : rows.some((r) => say(r.title));
	return ok ? [] : [{ level: 'error', code: 'sample_not_visible', message: `the app is showing sample data (no key) in the view "${shown}", but nothing visible says so. Put the label where it is drawn: a SAMPLE DATA row in a list view, the tile badge or footer in a tiles grid, the first row's subtitle in a chart, table, diff, json_tree or image_grid view (a label row there would be a data point or a blank pane)` }];
}

// In a selected_row view every row the person can arrow onto must give its pane something to draw: at least one non-empty field the pane binds, or its own `pane` naming another selected_row view that binds a field the row carries. The app's own Back, refresh, sample-data and key-hint rows are NOT exempt: the first row of a drilled list is selected on arrival, and a Back row that binds nothing draws a detail pane of dash placeholders (a blank title and every field a dash), which reads as missing data.
// A row whose `pane` names a view draws THAT view's widget, in any view of the app, so the check runs for every row that names one.
const nonEmpty = (r, f) => r[f] !== undefined && r[f] !== null && String(r[f]).trim() !== '';
// What to do about it, for the app file at hand: the engine adds the note view itself, so the advice depends on whether it can.
function noteAdvice(pres) {
	const n = pres.views.get('note'), reusable = [...pres.views.values()].some((v) => v && v.kind === 'markdown' && (v.mode || 'selected_row') === 'selected_row' && ['title', 'subtitle', 'body'].every((f) => (v.fields || []).includes(f)));
	if (pres.views.has('note') && !(n && n.kind === 'markdown' && ['title', 'subtitle', 'body'].every((f) => (n.fields || []).includes(f)))) return 'Your view named "note" does not bind title, subtitle and body: rename it (the engine then adds "back-note"), or give the row a pane naming a markdown view that binds row.title, row.subtitle and row.body';
	if (pres.views.size >= 8 && !reusable) return 'The app file already has 8 views, so no note view can be added: drop a view, or give the row a pane naming a markdown view that binds row.title, row.subtitle and row.body';
	return 'Give the row a field the pane binds, or a `pane` naming a small markdown view (named "note", binding row.title, row.subtitle and row.body) declared in presentation.views of the app file, and a body';
}
export function blankPaneProblems(pres, rows, view) {
	if (!pres || !Array.isArray(rows)) return [];
	const out = [], shown = pres.views.has(view) ? view : 'overview', w = pres.views.get(shown) || pres.top;
	const nav = (r) => r && r.nav && (r.nav.back === true || /^refresh(\.|$)/.test(String(r.nav.arg || '')));
	const target = (r) => { if (!r || typeof r.pane !== 'string' || r.pane === shown || !pres.views.has(r.pane)) return null; const pw = pres.views.get(r.pane); return pw && (pw.mode || 'selected_row') === 'selected_row' && ROW_PANE_KINDS.includes(pw.kind) ? pw : null; };
	// a row that names another view's pane must carry a field THAT view binds (the pane is drawn from the row, in whatever view the row is listed)
	const emptyNamed = rows.filter((r) => { const pw = target(r); return pw && pw.fields && pw.fields.length && !pw.fields.some((f) => nonEmpty(r, f)); });
	if (emptyNamed.length) out.push({ level: 'error', code: 'pane_blank_row', message: `${emptyNamed.length} row(s) name a pane whose view binds none of the row's fields: ${emptyNamed.slice(0, 2).map((r) => `${JSON.stringify(String(r.title).slice(0, 40))} (pane "${r.pane}", binds ${pres.views.get(r.pane).fields.slice(0, 4).join(', ')})`).join(', ')}. That pane draws dash placeholders for the row. ${noteAdvice(pres)}` });
	if (!w || w.mode !== 'selected_row' || !w.fields || !w.fields.length) return out;
	const has = (r) => w.fields.some((f) => nonEmpty(r, f));
	if (!rows.some((r) => r && !nav(r) && has(r))) return out;   // a run with no data row at all (a not-found, setup or error state) has nothing to draw
	const bad = rows.filter((r) => { if (!r || has(r)) return false; const pw = target(r); return !(pw && pw.fields && pw.fields.some((f) => nonEmpty(r, f))); });
	if (bad.length) out.push({ level: 'error', code: 'pane_blank_row', message: `the view "${shown}" draws a ${w.kind} pane for the selected row, but ${bad.length} row(s) bind none of its fields (${w.fields.slice(0, 4).join(', ')}): ${bad.slice(0, 2).map((r) => JSON.stringify(String(r.title).slice(0, 40))).join(', ')}. Selecting one shows an empty pane${w.kind === 'detail' ? ' of dash placeholders' : ''}${bad.some(nav) ? ' (a Back or refresh row is selected first in a drilled list, so it is the first thing seen)' : ''}. ${noteAdvice(pres)}` });
	return out;
}

// ---- stubs and the process ----
const SH_QUOTE = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const HOSTILE = 'a\u202eb\u200bc{{x}}\u{E0041}d\u2028e\u0007f\u3164g\u2800h';
const CMD_QUOTE = (s) => `"${String(s).replace(/"/g, '""')}"`;
// One dispatcher for every Windows stub: hang, by_args prefix match, default stdout/rc, and @@HOSTILE@@ as raw UTF-8 (never the console code page).
const STUB_PY = `import json, os, sys, time
name, args = sys.argv[1], sys.argv[2:]
with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "._bolt_stubs.json"), "r", encoding="utf-8") as f:
    cfg = json.load(f)
s = cfg.get(name) or {}
if s.get("hang"):
    time.sleep(60)
    raise SystemExit(0)

def emit(entry):
    text = entry.get("stdout")
    if text is None:
        text = ""
    sys.stdout.buffer.write(text.encode("utf-8"))
    raise SystemExit(int(entry.get("rc") or 0))

for rule in s.get("by_args") or []:
    want = [str(a) for a in (rule.get("args") or [])]
    if want and args[:len(want)] == want:
        emit(rule)
emit(s)
`;
function makeStubs(dir, appDir, osName, kase, files, py) {
	const stubs = {};
	const base = path.join(appDir, 'fixtures', osName);
	if (fs.existsSync(base)) for (const f of fs.readdirSync(base)) { const m = /^(.+)\.out$/.exec(f); if (m) stubs[m[1]] = { abs: true, file: path.join(base, f), rc: fs.existsSync(path.join(base, `${m[1]}.rc`)) ? Number(fs.readFileSync(path.join(base, `${m[1]}.rc`), 'utf8').trim()) : 0 }; }
	for (const [n, o] of Object.entries(kase.stubs || {})) stubs[n] = o.file ? { ...o, abs: true, file: path.join(appDir, o.file) } : { ...o };
	for (const n of kase.hang || []) stubs[n] = { hang: true };
	fs.mkdirSync(dir, { recursive: true });
	const readStub = (d) => {
		if (!d.file) return d.stdout ?? '';
		const p = d.abs ? d.file : path.join(appDir, d.file);
		if (!inside(appDir, p)) throw new Error(`stub file ${d.file} escapes the app folder`);
		return fs.readFileSync(p, 'utf8');
	};
	if (process.platform === 'win32') {
		const pyArgv = Array.isArray(py) ? py : [py];
		const pyCmd = pyArgv.map((w) => (/^[A-Za-z0-9._+-]+$/.test(w) ? w : CMD_QUOTE(w))).join(' ');
		const cfg = {};
		const load = (d) => readStub(d).split('@@HOSTILE@@').join(kase.hostile ? HOSTILE : 'plainname');
		for (const [name, s] of Object.entries(stubs)) {
			if (!/^[A-Za-z0-9._+-]+$/.test(name)) throw new Error(`bad stub name ${name}`);
			if (s.missing) continue;
			if (s.hang) cfg[name] = { hang: true };
			else {
				const entry = { stdout: load(s), rc: Number.isInteger(s.rc) ? s.rc : 0 };
				if ((s.by_args || []).length) entry.by_args = s.by_args.map((r, i) => {
					if (!Array.isArray(r.args) || !r.args.length) throw new Error(`stub ${name}: by_args rule ${i} needs a non-empty args list`);
					return { args: r.args.map(String), stdout: load(r), rc: Number.isInteger(r.rc) ? r.rc : 0 };
				});
				cfg[name] = entry;
			}
			// kit.which uses the faked os_name() for extensions, so a macos/linux fixture looks for `name` not `name.cmd`. Write both.
			const body = `@echo off\n${pyCmd} "%~dp0._bolt_stub.py" ${name} %*\n`;
			fs.writeFileSync(path.join(dir, `${name}.cmd`), body);
			fs.writeFileSync(path.join(dir, name), body);
		}
		fs.writeFileSync(path.join(dir, '._bolt_stubs.json'), JSON.stringify(cfg));
		fs.writeFileSync(path.join(dir, '._bolt_stub.py'), STUB_PY);
		return;
	}
	for (const [name, s] of Object.entries(stubs)) {
		if (!/^[A-Za-z0-9._+-]+$/.test(name)) throw new Error(`bad stub name ${name}`);
		if (s.missing) continue;
		const data = (d, tag) => { const text = readStub(d).split('@@HOSTILE@@').join(kase.hostile ? HOSTILE : 'plainname'); const df = path.join(dir, `.data-${name}-${tag}`); fs.writeFileSync(df, text); files.push(df); return df; };
		let body = '#!/bin/sh\n';
		if (s.hang) body += '/bin/sleep 60\n';
		else {
			// "by_args": [{ "args": ["status", "--porcelain"], "file" | "stdout", "rc" }, ...]: the first rule whose words equal the first words of the command line answers; the stub's own file or stdout is the default
			(s.by_args || []).forEach((r, i) => {
				if (!Array.isArray(r.args) || !r.args.length) throw new Error(`stub ${name}: by_args rule ${i} needs a non-empty args list`);
				const cond = r.args.map((a, k) => `[ "$${k + 1}" = ${SH_QUOTE(a)} ]`).join(' && ');
				body += `if ${cond}; then /bin/cat ${SH_QUOTE(data(r, 'r' + i))}; exit ${Number.isInteger(r.rc) ? r.rc : 0}; fi\n`;
			});
			body += `/bin/cat ${SH_QUOTE(data(s, 'd'))}\nexit ${Number.isInteger(s.rc) ? s.rc : 0}\n`;
		}
		fs.writeFileSync(path.join(dir, name), body, { mode: 0o755 });
	}
}
const WRAPPER = `import sys, os, runpy
script, plat = sys.argv[1], sys.argv[2]
sys.path.insert(0, os.path.dirname(script))
sys.argv = [script] + sys.argv[3:]
# A thin app finds the shared engine through this module, not through the environment: the script's environment stays what Bolt gives it.
import types as _types
_tk = _types.ModuleType("_bolt_apps_toolkit"); _tk.engine_file = ${JSON.stringify(ENGINE_SRC)}; sys.modules["_bolt_apps_toolkit"] = _tk
import subprocess, shutil, tempfile, threading, json, unicodedata, hashlib, stat, signal, re, math, time
# Windows stubs are .cmd files; kit.which of a macos/linux fixture returns the extensionless copy, which CreateProcess cannot run.
# Rewrite a spawn of a file next to ._bolt_stub.py into the dispatcher so hang/by_args still work and proc.kill() hits the sleeper.
_real_Popen = subprocess.Popen
def _Popen(args, **kw):
    if os.name == "nt" and args and not isinstance(args, (str, bytes)):
        args = list(args)
        exe0 = os.fspath(args[0])
        if isinstance(exe0, str):
            cand = os.path.join(os.path.dirname(os.path.abspath(exe0)), "._bolt_stub.py")
            if not os.path.isfile(cand) and not os.path.isabs(exe0) and os.sep not in exe0 and "/" not in exe0:
                p0 = (os.environ.get("PATH") or "").split(os.pathsep)[0]
                base = os.path.splitext(os.path.basename(exe0))[0]
                cand2 = os.path.join(p0, "._bolt_stub.py")
                if os.path.isfile(cand2) and (os.path.isfile(os.path.join(p0, base + ".cmd")) or os.path.isfile(os.path.join(p0, base))):
                    cand, exe0 = cand2, os.path.join(p0, base)
            if os.path.isfile(cand):
                name = os.path.splitext(os.path.basename(exe0))[0]
                args = [sys.executable, cand, name] + args[1:]
    return _real_Popen(args, **kw)
subprocess.Popen = _Popen
# The platform is faked below so a script takes its macOS, Linux or Windows branch. Import every standard module the examples use BEFORE
# that, or a module that picks code by platform at import time (urllib.request pulls in _scproxy on darwin) fails on another host.
import urllib.request, urllib.error, urllib.parse, http.client, socket, ssl, concurrent.futures, calendar, base64, datetime, csv, io, zlib, struct, traceback
try:
    import fcntl
except ImportError:
    pass
sys.platform = plat
sys.dont_write_bytecode = True
_probed = []
def _probe():
    # check --shared: say which file the kit module came from, so the check can prove which copy ran. Only when the shared folder was offered.
    if _probed or not os.environ.get("BOLT_APP_SHARED_DIR"):
        return
    _probed.append(1)
    _k = sys.modules.get("bolt_app_kit")
    sys.stderr.write("\\n@@bolt-check-kit-file@@ " + (getattr(_k, "__file__", None) or "(none)") + "\\n")
    sys.stderr.flush()
_real_exit = os._exit
def _exit_after_probe(code=0):
    _probe()
    _real_exit(code)
os._exit = _exit_after_probe   # the kit ends a run with os._exit, which skips finally and atexit
try:
    runpy.run_path(script, run_name="__main__")
finally:
    _probe()
`;
function runScript(pyArg, script, osName, args, env, cwd) {
	return new Promise((resolve) => {
		const t0 = Date.now();
		const [py, ...pyPre] = Array.isArray(pyArg) ? pyArg : [pyArg];
		const win = process.platform === 'win32';
		const ch = spawn(py, [...pyPre, '-c', WRAPPER, script, PY_PLATFORM[osName], ...args], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], ...(win ? { windowsHide: true } : { detached: true }) });
		let out = '', err = '', killed = false;
		ch.stdout.on('data', (d) => { out += d; }); ch.stderr.on('data', (d) => { err += d; });
		const killTree = () => {
			if (win) {
				const tk = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
				if (ch.pid) try { spawnSync(tk, ['/PID', String(ch.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
				try { ch.kill(); } catch {}
			} else {
				try { process.kill(-ch.pid, 'SIGKILL'); } catch {}
			}
		};
		const timer = setTimeout(() => { killed = true; killTree(); }, BRIDGE_LIMIT_S * 1000 + 3000);
		ch.on('close', (rc) => {
			clearTimeout(timer);
			if (!win) killTree();
			const m = /\n@@bolt-check-kit-file@@ (.*)\n$/.exec(err); let kitFile = null;
			if (m) { kitFile = m[1]; err = err.slice(0, m.index); }   // the probe line is ours, not the script's
			resolve({ rc, out, err, killed, kitFile, seconds: (Date.now() - t0) / 1000 });
		});
		ch.on('error', (e) => { clearTimeout(timer); resolve({ rc: null, out, err: String(e), killed, seconds: (Date.now() - t0) / 1000 }); });
	});
}

const BAD_TEXT = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\u2028\u2029\u115f\u1160\u3164\uffa0\u2800\u034f]/u;
function strings(v, p, out) { if (typeof v === 'string') out.push([p, v]); else if (Array.isArray(v)) v.forEach((x, i) => strings(x, `${p}[${i}]`, out)); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) strings(x, `${p}.${k}`, out); return out; }
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// A row action that chains to another app (kind utility, target_chip) must name this app's own id: the launcher looks apps up by id, so a chip that is not an installed app's id resolves to nothing,
// and a chain into somebody else's app is not something an example may do silently.
export function chainProblems(rows, appId) {
	const out = [];
	if (!appId || !Array.isArray(rows)) return out;
	const bad = new Set();
	for (const r of rows) for (const a of (r && Array.isArray(r.actions) ? r.actions : [])) if (a && a.kind === 'utility' && typeof a.target_chip === 'string' && a.target_chip !== appId) bad.add(a.target_chip);
	for (const c of bad) out.push({ level: 'error', code: 'chain_target_not_self', message: `a row action chains to "${c}", but this app's id is "${appId}". The launcher looks apps up by id, so a chain must name the app's own id (a chain into another app is not allowed in an example). Use target_chip: ${appId}` });
	return out;
}
export function checkRows(rows, manifestActions = 1) {
	const f = [], E = (code, message) => f.push({ level: 'error', code, message });
	for (const m of schemaCheck(rows, SCHEMA)) E('schema_invalid', m);
	if (!Array.isArray(rows)) return f;
	rows.forEach((r, i) => {
		if (!r || typeof r !== 'object') return;
		const acts = Array.isArray(r.actions) ? r.actions : [];
		if (acts.length > 3 - manifestActions) E('footer_too_many', `row ${i}: ${acts.length} footer buttons; the footer shows 3 including the ${manifestActions} from the manifest`);
		for (const a of acts) if (a && typeof a.label === 'string' && [...a.label].length > 14) E('label_too_long', `row ${i}: action label "${a.label.slice(0, 20)}" is over 14 characters and vanishes from the footer`);
		// The launcher: a row's own actions may be url, composer or utility only.
		// `run` (ALLOWED_ACTION_KIND in the launcher) belongs to the manifest; sanitizeRowActions drops it from a row and the press refuses it (KIND_REFUSED).
		acts.forEach((a, j) => { if (a && a.kind === 'run') E('row_action_run', `row ${i}: actions[${j}] has kind "run". Only the app file may declare a run action; the launcher drops it from a row (use url, composer or utility)`); });
		// the launcher NAV_ARG_RE and isNavArg: view and arg are tokens, never text, and ".." anywhere is refused
		if (r.nav && typeof r.nav === 'object') for (const k of ['view', 'arg']) if (typeof r.nav[k] === 'string' && !isNavToken(r.nav[k])) E('nav_token_invalid', `row ${i}: nav.${k} ${JSON.stringify(r.nav[k].slice(0, 30))} must match [A-Za-z0-9_][A-Za-z0-9_.-]{0,63} and not contain ".."; the launcher drops the nav and the row does nothing`);
		if (r.nav && acts.length) E('nav_with_actions', `row ${i}: a row with nav must not carry actions`);
		const tileText = ['kpi_label', 'kpi_unit', 'kpi_max', 'kpi_note', 'kpi_foot'].some((k) => r[k] !== undefined && r[k] !== '');
		if (tileText && !isNum(r.kpi_value)) E('tile_without_number', `row ${i}: a tile needs a numeric kpi_value (got ${JSON.stringify(r.kpi_value)}); the launcher shows "-" and "no value"`);
		if (r.kpi_value !== undefined && r.kpi_value !== '' && !isNum(r.kpi_value)) E('tile_not_numeric', `row ${i}: kpi_value must be a number`);
	});
	for (const [p, s] of strings(rows, '$', [])) {
		const allowNl = /\.(body|copy_text|copy_value|insert|left|right|[a-z][a-z0-9_]*_lines)$/.test(p);
		const bad = allowNl ? s.replace(/\n/g, '') : s;
		if (BAD_TEXT.test(bad)) E('text_unsafe', `${p}: control, format, bidi, zero-width, tag or separator character in output`);
		if (/\{\{|\}\}/.test(s) && !/\.(insert|url_template|query_template)$/.test(p)) E('text_braces', `${p}: "{{" or "}}" in row text can be expanded by the launcher`);
	}
	return f;
}

// The shared engine's config for an app (null for a script app with no engine): used to know the views a case may name and whether the app promises a sample label.
function engineConfig(appDir) {
	try { const sd = path.join(appDir, 'scripts'), cf = fs.readdirSync(sd).find((f) => f.endsWith('__config.json')), id = cf && cf.slice(0, -'__config.json'.length); if (!cf || !fs.existsSync(path.join(sd, `${id}__engine.py`))) return null; return JSON.parse(fs.readFileSync(path.join(sd, cf), 'utf8')); } catch { return null; }
}
const SAMPLE_WORD = /sample/i;
// Rules every case must meet, whatever it expects: a run that prints nothing, a row with no title or no subtitle, or a sample-only app with no visible sample marker would otherwise pass unseen.
export function presenceProblems(rows, { sampleMode, bannerPromised, minRows, strictSubtitle } = {}) {
	const out = [], E = (code, message) => out.push({ level: 'error', code, message });
	if (!Array.isArray(rows)) return out;
	if (rows.length === 0) { E('no_rows', 'the run printed no rows: the launcher would show an empty list. Print at least one row (a not-found or setup row counts)'); return out; }
	if (minRows !== undefined && rows.length < minRows) E('too_few_rows', `expect.min_rows is ${minRows}, the run printed ${rows.length}`);
	rows.forEach((r, i) => {
		if (!r || typeof r !== 'object') return;
		if (typeof r.title !== 'string' || !r.title.trim()) E('row_title_empty', `row ${i} has no title: it draws as a blank line`);
		else if (!strictSubtitle) return;
		else if (r.subtitle !== undefined && (typeof r.subtitle !== 'string' || !r.subtitle.trim())) E('row_subtitle_empty', `row ${i} ("${r.title.slice(0, 40)}") has an empty subtitle: leave the field out or give it text`);
		else if (r.subtitle === undefined && !r.nav) E('row_subtitle_empty', `row ${i} ("${r.title.slice(0, 40)}") has no subtitle: every row needs a second line (a not-found or note row too)`);
	});
	if (sampleMode && bannerPromised && !rows.some((r) => r && ['title', 'subtitle', 'body', 'kpi_badge', 'kpi_foot', 'kpi_note'].some((k) => typeof r[k] === 'string' && SAMPLE_WORD.test(r[k])) || (r && Array.isArray(r.badges) && JSON.stringify(r.badges).match(SAMPLE_WORD)))) E('sample_marker_missing', 'this app shows sample data (fixture_banner is on) but no row says so: someone could take the rows for real data. Keep api.fixture_banner on, or put "sample" in a title, subtitle, badge or note');
	return out;
}

function readCheckConfig(appDir) {
	const file = path.join(appDir, 'check.json');
	let text;
	try { text = fs.readFileSync(file, 'utf8'); }
	catch (e) { return { error: `${file} could not be read (${e.code}). Check the file and its permissions, then run check again` }; }

	let cfg;
	try { cfg = JSON.parse(text); }
	catch { return { error: `${file} is not valid JSON. Fix it, then run check again` }; }
	if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return { error: `${file} must be a JSON object. Fix it, then run check again` };
	return { cfg };
}

// opts.shared: run every case as Bolt 182+ would, with BOLT_APP_SHARED_DIR naming a fresh export of THIS repo's kit. The rows must still match the
// golden files and the expectations, so a shared kit and an app's own copy are proven to give the same answer.
export async function checkApp(appDir, opts = {}) {
	const report = { app: path.basename(path.resolve(appDir)), host_os: hostOs(), findings: [], cases: [] };
	const { cfg, error } = readCheckConfig(appDir);
	if (error) {
		report.findings.push({ level: 'error', code: 'load_error', message: error, path: 'check.json' });
		return report;
	}
	if (!opts.shared) return checkAppRun(appDir, cfg, report, opts);
	const { exportShared } = await import('./shared.mjs');
	const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bolt-apps-shared-'));
	try {
		exportShared(path.join(base, 'bolt-apps-shared'));
		return await checkAppRun(appDir, cfg, report, { ...opts, sharedDir: path.join(base, 'bolt-apps-shared') });
	} finally { fs.rmSync(base, { recursive: true, force: true }); }
}
async function checkAppRun(appDir, cfg, report, opts) {
	const host = report.host_os;
	const top = (level, code, message, p) => report.findings.push({ level, code, message, path: p });
	let listing = null;
	try { listing = JSON.parse(fs.readFileSync(path.join(appDir, 'bolt-app.json'), 'utf8')); } catch {}
	if (listing) for (const x of platformFindings(listing)) report.findings.push(x);
	// a key only a newer Bolt reads (hero, Bolt 182): the app file must be offered only to that Bolt, because an older one refuses the whole pack
	try { const ud = path.join(appDir, 'utilities'); for (const y of fs.existsSync(ud) ? fs.readdirSync(ud).filter((f) => /\.ya?ml$/.test(f)) : []) for (const pr of assessYaml(fs.readFileSync(path.join(ud, y), 'utf8'), undefined, { pack: true, minBolt: listing?.min_bolt_version, minBoltKnown: !!listing }).problems) if (['bind_needs_newer_bolt', 'bind_too_many_refs', 'hero_src_not_picture'].includes(pr.code)) report.findings.push({ level: pr.level, code: pr.code, message: `utilities/${y}: ${pr.message}`, path: `utilities/${y}` }); } catch { /* an unreadable app file is reported below */ }
	if ('known_empty_tiles' in cfg) report.findings.push({ level: 'error', code: 'waiver_removed', message: 'check.json: known_empty_tiles no longer exists. A tiles view with rows that have no number now always fails (tile_row_without_value). Delete the key and give those rows a body in an entity_preview pane (a tile draws only for a number), as lookup-template does (ENGINE.md, "a text-only lookup result")', path: 'check.json' });
	report.findings.push(...kitGuard(appDir, cfg));
	// lookup.rows (a chained lookup) are drawn like overview rows: a row's own `copy` is not read, so Copy puts the row text on the clipboard. Only an `item` (single endpoint) honours `copy`.
	try { const sd = path.join(appDir, 'scripts'), cf = fs.readdirSync(sd).find((f) => f.endsWith('__config.json')); const ec = cf ? JSON.parse(fs.readFileSync(path.join(sd, cf), 'utf8')) : null; const ig = ec && ec.mode === 'lookup' && ec.lookup && Array.isArray(ec.lookup.rows) ? ec.lookup.rows.map((r, i) => (r && typeof r === 'object' && 'copy' in r ? `lookup.rows[${i}]` : null)).filter(Boolean) : []; if (ig.length) top('warning', 'config_copy_ignored', `${ig.join(', ')} in scripts/${cf} declare "copy", which lookup rows ignore: Copy puts the row's own text on the clipboard. Remove it, or use a lookup with a single endpoint and an "item", where "copy" works (ENGINE.md, "Buttons in lookup mode")`, `scripts/${cf}`); } catch { /* no engine config: nothing to say */ }
	try { const ud = path.join(appDir, 'utilities'); for (const y of fs.existsSync(ud) ? fs.readdirSync(ud).filter((f) => /\.ya?ml$/.test(f)) : []) { const txt = fs.readFileSync(path.join(ud, y), 'utf8'); try { parseYaml(txt); } catch (e) { top('error', 'app_file_not_yaml', `utilities/${y} cannot be read as YAML (${String(e.message).slice(0, 100)}). ${notYamlHint(txt, thinAppDir(appDir)) || 'Write plain YAML (AGENTS.md section 2), or regenerate it: python3 scripts/<id>__engine.py --emit-yaml > utilities/<id>.yaml'}`, `utilities/${y}`); } } } catch { /* no utilities folder: other checks say so */ }
	const pyc = /^python3?$/.test(cfg.interpreter || '') ? pythonCmd({ skip: [appDir] }) : null;
	// pyc.cmd is an absolute path: the case runs with a stubbed PATH, and the child must never search its own cwd (the app folder) for python
	const py = pyc ? [pyc.cmd, ...pyc.args] : (cfg.interpreter ? whichSync(cfg.interpreter) : null);
	if (!py) { top('error', 'interpreter_missing', `${cfg.interpreter || 'interpreter'} was not found on this machine`, 'check.json'); return report; }
	let script; try { script = inside(appDir, cfg.script); } catch (e) { top('error', 'path_outside_app', e.message, 'check.json'); return report; }
	if (!fs.existsSync(script)) { top('error', 'script_missing', `${cfg.script} does not exist`, 'check.json'); return report; }
	let cases = cfg.cases || [];
	if (opts.os) { cases = cases.filter((c) => (c.os || host) === opts.os); if (!cases.length) { top('error', 'no_cases_for_os', `check.json has no case for ${opts.os}`, 'check.json'); return report; } }
	if (opts.only) cases = cases.filter((c) => c.name.includes(opts.only));
	if (!cases.length) top('error', 'no_cases', 'check.json lists no cases', 'check.json');
	// A golden file that no case names is left over from a copy or a renamed case: it is never compared, so it can hide a drift.
	if (!opts.only && !opts.os) {
		const named = new Set(cases.map((c) => c.golden && path.normalize(c.golden)).filter(Boolean));
		const gd = path.join(appDir, 'golden');
		if (fs.existsSync(gd)) for (const g of fs.readdirSync(gd)) if (g.endsWith('.json') && !named.has(path.normalize(path.join('golden', g)))) top('error', 'golden_stale', `golden/${g} is not named by any case in check.json. Delete it, or add a case with "golden": "golden/${g}" (a copied template brings its goldens along: keep only the cases you want, then run check --update-golden once and review the files)`, `golden/${g}`);
	}
	const pres = presentationOf(appDir);
	for (const kase of cases) {
		const osName = kase.os || host, f = [], E = (code, message) => f.push({ level: 'error', code, message });
		let secs = 0;
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bolt-apps-check-'));
		const files = [];
		try {
			const stubDir = path.join(tmp, 'bin'), home = path.join(tmp, 'home');
			fs.mkdirSync(home);
			makeStubs(stubDir, appDir, osName, kase, files, py);
			// Sample mode: a case (or check.json as a whole) sets "fixture": true, so the script runs on its recorded answers while the shipped app stays live.
			const sample = kase.fixture ?? cfg.fixture;
			const blocked = new Set(['PATH', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH']);
			const fromCase = Object.fromEntries(Object.entries(kase.env || {}).filter(([k]) => /^[A-Z_][A-Z0-9_]*$/.test(k) && !blocked.has(k)).map(([k, v]) => [k, String(v)]));
			const winRoot = process.platform === 'win32' ? (process.env.SYSTEMROOT || 'C:\\Windows') : '';
			const homeDrive = process.platform === 'win32' && /^[A-Za-z]:/.test(home) ? home.slice(0, 2) : 'C:';
			const winEnv = process.platform === 'win32' ? { USERPROFILE: home, HOMEDRIVE: homeDrive, HOMEPATH: home.slice(homeDrive.length), SYSTEMDRIVE: homeDrive, LOGONSERVER: '\\\\BOLT', USERNAME: 'bolt', USERDOMAIN: 'BOLT', SYSTEMROOT: winRoot, WINDIR: winRoot, COMSPEC: process.env.COMSPEC || 'C:\\Windows\\System32\\cmd.exe', PATHEXT: '.COM;.EXE;.BAT;.CMD', TEMP: tmp, TMP: tmp, PYTHONUTF8: '1' } : {};
			const r = await runScript(py, script, osName, kase.args || [], { ...fromCase, ...RULES.runner_env.fixed, USER: 'bolt', LOGNAME: 'bolt', PATH: stubDir, HOME: home, ...winEnv, ...((sample === undefined || sample === 'unset') ? {} : { BOLT_APP_FIXTURE: sample ? '1' : '0' }), ...(opts.sharedDir ? { BOLT_APP_SHARED_DIR: opts.sharedDir } : {}) }, home);
			const ex = kase.expect || {};
			// check --shared: the point is to run on Bolt's shared kit, so prove it. An app that kept its own different copy (or never asks) ran on that copy and says nothing about the shared one.
			if (opts.sharedDir && !(r.kitFile && path.resolve(r.kitFile).startsWith(path.resolve(opts.sharedDir) + path.sep))) E('shared_kit_not_used', `--shared: the script ran on ${r.kitFile && r.kitFile !== '(none)' ? r.kitFile : 'a kit that is not Bolt\'s shared one'}, not the shared kit. The loader uses the shared kit only when the app's own copy has the same bytes, or the app sets WANT_SHARED = True (and KIT_MIN is met). Re-vendor the kit, or use the loader from toolkit/lib/loader.mjs`);
			secs = r.seconds;
			const maxS = ex.max_seconds ?? DEFAULT_MAX_S;
			if (r.killed) E('deadline_exceeded', `the script was still running after ${BRIDGE_LIMIT_S} s (check assumes the app file sets bridge.timeout_seconds to ${BRIDGE_LIMIT_S}); a global deadline of 14 s must bound every command`);
			else if (r.seconds > maxS) E('deadline_exceeded', `took ${r.seconds.toFixed(1)} s; this case allows ${maxS} s`);
			if (r.rc !== (ex.exit ?? 0)) E('exit_code', `exit ${r.rc}, expected ${ex.exit ?? 0}${r.err ? `; stderr: ${r.err.trim().split('\n').pop().slice(0, 160)}` : ''}`);
			let rows = null;
			try { rows = JSON.parse(r.out); } catch { E('non_json_output', `stdout is not JSON (${r.out.length} bytes)`); }
			if (rows !== null) {
				for (const x of checkRows(rows, cfg.manifest_actions ?? 1)) f.push(x);
				if ((ex.exit ?? 0) === 0) {
					const ecfg = engineConfig(appDir), sm = sample === undefined || sample === 'unset' ? !!(ecfg && ecfg.api && ecfg.api.fixture_default) : !!sample;
					for (const x of presenceProblems(rows, { sampleMode: sm && !(kase.args || []).some((a) => /^demo-/.test(a)) && rows.length > 1, bannerPromised: !!(ecfg && ecfg.api && ecfg.api.fixture_banner), minRows: ex.min_rows, strictSubtitle: !!ecfg })) f.push(x);
					const first = (kase.args || [])[0];
					if (ecfg && (ecfg.mode || 'views') === 'views' && Array.isArray(ecfg.views) && first && first !== 'overview' && !ecfg.views.some((v) => v && v.id === first) && !/^demo-/.test(first) && !ex.view_fallback) f.push({ level: 'error', code: 'case_unknown_view', message: `check.json, case "${kase.name}": args[0] "${first}" is not a view in the app's config.json (views: overview, ${ecfg.views.map((v) => v && v.id).join(', ')}). The engine would draw the overview and this case would pass without testing what you meant. Fix the view name or delete the case` });
				}
				for (const x of blankPaneProblems(pres, rows, (kase.args || [])[0] || 'overview')) f.push(x);
				if (sample === 'unset') for (const x of sampleVisibleProblems(pres, rows, (kase.args || [])[0] || 'overview')) f.push(x);
				for (const x of paneProblems(pres, rows, (kase.args || [])[0] || 'overview')) f.push(x);
				for (const x of chainProblems(rows, listing && listing.id)) f.push(x);
				if (/[^\x00-\x7f]/.test(r.out)) f.push({ level: 'warning', code: 'non_ascii_output', message: 'stdout has non-ASCII bytes; ensure_ascii JSON is safe on any console code page' });
				const flat = strings(rows, '$', []).map(([, s]) => s).join('\n');
				const bad = rows.find((r) => r && typeof r.title === 'string' && /^This app (is not set up correctly|could not run)$/.test(r.title));
				const head = rows.slice(0, 5).map((r) => `"${String(r && r.title).slice(0, 60)}"${r && r.subtitle ? ` / "${String(r.subtitle).slice(0, 80)}"` : ''}`).join('; ');
				if (bad) E('app_error_row', `the script printed its own error row instead of rows: "${bad.title}": ${String(bad.subtitle).slice(0, 300)}. Fix that first, then the expected text`);
				else for (const t of ex.text_present || []) if (!flat.includes(t)) E('expected_text_missing', `check.json, case "${kase.name}": output does not contain "${t}". The first rows were: ${head}`);
				for (const t of ex.text_absent || []) if (flat.includes(t)) E('forbidden_text_present', `output contains "${t}"`);
				// home_absent: text that must not be on disk after the run (a key echoed by the API must never reach the cache). HOME is the temporary folder of this case.
				if ((ex.home_absent || []).length) { const hits = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (e.isFile()) { const b = fs.readFileSync(f, 'utf8'); for (const t of ex.home_absent) if (b.includes(t)) hits.push(`${path.relative(home, f)} holds "${t}"`); } } }; walk(home); for (const h of hits) E('text_on_disk', `${h}. The kit strips a secret from an API answer before it is cached: call kit.redact_tree on the parsed answer`); }
				if (kase.golden) {
					const gp = path.join(appDir, kase.golden);
					if (opts.updateGolden && f.some((x) => x.level === 'error')) E('golden_not_written', 'not writing a golden from a failing run');
					else if (opts.updateGolden) { fs.mkdirSync(path.dirname(gp), { recursive: true }); fs.writeFileSync(gp, JSON.stringify(rows, null, 2) + '\n'); }
					else if (!fs.existsSync(gp)) E('golden_missing', `${kase.golden} does not exist (run with --update-golden once, then review it)`);
					else if (!deepEq(JSON.parse(fs.readFileSync(gp, 'utf8')), rows)) E('golden_mismatch', `check.json, case "${kase.name}": output differs from ${kase.golden}. If you changed the app's data or text on purpose, run: ./bolt-apps check <app-folder> --update-golden (it rewrites the goldens; read the change first)`);
				}
			}
		} catch (e) { E('check_error', String(e.message || e)); }
		finally {
			if (process.platform !== 'win32') {
				fs.rmSync(tmp, { recursive: true, force: true });
			} else {
				for (let i = 0; i < 12; i++) {
					try { fs.rmSync(tmp, { recursive: true, force: true }); break; }
					catch { if (i === 11) break; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (i + 1)); }
				}
			}
		}
		const tested = osName === host ? 'stubbed commands on this OS, not the real launcher' : `fixtures only: ${osName} behaviour was not run on a ${osName} machine`;
		report.cases.push({ name: kase.name, os: osName, seconds: Number(secs.toFixed(2)), ok: !f.some((x) => x.level === 'error'), tested, findings: f });
	}
	return report;
}

function whichSync(name) {
	if (path.isAbsolute(name)) { try { return fs.statSync(name).isFile() ? name : null; } catch { return null; } }
	const win = process.platform === 'win32';
	const exts = win ? ['', '.exe', '.com'] : [''];
	for (const d of (process.env.PATH || '').split(path.delimiter)) {
		if (!d) continue;
		for (const ext of exts) {
			const p = path.join(d, name + ext);
			try {
				if (!fs.statSync(p).isFile()) continue;
				if (!win) fs.accessSync(p, fs.constants.X_OK);
				else try { fs.accessSync(p, fs.constants.X_OK); } catch { /* win32 X_OK is not POSIX; a regular file is enough */ }
				return p;
			} catch {}
		}
	}
	return null;
}
// One line for the whole report when an expectation failed because the app's text changed (a copied template's words, an old golden): which file, and the two ways out.
export const TEMPLATE_WORDS_HINT = 'check.json still expects words or goldens from before your edit (a copied template brings its own). Edit cases[].expect.text_present in check.json to words your app prints (or delete the line), and run ./bolt-apps check <app-folder> --update-golden once your data is final; read the goldens it rewrites.';
export const reportOk = (r) => !r.findings.some((x) => x.level === 'error') && r.cases.every((c) => c.ok);
export function formatReport(r) {
	const L = [`${reportOk(r) ? 'PASS' : 'FAIL'}  ${r.app}  (host ${r.host_os})`];
	for (const f of r.findings) L.push(`  ${f.level} ${f.code}: ${f.message}`);
	for (const c of r.cases) { L.push(`  ${c.ok ? 'ok  ' : 'FAIL'} [${c.os}] ${c.name}`); for (const f of c.findings) L.push(`       ${f.level} ${f.code}: ${f.message}`); }
	if (r.cases.some((c) => c.findings.some((f) => ['expected_text_missing', 'golden_mismatch', 'golden_missing'].includes(f.code)))) L.push('', `Hint: ${TEMPLATE_WORDS_HINT}`);
	const fx = [...new Set(r.cases.filter((c) => c.os !== r.host_os).map((c) => c.os))];
	L.push('', fx.length ? `Fixture-tested only: ${fx.join(', ')}. That logic was not run on those systems.` : (r.host_os === 'windows' ? 'All cases ran with stubbed commands on this OS. Not run: the real launcher, macOS, Linux, other OS tools.' : 'All cases ran with stubbed commands on this OS. Not run: the real launcher, Windows, other OS tools.'));
	return L.join('\n');
}
