// Run: node --test toolkit/test/personal.test.mjs
// Own-use packs: a tier 3 or script app packs with --personal and nothing else. The gallery rules do not move.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPack } from '../bin/bolt-apps.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '../bin/bolt-apps.mjs');
const run = (cwd, ...a) => spawnSync(process.execPath, [CLI, ...a], { cwd, encoding: 'utf8' });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bolt-personal-'));
const write = (f, c) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); };
const BRIDGE = `schema_version: 1\nruntime: bridge\nid: eagle-info\nchip: eagle\ntitle: "Eagle info"\nemits: Generic\nbridge:\n  command:\n    macos: "python3 {{scripts_dir}}/eagle.py {{view}}"\n  parse: json\n  timeout_seconds: 20\npresentation:\n  widget: list\n  title_field: title\n`;
// A script app laid out the way a tester's AI agent lays it out: listing, one User App, one flat script, author-side check files.
function scriptApp(root, over = {}) {
	const dir = path.join(root, 'apps', 'eagle-info');
	write(path.join(dir, 'bolt-app.json'), JSON.stringify({ schema_version: 1, id: 'eagle-info', title: 'Eagle info', role: 'Me', saves: 'A lookup', summary: 'Look up eagles.', author: { name: 'Tester' }, tier: 3, permissions: ['runs_commands'], tests: [], ...over }));
	write(path.join(dir, 'utilities', 'eagle-info.yaml'), BRIDGE);
	write(path.join(dir, 'scripts', 'eagle.py'), 'print("{}")\n');
	write(path.join(dir, 'check.json'), '{}'); write(path.join(dir, 'fixtures', 'macos', 'x.out'), 'x'); write(path.join(dir, 'golden', 'g.json'), '{}');
	return dir;
}
const keyed = (root) => { const k = path.join(root, 'k.pem'); assert.equal(run(root, 'keygen', '--out', k).status, 0); return k; };

test('pack of a tier 3 script app without --personal points at --personal', () => {
	const d = tmp(); scriptApp(d);
	const r = run(d, 'pack', 'apps/eagle-info', '--key', keyed(d));
	assert.equal(r.status, 1); assert.match(r.stderr, /--personal/); assert.match(r.stderr, /gallery takes tier 1 and 2/);
	assert.ok(!fs.existsSync(path.join(d, 'eagle-info.boltpack')));
});

test('gallery lint still refuses tier 3 (tier3_not_accepted stays)', () => {
	const d = tmp(); scriptApp(d);
	const r = run(d, 'lint', 'apps/eagle-info'); assert.equal(r.status, 1); assert.match(r.stdout, /tier3_not_accepted/);
});

test('pack --personal builds the layout Bolt installs, says what the app can do, and verifies', () => {
	const d = tmp(), out = path.join(d, 'e.boltpack'); scriptApp(d);
	const r = run(d, 'pack', 'apps/eagle-info', '--personal', '--key', keyed(d), '--out', out);
	assert.equal(r.status, 0, r.stderr);
	for (const re of [/run programs on your computer/, /includes a script \(eagle\.py\)/, /ask whoever installs it to confirm/, /not Admin settings/, /approved apps, Bolt refuses/]) assert.match(r.stdout, re);
	const v = readPack(out); assert.ok(v.ok, v.reason);
	// Bolt rules (pack_validate.rs): every entry sits under manifests/, with a plain path and a kind Bolt installs.
	const byPath = Object.fromEntries(v.meta.entries.map((e) => [e.path, e]));
	assert.deepEqual(Object.keys(byPath).sort(), ['manifests/scripts/eagle.py', 'manifests/utilities/eagle-info.yaml']);
	assert.equal(byPath['manifests/utilities/eagle-info.yaml'].kind, 'user_utility');
	assert.equal(byPath['manifests/scripts/eagle.py'].kind, 'script');
	assert.equal(byPath['manifests/scripts/eagle.py'].interpreter, 'python3');
	for (const e of v.meta.entries) assert.match(e.path.slice('manifests/'.length), /^[A-Za-z0-9_-][A-Za-z0-9._/-]*$/);
	assert.equal(v.meta.listing.tier, 3); assert.ok(v.meta.listing.permissions.includes('runs_commands'));
	assert.equal(v.meta.risk.level, 'high');
	assert.ok(!Object.keys(byPath).some((p) => /check\.json|fixtures|golden/.test(p)), 'author-side files are not packed');
	assert.match(run(d, 'verify', out).stdout, /valid, self-signed/);
});

test('personal packs refuse what Bolt would break or reject, with the fix in the words', () => {
	const cases = [
		['script in a folder', (dir) => write(path.join(dir, 'scripts', 'lib', 'm.py'), 'x'), /script_subfolder.*flat/s],
		['bad script name', (dir) => write(path.join(dir, 'scripts', 'a b.py'), 'x'), /script_name/],
		['missing script', (dir) => fs.rmSync(path.join(dir, 'scripts', 'eagle.py')), /script_missing.*scripts\/eagle\.py/s],
		['runtime Bolt does not accept', (dir) => write(path.join(dir, 'utilities', 'eagle-info.yaml'), BRIDGE.replace('runtime: bridge', 'runtime: wasm')), /runtime_not_allowed/],
		['action Bolt does not accept', (dir) => write(path.join(dir, 'utilities', 'eagle-info.yaml'), BRIDGE + 'actions:\n  - { id: a, kind: shell, label: A }\n'), /action_not_allowed/],
		['stray file', (dir) => write(path.join(dir, 'notes.txt'), 'x'), /unknown_file/],
	];
	for (const [name, mutate, re] of cases) {
		const d = tmp(), dir = scriptApp(d); mutate(dir);
		const r = run(d, 'pack', 'apps/eagle-info', '--personal', '--key', keyed(d));
		assert.equal(r.status, 1, `${name}: ${r.stdout}`); assert.match(r.stderr, re, name);
		assert.ok(!fs.existsSync(path.join(d, 'eagle-info.boltpack')), name);
	}
});

test('the permissions printed come from the files, not from what bolt-app.json claims', () => {
	const d = tmp(), dir = scriptApp(d, { permissions: [], tier: 1 });
	write(path.join(dir, 'utilities', 'eagle-info.yaml'), BRIDGE + 'actions:\n  - { id: o, kind: url, label: Open, url_template: "https://example.org/{{q}}" }\n  - { id: p, kind: url, label: Any, url_template: "{{link}}" }\n');
	const r = run(d, 'pack', 'apps/eagle-info', '--personal', '--key', keyed(d), '--out', path.join(d, 'e.boltpack'));
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /open links to example\.org/); assert.match(r.stdout, /open links to addresses it does not fix in advance/);
	assert.equal(readPack(path.join(d, 'e.boltpack')).meta.listing.tier, 3);
});

test('--personal also packs an ordinary tier 2 app, and a local-service app says its port', () => {
	const d = tmp(); run(d, 'new', 'up', '--type', 'transform');
	assert.equal(run(d, 'pack', 'apps/up', '--personal', '--key', keyed(d), '--out', path.join(d, 'u.boltpack')).status, 0);
	const dir = scriptApp(d); fs.rmSync(path.join(dir, 'scripts'), { recursive: true });
	write(path.join(dir, 'utilities', 'eagle-info.yaml'), 'schema_version: 1\nruntime: http_local\nid: eagle-info\nchip: eagle\ntitle: T\nemits: Generic\nhttp:\n  port: 8080\n  path: /x\npresentation:\n  widget: list\n');
	const r = run(d, 'pack', 'apps/eagle-info', '--personal', '--key', path.join(d, 'k.pem'), '--out', path.join(d, 'h.boltpack'));
	assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /service on this computer \(port 8080\)/);
});

test('the repo kit example cannot be packed yet: its vendored kit is a folder and Bolt installs scripts flat', () => {
	const REPO = path.resolve(HERE, '../..');
	const r = run(REPO, 'pack', 'kit/examples/system-glance', '--personal', '--key', keyed(tmp()), '--out', path.join(tmp(), 'x.boltpack'));
	assert.equal(r.status, 1); assert.match(r.stderr, /script_subfolder/);
});
