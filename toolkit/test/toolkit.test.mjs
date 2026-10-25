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
