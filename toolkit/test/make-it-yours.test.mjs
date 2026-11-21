// Run: node --test toolkit/test/make-it-yours.test.mjs
// What `new` leaves for the author: a listing and README that say they are template text, a check.json that takes nothing from the template's
// words (engine apps), and one hint line from check when an old expectation fails after an edit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pythonCmd } from '../lib/python.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const CLI = path.join(REPO, 'toolkit/bin/bolt-apps.mjs');
const EX = path.join(REPO, 'kit/examples');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bolt-myo-'));
const sh = (home, cwd, ...a) => spawnSync(process.execPath, [CLI, ...a], { cwd, encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
const PY = pythonCmd();
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const templates = fs.readdirSync(EX).filter((n) => fs.existsSync(path.join(EX, n, 'check.json')));
const engineMode = (t) => { const f = path.join(EX, t, 'scripts', `${t}__config.json`); return fs.existsSync(f) && fs.existsSync(path.join(EX, t, 'scripts', `${t}__engine.py`)) ? (readJson(f).mode || 'views') : null; };   // the shared engine only: a script with its own config.json is not one

test('new: every template gets a TODO listing and a README note, and lint warns (not fails) about the listing', () => {
	const root = tmp(), home = path.join(root, 'home'); fs.mkdirSync(home);
	for (const t of templates) {
		const id = `my-${t}`.slice(0, 40);
		const n = sh(home, root, 'new', t, id); assert.equal(n.status, 0, `${t}: ${n.stdout}${n.stderr}`);
		const listing = readJson(path.join(root, id, 'bolt-app.json'));
		for (const k of ['summary', 'role', 'saves']) assert.match(listing[k], /^TODO /, `${t}: ${k} is ${listing[k]}`);
		assert.match(fs.readFileSync(path.join(root, id, 'README.md'), 'utf8'), /^> Template text below: replace it with what your app does\./, t);
		assert.match(n.stdout, /Make it yours/, t);
		const l = sh(home, root, 'lint', id, '--personal'); assert.equal(l.status, 0, `${t}: ${l.stdout}`);
		assert.match(l.stdout, /warning listing_todo/, t);
	}
});

test('new: an engine app in views or lookup mode gets a check.json with one case per view and none of the template words', () => {
	const root = tmp(), home = path.join(root, 'home'); fs.mkdirSync(home);
	let seen = 0;
	for (const t of templates.filter((x) => ['views', 'lookup'].includes(engineMode(x)))) {
		const id = `my-${t}`.slice(0, 40);
		assert.equal(sh(home, root, 'new', t, id).status, 0, t);
		const ck = readJson(path.join(root, id, 'check.json'));
		assert.ok(ck.cases.length >= 2, t);
		for (const c of ck.cases) assert.ok(!(c.expect && (c.expect.text_present || c.expect.text_absent)) && !c.golden, `${t}: case "${c.name}" carries an expectation or a golden`);
		assert.ok(!fs.existsSync(path.join(root, id, 'golden')) || fs.readdirSync(path.join(root, id, 'golden')).length === 0, `${t}: goldens were recorded`);
		if (engineMode(t) === 'views') {
			const cfg = readJson(path.join(root, id, 'scripts', `${id}__config.json`));
			for (const v of cfg.views) assert.ok(ck.cases.some((c) => c.args[0] === v.id), `${t}: no case for view ${v.id}`);
		}
		seen++;
	}
	assert.ok(seen >= 8, `only ${seen} engine templates were covered`);
});

test('new then an edit of the data: check still passes (the cold-run 2 failure), and the sample words may all change', () => {
	const root = tmp(), home = path.join(root, 'home'); fs.mkdirSync(home);
	assert.equal(sh(home, root, 'new', 'portal-template', 'habit-log').status, 0);
	const fx = path.join(root, 'habit-log', 'scripts', 'habit-log__fixtures.json');
	const rewrite = (v) => (typeof v === 'string' ? (/^[A-Z]/.test(v) ? `${v} (mine)` : v) : Array.isArray(v) ? v.map(rewrite) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, /^(id|status|project_id)$/.test(k) ? x : rewrite(x)])) : v);
	fs.writeFileSync(fx, JSON.stringify(rewrite(readJson(fx)), null, 1));
	const c = sh(home, root, 'check', 'habit-log'); assert.equal(c.status, 0, c.stdout);
	assert.ok(!/Hint:/.test(c.stdout));
});

test('check: a failed old expectation names check.json and the case, and ends with ONE hint line', () => {
	const root = tmp(), home = path.join(root, 'home'); fs.mkdirSync(home);
	assert.equal(sh(home, root, 'new', 'script-template', 'my-app').status, 0);
	const f = path.join(root, 'my-app', 'check.json'), ck = readJson(f);
	ck.cases[0].expect = { text_present: ['Words from the template that no longer exist'] };
	ck.cases[1].expect = { text_present: ['Another stale word'] };
	fs.writeFileSync(f, JSON.stringify(ck, null, 2));
	const c = sh(home, root, 'check', 'my-app');
	assert.equal(c.status, 1);
	assert.match(c.stdout, /check\.json, case "[^"]+": output does not contain "Words from the template/);
	assert.equal((c.stdout.match(/Hint: check\.json still expects/g) || []).length, 1, c.stdout);
	assert.match(c.stdout, /--update-golden/);
});

// ---- check refuses a vacuous case: mutation tests on a copy of a views template and of a lookup template
const HOOK = `
_orig_emit = kit.emit
def _mut_emit(rows, *a, **k):
    import re as _re
    m = os.environ.get("MUT", "")
    def walk(v, f):
        if isinstance(v, str): return f(v)
        if isinstance(v, list): return [walk(x, f) for x in v]
        if isinstance(v, dict): return dict((k2, walk(x, f)) for k2, x in v.items())
        return v
    if m == "rows0": rows = []
    elif m == "title0" and rows: rows[0]["title"] = ""
    elif m == "sub0": [r.__setitem__("subtitle", "") for r in rows if "nav" not in r]
    elif m == "nosample": rows = walk(rows, lambda s: _re.sub("(?i)sample", "demo", s))
    elif m == "nonascii" and rows: rows[0]["title"] = rows[0]["title"] + " \\u00e9\\u4e2d"
    return _orig_emit(rows, *a, **k)
kit.emit = _mut_emit
`;
function mutantApp(template, id, root, home, args) {
	assert.equal(sh(home, root, 'new', template, id).status, 0, template);
	const eng = path.join(root, id, 'scripts', `${id}__engine.py`), src = fs.readFileSync(eng, 'utf8');
	fs.writeFileSync(eng, src.replace('HERE = os.path.dirname(os.path.abspath(__file__))\n', (m) => m + HOOK));
	const f = path.join(root, id, 'check.json'), ck = readJson(f);
	const base = ck.cases[0];
	return { app: path.join(root, id), set: (mut, extra = {}) => { ck.cases = [{ ...base, name: `case ${mut || 'plain'}`, args, ...(mut ? { env: { MUT: mut } } : {}), ...extra }]; fs.writeFileSync(f, JSON.stringify(ck, null, 2)); return sh(home, root, 'check', id); } };
}
for (const [template, args] of [['portal-template', ['overview']], ['lookup-template', ['New', 'York']]]) {
	test(`check refuses a vacuous run on a ${template} copy: no rows, blank title, empty subtitle, no sample label; accepts a non-ASCII title`, () => {
		const root = tmp(), home = path.join(root, 'home'); fs.mkdirSync(home);
		const m = mutantApp(template, 'mut-app', root, home, args);
		const ok = m.set(''); assert.equal(ok.status, 0, ok.stdout);
		const bad = { rows0: /no_rows/, title0: /app_error_row|row_title_empty/, sub0: /row_subtitle_empty/, nosample: /sample_marker_missing/ };
		for (const [mut, re] of Object.entries(bad)) { const r = m.set(mut); assert.equal(r.status, 1, `${mut}: ${r.stdout}`); assert.match(r.stdout, re, mut); }
		const na = m.set('nonascii'); assert.equal(na.status, 0, na.stdout);
	});
}

test('check refuses a case that names a view the config no longer has (portal copy); a lookup app has no views', () => {
	const root = tmp(), home = path.join(root, 'home'); fs.mkdirSync(home);
	const m = mutantApp('portal-template', 'mut-view', root, home, ['tickets']);
	assert.equal(m.set('').status, 0);
	const cf = path.join(m.app, 'scripts', 'mut-view__config.json'), cfg = readJson(cf);
	cfg.views = cfg.views.filter((v) => v.id !== 'tickets').map((v) => ({ ...v, children: (v.children || []).filter((c) => c.view !== 'tickets') })); cfg.overview.rows = cfg.overview.rows.filter((r) => r.view !== 'tickets'); fs.writeFileSync(cf, JSON.stringify(cfg, null, 2));
	const e = spawnSync(PY.cmd, [...PY.args, path.join(m.app, 'scripts', 'mut-view__engine.py'), '--emit-yaml'], { cwd: path.join(m.app, 'scripts'), encoding: 'utf8' }); assert.equal(e.status, 0, e.stderr); fs.writeFileSync(path.join(m.app, 'utilities', 'mut-view.yaml'), e.stdout);
	const r = m.set(''); assert.equal(r.status, 1, r.stdout); assert.match(r.stdout, /case_unknown_view[^\n]*"tickets" is not a view/);
	// the opt-in (expect.view_fallback) is exercised by acme-dash's own check.json, whose overview declares its own pane
});

test('a check.json that still carries known_empty_tiles fails with a clear message', () => {
	const root = tmp(), home = path.join(root, 'home'); fs.mkdirSync(home);
	assert.equal(sh(home, root, 'new', 'lookup-template', 'w-app').status, 0);
	const f = path.join(root, 'w-app', 'check.json'), ck = readJson(f); ck.known_empty_tiles = 'a long enough reason for the old waiver'; fs.writeFileSync(f, JSON.stringify(ck, null, 2));
	const r = sh(home, root, 'check', 'w-app'); assert.equal(r.status, 1); assert.match(r.stdout, /waiver_removed: check\.json: known_empty_tiles no longer exists/);
});

test('ship and pack --personal print lint warnings; a TODO description is a warning (not an error) with a plain line from ship', () => {
	const root = tmp(), home = path.join(root, 'home'); fs.mkdirSync(home);
	assert.equal(sh(home, root, 'new', 'lookup-template', 'ship-app').status, 0);
	const l = sh(home, root, 'lint', 'ship-app', '--personal'); assert.equal(l.status, 0, l.stdout); assert.match(l.stdout, /warning description_todo/);
	const s = sh(home, root, 'ship', 'ship-app'); assert.equal(s.status, 0, s.stdout + s.stderr);
	assert.match(s.stdout, /ok lint --personal\n[\s\S]*warning listing_todo/);
	assert.match(s.stdout, /warning description_todo/); assert.match(s.stdout, /your app description still says TODO/);
	const p = sh(home, root, 'pack', 'ship-app', '--personal', '--out', path.join(root, 'x.boltpack')); assert.equal(p.status, 0, p.stdout + p.stderr); assert.match(p.stdout, /warning listing_todo/);
	const y = path.join(root, 'ship-app', 'utilities', 'ship-app.yaml'); fs.writeFileSync(y, fs.readFileSync(y, 'utf8').replace(/^description: .*$/m, 'description: "Shows x."'));
	const cf = path.join(root, 'ship-app', 'scripts', 'ship-app__config.json'), c = readJson(cf); c.app.description = 'Shows x.'; fs.writeFileSync(cf, JSON.stringify(c, null, 2));
	assert.ok(!/description_todo/.test(sh(home, root, 'lint', 'ship-app', '--personal').stdout));
});
