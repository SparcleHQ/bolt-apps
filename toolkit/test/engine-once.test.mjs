// Run: node --test toolkit/test/engine-once.test.mjs
// The engine exists once (kit/python/bolt_app_engine.py). A thin app keeps only a short entry; the pack carries the engine once;
// an app that still has its own copy keeps working unchanged. Slice A of the engine dedup: one converted app, acme-dash.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPack } from '../bin/bolt-apps.mjs';
import { spawnPython } from '../lib/python.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const CLI = path.resolve(HERE, '../bin/bolt-apps.mjs');
const SHARED = path.join(REPO, 'kit/python/bolt_app_engine.py');
const THIN = path.join(REPO, 'kit/examples/acme-dash');
const LEGACY = path.join(REPO, 'kit/examples/table-template');   // still carries its own byte-identical copy of the engine
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bolt-engine-once-'));
const cli = (...a) => spawnSync(process.execPath, [CLI, ...a], { encoding: 'utf8' });
const FILE_WORDS = /^FILE_WORDS = .*$/m;

test('the shared engine is the old copy, changed only in the line that names the files the command hashes', () => {
	const legacy = fs.readFileSync(path.join(LEGACY, 'scripts/table-template__engine.py'), 'utf8');
	const shared = fs.readFileSync(SHARED, 'utf8');
	assert.ok(FILE_WORDS.test(legacy) && FILE_WORDS.test(shared));
	assert.equal(shared.replace(FILE_WORDS, ''), legacy.replace(FILE_WORDS, ''), 'the shared engine drifted from the copies other apps still carry: change both, or convert them');
});

test('a thin app keeps no copy of the engine, only a short entry', () => {
	const entry = fs.readFileSync(path.join(THIN, 'scripts/acme-dash__engine.py'), 'utf8');
	assert.ok(entry.split('\n').length <= 30, 'the entry must stay a few lines');
	assert.ok(!/^def /m.test(entry), 'the entry must not carry engine code');
	assert.ok(!fs.existsSync(path.join(THIN, 'scripts/acme-dash__bolt_app_engine.py')), 'the app folder must not hold the engine: the pack carries it');
});

const rows = (scriptsDir, ...args) => {
	const r = spawnPython([path.join(scriptsDir, 'acme-dash__engine.py'), ...args], { cwd: tmp(), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmp(), BOLT_APP_FIXTURE: '1' } });
	assert.equal(r.status, 0, r.stderr);
	return r.stdout;
};
const views = () => ['overview', ...JSON.parse(fs.readFileSync(path.join(THIN, 'scripts/acme-dash__config.json'), 'utf8')).views.map((v) => v.id)];

test('thin entry, packed engine and the old private copy print byte-identical rows', () => {
	// the old form: this app's folder with a full engine copy in place of the entry
	const old = tmp(); fs.cpSync(path.join(THIN, 'scripts'), old, { recursive: true });
	fs.copyFileSync(path.join(LEGACY, 'scripts/table-template__engine.py'), path.join(old, 'acme-dash__engine.py'));
	// the packed form: scripts as Bolt installs them, with the engine beside the entry
	const key = path.join(tmp(), 'k.pem'); assert.equal(cli('keygen', '--out', key).status, 0);
	const out = path.join(tmp(), 'a.boltpack'); const p = cli('pack', THIN, '--personal', '--key', key, '--out', out); assert.equal(p.status, 0, p.stdout + p.stderr);
	const files = readPack(out).files, packed = tmp();
	for (const [n, c] of files) if (n.startsWith('scripts/')) fs.writeFileSync(path.join(packed, n.slice(8)), c);
	assert.ok(fs.existsSync(path.join(packed, 'acme-dash__bolt_app_engine.py')), 'the pack must carry the engine');
	for (const v of views()) {
		const want = rows(old, v, '-');
		assert.ok(want.length > 20);
		assert.equal(rows(path.join(THIN, 'scripts'), v, '-'), want, `source checkout, view ${v}`);
		assert.equal(rows(packed, v, '-'), want, `packed, view ${v}`);
	}
});

test('the pack carries the engine exactly once, as the shared bytes', () => {
	const key = path.join(tmp(), 'k.pem'); assert.equal(cli('keygen', '--out', key).status, 0);
	const out = path.join(tmp(), 'a.boltpack'); assert.equal(cli('pack', THIN, '--personal', '--key', key, '--out', out).status, 0);
	const names = [...readPack(out).files.keys()].filter((n) => /bolt_app_engine|__engine\.py/.test(n)).sort();
	assert.deepEqual(names, ['scripts/acme-dash__bolt_app_engine.py', 'scripts/acme-dash__engine.py']);
	assert.ok(Buffer.compare(readPack(out).files.get('scripts/acme-dash__bolt_app_engine.py'), fs.readFileSync(SHARED)) === 0);
	assert.equal(cli('verify', out).status, 0);
});

test('an app that still has its own engine copy checks and packs unchanged, with no second engine', () => {
	const c = cli('check', LEGACY); assert.equal(c.status, 0, c.stdout + c.stderr);
	const key = path.join(tmp(), 'k.pem'); assert.equal(cli('keygen', '--out', key).status, 0);
	const out = path.join(tmp(), 'l.boltpack'); assert.equal(cli('pack', LEGACY, '--personal', '--key', key, '--out', out).status, 0);
	assert.deepEqual([...readPack(out).files.keys()].filter((n) => /bolt_app_engine/.test(n)), []);
});

test('the thin app passes its own check', () => {
	const c = cli('check', THIN); assert.equal(c.status, 0, c.stdout + c.stderr);
});

test('the converted app uses the canonical thin entry byte for byte', () => {
	assert.equal(fs.readFileSync(path.join(THIN, 'scripts/acme-dash__engine.py'), 'utf8'), fs.readFileSync(path.join(REPO, 'kit/python/bolt_app_engine_entry.py'), 'utf8'));
});

test('bolt-apps new --thin gives a template app the thin entry, outside the clone too, and it checks, runs and packs; without --thin it keeps its own copy', () => {
	const plain = tmp();
	assert.equal(spawnSync(process.execPath, [CLI, 'new', 'table-template', 'plain-demo'], { cwd: plain, encoding: 'utf8' }).status, 0);
	assert.ok(fs.readFileSync(path.join(plain, 'plain-demo/scripts/plain-demo__engine.py'), 'utf8').split('\n').length > 1000, 'new without --thin is unchanged');
	const root = tmp();
	const n = spawnSync(process.execPath, [CLI, 'new', 'table-template', 'thin-demo', '--thin'], { cwd: root, encoding: 'utf8' });
	assert.equal(n.status, 0, n.stdout + n.stderr);
	const dir = path.join(root, 'thin-demo');
	assert.equal(fs.readFileSync(path.join(dir, 'scripts/thin-demo__engine.py'), 'utf8'), fs.readFileSync(path.join(REPO, 'kit/python/bolt_app_engine_entry.py'), 'utf8'));
	assert.ok(!fs.existsSync(path.join(dir, 'scripts/thin-demo__bolt_app_engine.py')));
	assert.match(fs.readFileSync(path.join(dir, 'utilities/thin-demo.yaml'), 'utf8'), /thin-demo__bolt_app_engine\.py/, 'the command names the engine file so editing it asks again');
	const c = cli('check', dir); assert.equal(c.status, 0, c.stdout + c.stderr);
	const r = cli('run', dir, '--sample'); assert.equal(r.status, 0, r.stdout + r.stderr);
	const key = path.join(tmp(), 'k.pem'); assert.equal(cli('keygen', '--out', key).status, 0);
	const out = path.join(root, 't.boltpack'); assert.equal(cli('pack', dir, '--personal', '--key', key, '--out', out).status, 0);
	assert.ok(readPack(out).files.has('scripts/thin-demo__bolt_app_engine.py'));
});

test('regen writes the app file of a thin app, and the committed one is what it writes', () => {
	const before = fs.readFileSync(path.join(THIN, 'utilities/acme-dash.yaml'), 'utf8');
	const d = tmp(); fs.cpSync(THIN, d, { recursive: true });
	fs.rmSync(path.join(d, 'utilities/acme-dash.yaml'));
	const r = cli('regen', d); assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.equal(fs.readFileSync(path.join(d, 'utilities/acme-dash.yaml'), 'utf8'), before);
	const bad = tmp(); fs.cpSync(THIN, bad, { recursive: true });
	fs.writeFileSync(path.join(bad, 'scripts/acme-dash__config.json'), '{ not json');
	const f = cli('regen', bad); assert.notEqual(f.status, 0); assert.match(f.stderr, /could not generate/);
});
