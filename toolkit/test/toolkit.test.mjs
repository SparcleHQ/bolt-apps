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

test('gallery lint and pack check the app file the way verify does: keys, pipe steps and recognizer patterns', () => {
	const d = tmp(), key = path.join(d, 'k.pem'); run(d, 'keygen', '--out', key);
	const errors = (r) => JSON.parse(r.stdout).reports[0].findings.filter((x) => x.level === 'error').map((x) => x.code);
	const app = (id, type, edit) => { run(d, 'new', id, '--type', type, '--author', 'T'); const f = path.join(d, 'apps', id, 'utilities', `${id}.yaml`); fs.writeFileSync(f, edit(fs.readFileSync(f, 'utf8'))); return `apps/${id}`; };
	// a top-level key Bolt does not know, a company-only key and a missing required key
	const a = app('g-keys', 'transform', (s) => s.replace('emits: Generic\n', '') + 'scopes:\n  - read\nbogus_key: 1\n');
	let r = run(d, 'lint', a, '--json'); assert.equal(r.status, 1, r.stdout);
	for (const c of ['yaml_admin_only_key', 'yaml_key_unknown', 'yaml_key_missing']) assert.ok(errors(r).includes(c), c + r.stdout);
	assert.notEqual(run(d, 'pack', a, '--key', key, '--out', path.join(d, 'a.boltpack')).status, 0);
	// pipe steps: a name outside the schema list, a step with two keys, and more steps than the schema allows
	const b = app('g-pipe', 'transform', (s) => s.replace('    - upper\n', '    - frobnicate\n    - { split: ",", join: ";" }\n' + '    - trim\n'.repeat(31)));
	r = run(d, 'lint', b, '--json'); assert.equal(r.status, 1, r.stdout);
	for (const c of ['transform_step_unknown', 'transform_pipe_count']) assert.ok(errors(r).includes(c), c + r.stdout);
	assert.equal(errors(r).filter((c) => c === 'transform_step_unknown').length, 2, r.stdout);
	// each finding points at its own line of the app file, not at line 1 or at actions
	const lineOf = (id, text) => fs.readFileSync(path.join(d, 'apps', id, 'utilities', `${id}.yaml`), 'utf8').split('\n').findIndex((l) => l.includes(text)) + 1;
	const at = (r_, code) => JSON.parse(r_.stdout).reports[0].findings.filter((x) => x.code === code).map((x) => x.line);
	assert.deepEqual(at(r, 'transform_step_unknown'), [lineOf('g-pipe', 'frobnicate'), lineOf('g-pipe', 'split:')], r.stdout);
	assert.deepEqual(at(r, 'transform_pipe_count'), [lineOf('g-pipe', 'pipe:')], r.stdout);
	const rp = run(d, 'lint', b, '--personal', '--json'); assert.deepEqual(at(rp, 'transform_step_unknown'), [lineOf('g-pipe', 'frobnicate'), lineOf('g-pipe', 'split:')], rp.stdout);
	const v = JSON.parse(run(d, 'verify', b, '--json').stdout); assert.ok(v.findings.some((x) => x.code === 'transform_step_unknown' && x.fix !== 'See the message.'), JSON.stringify(v.findings));
	// an empty pipe
	const e = app('g-empty', 'transform', (s) => s.replace('  pipe:\n    - trim\n    - upper\n', '  pipe: []\n'));
	r = run(d, 'lint', e, '--json'); assert.equal(r.status, 1, r.stdout); assert.ok(errors(r).includes('transform_pipe_count'), r.stdout);
	// recognizer: more patterns than the schema allows, and one regex longer than its limit
	const c = app('g-rec', 'recognizer', (s) => s.replace('    - regex: "(TKT-\\\\d{1,6})"\n', `    - regex: "${'a'.repeat(513)}"\n` + '    - regex: "(TKT-\\\\d{1,6})"\n'.repeat(16)));
	r = run(d, 'lint', c, '--json'); assert.equal(r.status, 1, r.stdout);
	for (const x of ['recognize_patterns_count', 'recognize_regex_too_long']) assert.ok(errors(r).includes(x), x + r.stdout);
	assert.deepEqual(at(r, 'recognize_regex_too_long'), [lineOf('g-rec', 'a'.repeat(513))], r.stdout);
	assert.deepEqual(at(r, 'recognize_patterns_count'), [lineOf('g-rec', 'patterns:')], r.stdout);
	// the step names and limits come from schema/user-app.schema.json: the most steps it allows, each name it lists, pass
	const PIPE = JSON.parse(fs.readFileSync(path.join(REPO, 'schema/user-app.schema.json'), 'utf8')).properties.transform.properties.pipe;
	const names = PIPE.items.oneOf.find((o) => o.enum).enum;
	const ok = app('g-all', 'transform', (s) => s.replace('    - trim\n    - upper\n', Array.from({ length: PIPE.maxItems - 1 }, (_, i) => `    - ${names[i % names.length]}\n`).join('') + '    - { split: "," }\n'));
	r = run(d, 'lint', ok, '--json'); assert.equal(r.status, 0, r.stdout);
});
