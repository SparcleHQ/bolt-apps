// Run: node --test toolkit/test/upgrade-kit.test.mjs
// `bolt-apps upgrade-kit` moves an app with a private copy of the engine to the thin entry (slice B of the engine dedup): only the engine file and the
// command line of the app file change; an edited engine is never replaced; it is idempotent; `new` gives a thin app by default.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readPack } from '../bin/bolt-apps.mjs';
import { REPO, CLI, tmp, fullCopyApp, snapshot } from './engine-helpers.mjs';

const cli = (...a) => spawnSync(process.execPath, [CLI, ...a], { encoding: 'utf8' });
const ENTRY = fs.readFileSync(path.join(REPO, 'kit/python/bolt_app_engine_entry.py'), 'utf8');
const checkJson = (d) => { const r = cli('check', d, '--json'); const j = JSON.parse(r.stdout); const strip = (o) => (Array.isArray(o) ? o.map(strip) : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'seconds').map(([k, v]) => [k, strip(v)])) : o); return strip(j); };

test('converts a byte-identical private copy: engine file becomes the entry, everything else is untouched, check output is identical', () => {
	const d = fullCopyApp();
	const before = snapshot(d), checkBefore = checkJson(d);
	assert.equal(checkBefore.ok, true);
	const r = cli('upgrade-kit', d);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.match(r.stdout, /converted acme-dash: scripts\/acme-dash__engine\.py \d+ -> 21 lines \(\d+ removed\)/);
	const after = snapshot(d);
	const changed = Object.keys(before).filter((k) => before[k] !== after[k]).sort();
	assert.deepEqual(changed, ['scripts/acme-dash__engine.py', 'utilities/acme-dash.yaml'], 'config, fixtures, golden, check.json and bolt-app.json are not touched');
	assert.equal(fs.readFileSync(path.join(d, 'scripts/acme-dash__engine.py'), 'utf8'), ENTRY);
	assert.ok(!fs.existsSync(path.join(d, 'scripts/acme-dash__bolt_app_engine.py')), 'the pack carries the engine, not the folder');
	const y0 = Buffer.from(before['utilities/acme-dash.yaml'], 'hex').toString(), y1 = fs.readFileSync(path.join(d, 'utilities/acme-dash.yaml'), 'utf8');
	assert.equal(y1, y0.replace(/^(\s+(?:macos|linux|windows): ".*)"$/gm, '$1 {{scripts_dir}}/acme-dash__bolt_app_engine.py"'), 'only the command lines change: they also name the engine file');
	assert.deepEqual(checkJson(d), checkBefore);
});

test('refuses an edited engine, says why, and changes nothing', () => {
	const d = fullCopyApp();
	const eng = path.join(d, 'scripts/acme-dash__engine.py');
	fs.appendFileSync(eng, '\n# my own tweak\n');
	const before = snapshot(d);
	const r = cli('upgrade-kit', d);
	assert.equal(r.status, 1);
	assert.match(r.stdout, /REFUSED acme-dash: .*not byte for byte the known engine/);
	assert.deepEqual(snapshot(d), before);
});

test('refuses when the app file was edited by hand (a regenerate would lose the edit), and changes nothing', () => {
	const d = fullCopyApp();
	const y = path.join(d, 'utilities/acme-dash.yaml');
	fs.writeFileSync(y, fs.readFileSync(y, 'utf8') + '# hand note\n');
	const before = snapshot(d);
	const r = cli('upgrade-kit', d);
	assert.equal(r.status, 1);
	assert.match(r.stdout, /REFUSED acme-dash: .*not what the engine generates/);
	assert.deepEqual(snapshot(d), before);
});

test('an app that is already thin is left alone', () => {
	const d = path.join(tmp(), 'acme-dash'); fs.cpSync(path.join(REPO, 'kit/examples/acme-dash'), d, { recursive: true });
	const before = snapshot(d);
	const r = cli('upgrade-kit', d);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.match(r.stdout, /already thin/);
	assert.deepEqual(snapshot(d), before);
});

test('idempotent: a second run changes nothing', () => {
	const d = fullCopyApp();
	assert.equal(cli('upgrade-kit', d).status, 0);
	const once = snapshot(d);
	const r = cli('upgrade-kit', d);
	assert.equal(r.status, 0);
	assert.match(r.stdout, /already thin/);
	assert.deepEqual(snapshot(d), once);
});

test('--all over a folder of apps converts the plain ones, leaves thin and non-engine apps, refuses the edited one, and exits 1 for it', () => {
	const parent = tmp();
	const a = fullCopyApp('table-template', parent), b = fullCopyApp('chart-template', parent), bad = fullCopyApp('feed-template', parent);
	fs.appendFileSync(path.join(bad, 'scripts/feed-template__engine.py'), '# edited\n');
	fs.cpSync(path.join(REPO, 'kit/examples/acme-dash'), path.join(parent, 'acme-dash'), { recursive: true });
	fs.cpSync(path.join(REPO, 'kit/examples/around'), path.join(parent, 'around'), { recursive: true });
	const badBefore = snapshot(bad);
	const r = cli('upgrade-kit', '--all', '--dir', parent);
	assert.equal(r.status, 1, r.stdout + r.stderr);
	assert.match(r.stdout, /converted table-template/);
	assert.match(r.stdout, /converted chart-template/);
	assert.match(r.stdout, /REFUSED feed-template/);
	assert.match(r.stdout, /unchanged acme-dash: already thin/);
	assert.match(r.stdout, /2 converted \(\d+ lines removed\), 1 already thin, 1 refused, 1 without an engine/);
	for (const d of [a, b]) assert.equal(fs.readFileSync(path.join(d, 'scripts', `${path.basename(d)}__engine.py`), 'utf8'), ENTRY);
	assert.deepEqual(snapshot(bad), badBefore);
	assert.equal(cli('check', a).status, 0);
});

test('usage errors: no target, both a folder and --all, and a folder that is not an app', () => {
	assert.equal(cli('upgrade-kit').status, 2);
	assert.equal(cli('upgrade-kit', '--all', tmp()).status, 2);
	assert.equal(cli('upgrade-kit', tmp()).status, 2);
});

test('new gives a thin app by default; --full keeps a private copy that runs by hand', () => {
	const root = tmp();
	const n = spawnSync(process.execPath, [CLI, 'new', 'table-template', 'thin-by-default'], { cwd: root, encoding: 'utf8' });
	assert.equal(n.status, 0, n.stdout + n.stderr);
	const d = path.join(root, 'thin-by-default');
	assert.equal(fs.readFileSync(path.join(d, 'scripts/thin-by-default__engine.py'), 'utf8'), ENTRY);
	assert.match(n.stdout, /regen/);
	assert.equal(cli('check', d).status, 0);
	const f = spawnSync(process.execPath, [CLI, 'new', 'table-template', 'full-copy', '--full'], { cwd: root, encoding: 'utf8' });
	assert.equal(f.status, 0, f.stdout + f.stderr);
	assert.ok(fs.readFileSync(path.join(root, 'full-copy/scripts/full-copy__engine.py'), 'utf8').split('\n').length > 1000);
	assert.equal(cli('check', path.join(root, 'full-copy')).status, 0);
});

test('an old full-copy app still checks and packs, with no second engine in the pack', () => {
	const d = fullCopyApp();
	const c = cli('check', d); assert.equal(c.status, 0, c.stdout + c.stderr);
	const key = path.join(tmp(), 'k.pem'); assert.equal(cli('keygen', '--out', key).status, 0);
	const out = path.join(tmp(), 'o.boltpack'); assert.equal(cli('pack', d, '--personal', '--key', key, '--out', out).status, 0);
	assert.deepEqual([...readPack(out).files.keys()].filter((n) => /bolt_app_engine/.test(n)), []);
});

test('a thin app whose app file holds another id is told to regen, not to run the entry by hand', () => {
	const root = tmp();
	assert.equal(spawnSync(process.execPath, [CLI, 'new', 'portal-template', 'zz', '--dir', root], { encoding: 'utf8' }).status, 0);
	const f = path.join(root, 'zz/utilities/zz.yaml');
	fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^id: .*$/m, 'id: other').replace(/^chip: .*$/m, 'chip: other'));
	const r = cli('lint', path.join(root, 'zz'), '--personal', '--json');
	const msg = JSON.parse(r.stdout).reports[0].findings.find((x) => x.code === 'utilities_name_mismatch').message;
	assert.match(msg, /generate it again: \.\/bolt-apps regen <app folder>/i);
	assert.doesNotMatch(msg, /python3 scripts/);
});
