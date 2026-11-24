// Cold-run fixes: what a first-time author hits. new then check for every template, a failed --emit-yaml, an app file that is not YAML.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pythonCmd, spawnPython } from '../lib/python.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const CLI = path.join(REPO, 'toolkit/bin/bolt-apps.mjs');
const EX = path.join(REPO, 'kit/examples');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bolt-coldrun-'));
const sh = (home, cwd, ...a) => spawnSync(process.execPath, [CLI, ...a], { cwd, encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
const PY = pythonCmd();
const spawnPy = (args, opts) => spawnPython(args, opts);
const templates = fs.readdirSync(EX).filter((n) => fs.existsSync(path.join(EX, n, 'check.json')));

test('new then check passes for EVERY template, and again after --emit-yaml for engine templates', () => {
	const root = tmp(), home = path.join(root, 'home'); fs.mkdirSync(home);
	assert.ok(templates.length >= 15, `found ${templates.length} templates`);
	for (const t of templates) {
		if (process.platform === 'win32' && t === 'file-insights-template') continue; // macos fixture cases name POSIX file-error strings
		const id = `cr-${t}`.slice(0, 40);
		const n = sh(home, root, 'new', t, id); assert.equal(n.status, 0, `${t}: ${n.stdout}${n.stderr}`);
		assert.match(n.stdout, /check passes/, `${t}: new must say check passes (and mean it): ${n.stdout}`);
		const eng = path.join(root, id, 'scripts', `${id}__engine.py`);
		if (fs.existsSync(eng) && fs.readFileSync(eng, 'utf8').includes('_THIN_ENTRY = True')) {   // thin (the default): regen, as the docs say
			const g = sh(home, root, 'regen', id); assert.equal(g.status, 0, `${t}: ${g.stdout}${g.stderr}`);
			const c2 = sh(home, root, 'check', id); assert.equal(c2.status, 0, `${t} after regen: ${c2.stdout}`);
		} else if (fs.existsSync(eng) && fs.readFileSync(eng, 'utf8').includes('--emit-yaml')) {
			const e = spawnPy([eng, '--emit-yaml'], { cwd: path.join(root, id, 'scripts'), encoding: 'utf8' });
			assert.equal(e.status, 0, `${t}: ${e.stderr}`);
			fs.writeFileSync(path.join(root, id, 'utilities', `${id}.yaml`), e.stdout);
			const c2 = sh(home, root, 'check', id); assert.equal(c2.status, 0, `${t} after --emit-yaml: ${c2.stdout}`);
		}
	}
});

test('new says honestly when check does not pass (never "passes")', () => {
	const src = fs.readFileSync(path.join(REPO, 'toolkit/lib/workflow.mjs'), 'utf8');
	assert.match(src, /CHECK DOES NOT PASS YET/);
	assert.match(src, /bolt\(\['check', dir\]\)/);   // a plain second run, not only --update-golden
});

test('new: sample words of the template stay out of check.json, so the first edit of the data does not break check', () => {
	const root = tmp(), home = path.join(root, 'home'); fs.mkdirSync(home);
	assert.equal(sh(home, root, 'new', 'portal-template', 'quote-box').status, 0);
	const cfg = JSON.parse(fs.readFileSync(path.join(root, 'quote-box', 'check.json'), 'utf8'));
	const text = JSON.stringify(cfg);
	for (const w of ['Example Co', 'Example Service', 'Crash on startup']) assert.ok(!JSON.stringify(cfg.cases.map((c) => c.expect && c.expect.text_present)).includes(w), w);
	assert.ok(!text.includes('Enter to retry'), 'an engine app gets one case per view and no expected text at all');
	// the author puts their own words in config and fixtures: check passes with nothing to re-record (no case names a golden)
	const f = path.join(root, 'quote-box', 'scripts', 'quote-box__fixtures.json'); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replaceAll('Example Co', 'Quote Co').replaceAll('Crash on startup', 'Boom'));
	const g = path.join(root, 'quote-box', 'scripts', 'quote-box__config.json'); fs.writeFileSync(g, fs.readFileSync(g, 'utf8').replaceAll('Example Service', 'Quotes'));
	const ok = sh(home, root, 'check', 'quote-box'); assert.equal(ok.status, 0, ok.stdout);
	// a golden the author adds later is recorded by --update-golden and compared after that
	const cj = path.join(root, 'quote-box', 'check.json'), ck = JSON.parse(fs.readFileSync(cj, 'utf8')); ck.cases[0].golden = 'golden/first.json'; fs.writeFileSync(cj, JSON.stringify(ck, null, 2));
	assert.equal(sh(home, root, 'check', 'quote-box', '--update-golden').status, 0);
	assert.equal(sh(home, root, 'check', 'quote-box').status, 0);
});

const ENGINE_APP = (root, home, id = 'lk') => { assert.equal(sh(home, root, 'new', 'lookup-template', id, '--full').status, 0); return path.join(root, id); };

test('--emit-yaml with a bad icon exits non-zero, writes nothing to stdout, names the problem and lists valid icons', () => {
	const root = tmp(), home = path.join(root, 'home'); fs.mkdirSync(home);
	const app = ENGINE_APP(root, home), cf = path.join(app, 'scripts', 'lk__config.json');
	const c = JSON.parse(fs.readFileSync(cf, 'utf8')); c.app.icon = 'tag'; fs.writeFileSync(cf, JSON.stringify(c));
	assert.ok(PY, 'Python 3.9+ is required for --emit-yaml tests');
	const pyRuns = process.platform === 'win32' ? [{ cmd: PY.cmd, args: PY.args, label: PY.label || PY.cmd }] : [{ cmd: 'python3', args: [], label: 'python3' }, { cmd: '/usr/bin/python3', args: [], label: '/usr/bin/python3' }];
	for (const py of pyRuns) {
		const r = spawnSync(py.cmd, [...py.args, path.join(app, 'scripts', 'lk__engine.py'), '--emit-yaml'], { cwd: path.join(app, 'scripts'), encoding: 'utf8' });
		assert.equal(r.status, 1, py.label); assert.equal(r.stdout, '', py.label);
		assert.match(r.stderr, /icon "tag"/); assert.match(r.stderr, /Valid icons: .*git-commit/); assert.match(r.stderr, /no app file was written/);
	}
	// an unreadable config is a failure too, not an error row
	fs.writeFileSync(cf, '{ not json');
	const r2 = spawnPy([path.join(app, 'scripts', 'lk__engine.py'), '--emit-yaml'], { cwd: path.join(app, 'scripts'), encoding: 'utf8' });
	assert.equal(r2.status, 1); assert.equal(r2.stdout, ''); assert.match(r2.stderr, /Could not read/);
});

test('run, lint and check say the app file is not YAML, and run shows the real cause from the engine', () => {
	const root = tmp(), home = path.join(root, 'home'); fs.mkdirSync(home);
	const app = ENGINE_APP(root, home), yf = path.join(app, 'utilities', 'lk.yaml');
	fs.writeFileSync(yf, '[{"title":"This app is not set up correctly"}]\n');
	const l = sh(home, root, 'lint', app, '--personal'); assert.equal(l.status, 1); assert.match(l.stdout, /yaml_unreadable_here[^\n]*is JSON, not YAML[^\n]*--emit-yaml/);
	const c = sh(home, root, 'check', app); assert.equal(c.status, 1); assert.match(c.stdout, /app_file_not_yaml[^\n]*JSON, not YAML/);
	const cf = path.join(app, 'scripts', 'lk__config.json'); const cfg = JSON.parse(fs.readFileSync(cf, 'utf8')); cfg.app.icon = 'tag'; fs.writeFileSync(cf, JSON.stringify(cfg));
	const r = sh(home, root, 'run', app, 'x', '--sample'); assert.equal(r.status, 1);
	assert.match(r.stderr, /The real cause, from the engine/); assert.match(r.stderr, /icon "tag"/);
	fs.writeFileSync(yf, '');
	assert.match(sh(home, root, 'check', app).stdout, /app file is empty/);
});

test('check warns (config_copy_ignored) when a chained lookup declares copy on a row, and not for the shipped lookup-template', () => {
	const root = tmp(), home = path.join(root, 'home'); fs.mkdirSync(home);
	const app = ENGINE_APP(root, home), cf = path.join(app, 'scripts', 'lk__config.json');
	assert.doesNotMatch(sh(home, root, 'check', app).stdout, /config_copy_ignored/);
	const c = JSON.parse(fs.readFileSync(cf, 'utf8')); assert.ok(Array.isArray(c.lookup.rows), 'the template is a chained lookup');
	c.lookup.rows[0].copy = 'serde = "1"'; fs.writeFileSync(cf, JSON.stringify(c, null, 2));
	const r = sh(home, root, 'check', app); assert.match(r.stdout, /warning config_copy_ignored: lookup\.rows\[0\]/); assert.equal(r.status, 0, 'a warning, not a failure');
});

// ---------------------------------------------------------------- the two shapes
const engineRows = (app, id, args, env = {}) => { const r = spawnPy([path.join(app, 'scripts', `${id}__engine.py`), ...args], { cwd: path.join(app, 'scripts'), encoding: 'utf8', env: { ...process.env, BOLT_APP_FIXTURE: '1', ...env } }); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };

test('views mode takes no typed query: an unknown first word shows the overview; "view word" filters; "view id" drills through children', () => {
	const root = tmp(), home = path.join(root, 'home'); fs.mkdirSync(home);
	assert.equal(sh(home, root, 'new', 'portal-template', 'pt', '--full').status, 0); const app = path.join(root, 'pt');
	const overview = engineRows(app, 'pt', []);
	assert.deepEqual(engineRows(app, 'pt', ['zzz-not-a-view']), overview, 'an unknown first word is ignored: the overview is shown');
	assert.deepEqual(engineRows(app, 'pt', ['zzz-not-a-view', 'web']), overview);
	const filtered = engineRows(app, 'pt', ['projects', 'web']);
	assert.ok(filtered.some((r) => /1 of 4 match "web"/.test(r.subtitle)), 'the word filters the list in the app');
	assert.ok(filtered.some((r) => r.nav && r.nav.arg === 'P-1'), 'a matching row drills to its detail');
	const detail = engineRows(app, 'pt', ['projects', 'P-1']);
	assert.ok(detail.some((r) => /Add SSO/.test(r.title)), 'children (the tickets) are listed under the detail');
});

test('the docs state the two shapes, the one that works and the one that does not; the capability rows exist and name this test', () => {
	const eng = fs.readFileSync(path.join(EX, 'ENGINE.md'), 'utf8'), qs = fs.readFileSync(path.join(EX, 'QUICKSTART.md'), 'utf8');
	for (const w of ['Two shapes of app: lookup or views', 'cannot take a typed query', 'Not possible in one app on 181', 'Buttons in lookup mode', 'An app that only shows sample data']) assert.ok(eng.includes(w), w);
	for (const w of ['Two shapes', 'no drill, no Back', 'build two apps', 'unless the app is sample-only by design']) assert.ok(qs.includes(w), w);
	assert.ok(!/Ship live: `api\.fixture_default` is `false`\./.test(qs), 'rule 4 no longer forbids a sample-only app');
	const caps = JSON.parse(fs.readFileSync(path.join(EX, 'capabilities.json'), 'utf8')).rows;
	for (const [id, st] of [['nav.typed_word_and_drill', 'partial'], ['actions.lookup_row', 'partial'], ['sample.offline_only', 'supported']]) { const r = caps.find((x) => x.id === id); assert.ok(r && r.status === st, id); assert.equal(r.test, 'toolkit/test/cold-run.test.mjs'); }
});

test('sample-only app: doctor and ship print the same start mode; a key_env on a sample-only app is called out', () => {
	const root = tmp(), home = path.join(root, 'home'); fs.mkdirSync(home);
	const app = ENGINE_APP(root, home), cf = path.join(app, 'scripts', 'lk__config.json');
	const c = JSON.parse(fs.readFileSync(cf, 'utf8')); c.api.fixture_default = true; delete c.api.key_env; fs.writeFileSync(cf, JSON.stringify(c, null, 2));
	const e = spawnPy([path.join(app, 'scripts', 'lk__engine.py'), '--emit-yaml'], { cwd: path.join(app, 'scripts'), encoding: 'utf8' }); assert.equal(e.status, 0, e.stderr); fs.writeFileSync(path.join(app, 'utilities', 'lk.yaml'), e.stdout);
	const d = sh(home, root, 'doctor', app), s = sh(home, root, 'ship', app);
	const line = (t) => (/Start mode: [^\n]*/.exec(t) || [''])[0].trim();
	assert.match(line(d.stdout), /sample data \(api\.fixture_default is true\), so it never contacts a service/); assert.equal(line(d.stdout), line(s.stdout), s.stdout + s.stderr);
	assert.match(line(s.stdout), /sample-only by design/);
	c.api.key_env = 'LK_KEY'; fs.writeFileSync(cf, JSON.stringify(c, null, 2));
	assert.match(line(sh(home, root, 'doctor', app).stdout), /never reads it and never goes live|never read|never goes live/);
});

test('ENGINE.md documents the 404 row, the noun key, every filter and the sample text rule; run keeps the author hint out of the app rows', () => {
	const eng = fs.readFileSync(path.join(EX, 'ENGINE.md'), 'utf8');
	for (const w of ['When the API answers 404', 'No such', 'demo-notfound', '| `whenday` |', '| `thousands` |', '| `day` |', '| `yes` |', 'This is sample data.', 'draws no Refresh row']) assert.ok(eng.includes(w), w);
	const root = tmp(), home = path.join(root, 'home'); fs.mkdirSync(home);
	assert.equal(sh(home, root, 'new', 'portal-template', 'pt').status, 0);
	const out = sh(home, root, 'run', 'pt', 'projects', '--sample').stdout;
	assert.match(out, /author note \(not shown to the person using the app\)/);
	const rows = sh(home, root, 'run', 'pt', 'projects', '--sample', '--json').stdout;
	assert.doesNotMatch(rows, /fixture_default|author note/);
	assert.match(rows, /This is sample data\./);
});

test('no example shows author-facing config text to the person using the app (sample-mode rows and goldens never name fixture_default or config.json)', () => {
	const root = tmp(), home = path.join(root, 'home'); fs.mkdirSync(home);
	let seen = 0;
	for (const t of fs.readdirSync(EX)) {
		const gd = path.join(EX, t, 'golden');
		if (fs.existsSync(gd)) for (const g of fs.readdirSync(gd)) { const txt = fs.readFileSync(path.join(gd, g), 'utf8'); seen++; assert.ok(!/fixture_default|config\.json/.test(txt), `${t}/golden/${g}`); }
	}
	assert.ok(seen > 40, `only ${seen} goldens scanned`);
	for (const [t, words] of [['around', ['Bryant', 'Park,', 'New', 'York']], ['repo-radar', ['expressjs/express']]]) {   // the sample banner row
		const out = sh(home, root, 'run', path.join(EX, t), ...words, '--sample', '--json').stdout; assert.ok(!/fixture_default|config\.json/.test(out), t);
		assert.match(out, /This is sample data/, t);
	}
	for (const [t, word] of [['around', 'zzzz-nowhere'], ['repo-radar', 'nobody/nothing']]) {   // outside the recorded sample
		const o = sh(home, root, 'run', path.join(EX, t), word, '--sample', '--json').stdout; assert.ok(!/fixture_default|config\.json/.test(o) && /This is sample data/.test(o), t + ' ' + o.slice(0, 200));
	}
});

test('new prints one line telling the author to re-record goldens after the data is final', () => {
	const root = tmp(), home = path.join(root, 'home'); fs.mkdirSync(home);
	assert.match(sh(home, root, 'new', 'portal-template', 'pt').stdout, /once your data is final, run [^\n]*check [^\n]*--update-golden/);
});
