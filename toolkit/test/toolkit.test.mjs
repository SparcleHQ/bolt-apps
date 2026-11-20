// Run: node --test toolkit/test/toolkit.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { readPack } from '../bin/bolt-apps.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '../bin/bolt-apps.mjs');
const REPO = path.resolve(HERE, '../..');
const run = (cwd, ...a) => spawnSync(process.execPath, [CLI, ...a], { cwd, encoding: 'utf8' });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bolt-apps-'));

test('every app in this repo passes the offline lint', () => {
	const r = run(REPO, 'lint', 'apps');
	assert.equal(r.status, 0, r.stdout + r.stderr);
});

for (const type of ['snippet', 'search', 'transform', 'recognizer']) {
	test(`new ${type} -> lint -> pack -> verify`, () => {
		const d = tmp(), key = path.join(d, 'k.pem');
		assert.equal(run(d, 'keygen', '--out', key).status, 0);
		assert.equal(run(d, 'new', 'demo-app', '--type', type, '--author', 'Test').status, 0);
		const l = run(d, 'lint', 'apps/demo-app'); assert.equal(l.status, 0, l.stdout + l.stderr);
		const out = path.join(d, 'demo.boltpack');
		const p = run(d, 'pack', 'apps/demo-app', '--key', key, '--out', out); assert.equal(p.status, 0, p.stderr);
		const v = run(d, 'verify', out); assert.equal(v.status, 0, v.stderr);
		assert.equal(readPack(out).meta.bundle_kind, 'util_pack');
	});
}

test('a changed file after signing is refused', () => {
	const d = tmp(), key = path.join(d, 'k.pem'), out = path.join(d, 'x.boltpack');
	run(d, 'keygen', '--out', key); run(d, 'new', 'demo-app', '--type', 'snippet'); run(d, 'pack', 'apps/demo-app', '--key', key, '--out', out);
	const raw = zlib.gunzipSync(fs.readFileSync(out)), at = raw.indexOf(Buffer.from('Hello'));
	assert.ok(at > 0); raw[at] = 'J'.charCodeAt(0);
	fs.writeFileSync(out, zlib.gzipSync(raw));
	assert.equal(run(d, 'verify', out).status, 1);
});

test('lint refuses tier 3 content, an understated tier and a missing test', () => {
	const d = tmp(); run(d, 'new', 'demo-app', '--type', 'transform');
	const f = path.join(d, 'apps/demo-app/utilities/demo-app.yaml');
	fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('runtime: transform', 'runtime: bridge'));
	assert.match(run(d, 'lint', 'apps/demo-app').stdout, /tier3_not_accepted/);
	run(d, 'new', 'b', '--type', 'recognizer');
	const j = path.join(d, 'apps/b/bolt-app.json'), a = JSON.parse(fs.readFileSync(j, 'utf8'));
	a.tier = 1; a.tests = []; fs.writeFileSync(j, JSON.stringify(a));
	const o = run(d, 'lint', 'apps/b').stdout; assert.match(o, /tier_understated/); assert.match(o, /no_tests/);
});

test('keygen never overwrites a key; pack without a key says how to make one', () => {
	const d = tmp(), key = path.join(d, 'k.pem');
	assert.equal(run(d, 'keygen', '--out', key).status, 0);
	assert.notEqual(run(d, 'keygen', '--out', key).status, 0);
	run(d, 'new', 'demo-app');
	assert.match(run(d, 'pack', 'apps/demo-app', '--key', path.join(d, 'none.pem')).stderr, /keygen/);
});

test('odd input does not crash lint: null listing, quoted runtime, symlinked bin', () => {
	const d = tmp(); run(d, 'new', 'demo-app', '--type', 'transform');
	fs.writeFileSync(path.join(d, 'apps/demo-app/bolt-app.json'), 'null');
	const n = run(d, 'lint', 'apps/demo-app', '--json'); assert.equal(n.status, 1); assert.match(n.stdout, /listing_unreadable/);
	run(d, 'new', 'q', '--type', 'transform');
	const f = path.join(d, 'apps/q/utilities/q.yaml');
	fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('runtime: transform', 'runtime: "transform"'));
	assert.equal(run(d, 'lint', 'apps/q').status, 0);
	const link = path.join(d, 'bolt-apps'); fs.symlinkSync(CLI, link);
	assert.match(spawnSync(process.execPath, [link, 'help'], { encoding: 'utf8' }).stdout, /author toolkit/);
});

test('lint reports instead of crashing on wrong-typed files', () => {
	const d = tmp(); run(d, 'new', 'a', '--type', 'snippet');
	const base = path.join(d, 'apps/a');
	fs.writeFileSync(path.join(base, 'snippets/a.json'), '[]');
	const j = path.join(base, 'bolt-app.json'), app = JSON.parse(fs.readFileSync(j, 'utf8'));
	app.permissions = 'x'; app.tests = [null, 5]; fs.writeFileSync(j, JSON.stringify(app));
	const r = run(d, 'lint', 'apps/a', '--json'); assert.equal(r.status, 1, r.stderr); assert.match(r.stdout, /bad_json/); assert.match(r.stdout, /must be an array/);
});

test('numeric-looking ids are quoted in generated YAML and pass lint', () => {
	const d = tmp(); run(d, 'new', '123', '--type', 'transform');
	assert.match(fs.readFileSync(path.join(d, 'apps/123/utilities/123.yaml'), 'utf8'), /^id: "123"/m);
	assert.equal(run(d, 'lint', 'apps/123').status, 0);
});

test('a usage error exits 2 in every command (CHECKER.md: 2 is usage or load error), run, ship, new <template> and doctor included', () => {
	const d = tmp(), nope = path.join(d, 'nope'); fs.mkdirSync(path.join(d, 'taken'));
	const cases = [['run'], ['run', nope], ['ship'], ['ship', nope], ['doctor', nope], ['new', 'system-glance', 'Not_An_Id'], ['new', 'system-glance', 'taken', '--dir', d], ['new', 'taken', '--dir', d], ['lint', nope], ['verify'], ['pack'], ['check']];
	for (const c of cases) { const r = run(d, ...c); assert.equal(r.status, 2, `${c.join(' ')}: ${r.stdout}${r.stderr}`); assert.match(r.stderr, /^bolt-apps: /, c.join(' ')); }
	assert.match(run(d, 'doctor', nope).stderr, /no app found in .*nope.*\n.*usage: \.\/bolt-apps doctor/);
	assert.deepEqual(fs.readdirSync(d), ['taken'], 'a usage error writes nothing');
});

test('lint --json and verify --json findings both carry path, file and fix; the fields each had before are unchanged', () => {
	const d = tmp(), dir = path.join(d, 'apps', 'my-snip');
	assert.equal(run(d, 'new', 'my-snip', '--dir', 'apps').status, 0);
	const j = JSON.parse(fs.readFileSync(path.join(dir, 'bolt-app.json'), 'utf8')); j.permissions.push('not_a_permission'); fs.writeFileSync(path.join(dir, 'bolt-app.json'), JSON.stringify(j));
	const l = run(d, 'lint', 'apps/my-snip', '--json'); assert.equal(l.status, 1);
	const lf = JSON.parse(l.stdout).reports[0].findings.find((x) => x.code === 'permission_unknown');
	assert.deepEqual(lf, { level: 'error', code: 'permission_unknown', message: 'unknown permission "not_a_permission"', path: 'bolt-app.json', file: 'bolt-app.json', fix: 'Remove or rename this permission.' });
	const v = run(d, 'verify', 'apps/my-snip', '--json'); assert.equal(v.status, 1);
	const vf = JSON.parse(v.stdout).findings.find((x) => x.code === 'permission_unknown');
	assert.deepEqual(vf, { level: 'error', code: 'permission_unknown', message: 'unknown permission "not_a_permission"', file: 'bolt-app.json', fix: 'Remove or rename this permission.', path: 'bolt-app.json' });
	for (const f of JSON.parse(v.stdout).findings) assert.equal(f.path, f.file);
	for (const f of JSON.parse(l.stdout).reports[0].findings) { assert.equal(f.file, f.path); assert.ok(typeof f.fix === 'string' && f.fix, JSON.stringify(f)); }
});
