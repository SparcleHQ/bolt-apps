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
const BRIDGE = `schema_version: 1\nruntime: bridge\nid: eagle-info\nchip: eagle-info\ntitle: "Eagle info"\nemits: Generic\nbridge:\n  command:\n    macos: "python3 {{scripts_dir}}/eagle-info__eagle.py {{view}}"\n  parse: json\n  timeout_seconds: 20\npresentation:\n  widget: list\n  title_field: title\n`;
// A script app laid out the way a tester's AI agent lays it out: listing, one User App, one flat script, author-side check files.
function scriptApp(root, over = {}) {
	const dir = path.join(root, 'apps', 'eagle-info');
	write(path.join(dir, 'bolt-app.json'), JSON.stringify({ schema_version: 1, id: 'eagle-info', title: 'Eagle info', role: 'Me', saves: 'A lookup', summary: 'Look up eagles.', author: { name: 'Tester' }, tier: 3, permissions: ['runs_commands'], tests: [], ...over }));
	write(path.join(dir, 'utilities', 'eagle-info.yaml'), BRIDGE);
	write(path.join(dir, 'scripts', 'eagle-info__eagle.py'), 'print("{}")\n');
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
	for (const re of [/run programs on your computer/, /includes a script \(eagle-info__eagle\.py\)/, /ask whoever installs it to confirm/, /not Admin settings/, /approved apps, Bolt refuses/]) assert.match(r.stdout, re);
	const v = readPack(out); assert.ok(v.ok, v.reason);
	// Bolt rules (the launcher): every entry sits under manifests/, with a plain path and a kind Bolt installs.
	const byPath = Object.fromEntries(v.meta.entries.map((e) => [e.path, e]));
	assert.deepEqual(Object.keys(byPath).sort(), ['manifests/scripts/eagle-info__eagle.py', 'manifests/utilities/eagle-info.yaml']);
	assert.equal(byPath['manifests/utilities/eagle-info.yaml'].kind, 'user_utility');
	assert.equal(byPath['manifests/scripts/eagle-info__eagle.py'].kind, 'script');
	assert.equal(byPath['manifests/scripts/eagle-info__eagle.py'].interpreter, 'python3');
	for (const e of v.meta.entries) assert.match(e.path.slice('manifests/'.length), /^[A-Za-z0-9_-][A-Za-z0-9._/-]*$/);
	assert.equal(v.meta.listing.tier, 3); assert.ok(v.meta.listing.permissions.includes('runs_commands'));
	assert.equal(v.meta.risk.level, 'high');
	assert.ok(!Object.keys(byPath).some((p) => /check\.json|fixtures|golden/.test(p)), 'author-side files are not packed');
	assert.match(run(d, 'verify', out).stdout, /valid, self-signed/);
});

test('personal packs refuse what Bolt would break or reject, with the fix in the words', () => {
	const cases = [
		['a script folder', (dir) => write(path.join(dir, 'scripts', 'eagle-info__a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'm.py'), 'x'), /script_depth/s],
		['a bare shared script name', (dir) => write(path.join(dir, 'scripts', 'config.json'), '{}'), /script_not_namespaced/],
		['bad script name', (dir) => write(path.join(dir, 'scripts', 'a b.py'), 'x'), /script_name/],
		['missing script', (dir) => fs.rmSync(path.join(dir, 'scripts', 'eagle-info__eagle.py')), /script_missing.*scripts\/eagle-info__eagle\.py/s],
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

test('the permissions a personal pack writes into its listing pass lint and verify when bolt-app.json declares them (bare opens_links too)', () => {
	const d = tmp(), dir = scriptApp(d);
	write(path.join(dir, 'utilities', 'eagle-info.yaml'), BRIDGE + 'actions:\n  - { id: p, kind: url, label: Any, url_template: "{{link}}" }\n');
	const out = path.join(d, 'e.boltpack');
	assert.equal(run(d, 'pack', 'apps/eagle-info', '--personal', '--key', keyed(d), '--out', out).status, 0);
	const listed = readPack(out).meta.listing.permissions;
	assert.ok(listed.includes('opens_links'), JSON.stringify(listed));   // a link that is not a fixed https address is listed as plain opens_links (the listing schema allows it)
	assert.equal(run(d, 'verify', out).status, 0);
	// The same list in the folder's bolt-app.json: the folder and the pack agree
	const j = JSON.parse(fs.readFileSync(path.join(dir, 'bolt-app.json'), 'utf8')); j.permissions = listed; write(path.join(dir, 'bolt-app.json'), JSON.stringify(j));
	for (const cmd of [['lint', 'apps/eagle-info', '--personal'], ['verify', 'apps/eagle-info']]) { const r = run(d, ...cmd); assert.equal(r.status, 0, `${cmd[0]}: ${r.stdout}${r.stderr}`); assert.doesNotMatch(r.stdout, /permission_unknown/); }
	// The gallery takes it too (no permission_unknown); a word Bolt does not know is still refused
	j.permissions = ['opens_links', 'opens_link']; write(path.join(dir, 'bolt-app.json'), JSON.stringify(j));
	const g = run(d, 'lint', 'apps/eagle-info', '--personal', '--json'), codes = JSON.parse(g.stdout).reports[0].findings.filter((x) => x.code === 'permission_unknown');
	assert.deepEqual(codes.map((x) => x.message), ['unknown permission "opens_link"']);
});

test('--personal also packs an ordinary tier 2 app, and a local-service app says its port', () => {
	const d = tmp(); run(d, 'new', 'up', '--type', 'transform');
	assert.equal(run(d, 'pack', 'apps/up', '--personal', '--key', keyed(d), '--out', path.join(d, 'u.boltpack')).status, 0);
	const dir = scriptApp(d); fs.rmSync(path.join(dir, 'scripts'), { recursive: true });
	write(path.join(dir, 'utilities', 'eagle-info.yaml'), 'schema_version: 1\nruntime: http_local\nid: eagle-info\nchip: eagle-info\ntitle: T\nemits: Generic\nhttp:\n  port: 8080\n  request: { path: /x }\n  parse: json\n  timeout_seconds: 5\npresentation:\n  widget: list\n');
	const r = run(d, 'pack', 'apps/eagle-info', '--personal', '--key', path.join(d, 'k.pem'), '--out', path.join(d, 'h.boltpack'));
	assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /service on this computer \(port 8080\)/);
});

test('the repo kit example packs: its kit is vendored flat, one file in scripts/', () => {
	const REPO = path.resolve(HERE, '../..');
	const r = run(REPO, 'pack', 'kit/examples/system-glance', '--personal', '--key', keyed(tmp()), '--out', path.join(tmp(), 'x.boltpack'));
	assert.equal(r.status, 0, r.stderr + r.stdout);
});

test('gallery lint also refuses a transform app with a detect block or a loose link; a non-letter action kind is a finding, not a crash', () => {
	const d = tmp(); run(d, 'new', 'g', '--type', 'transform');
	const f = path.join(d, 'apps/g/utilities/g.yaml'), base = fs.readFileSync(f, 'utf8');
	fs.writeFileSync(f, base + 'detect:\n  binary: foo\n');
	assert.match(run(d, 'lint', 'apps/g').stdout, /tier3_not_accepted/);
	fs.writeFileSync(f, base + 'actions:\n  - { id: a, kind: url, label: A, url_template: "{{x}}" }\n');
	assert.match(run(d, 'lint', 'apps/g').stdout, /tier3_not_accepted/);
	fs.writeFileSync(f, base + 'actions:\n  - { id: a, kind: run, label: A, command: "x" }\n');
	assert.match(run(d, 'lint', 'apps/g').stdout, /tier3_not_accepted/);
	fs.writeFileSync(f, base + 'actions:\n  - { id: a, kind: 5, label: A }\n');
	const r = run(d, 'lint', 'apps/g', '--personal'); assert.doesNotMatch(r.stderr, /TypeError/); assert.match(r.stdout, /action_not_allowed/);
});

test('lint cannot be fooled by YAML it cannot read: a space before the colon, an anchor, a block scalar (gallery and personal)', () => {
	const d = tmp(); run(d, 'new', 'g', '--type', 'transform');
	const f = path.join(d, 'apps/g/utilities/g.yaml'), base = fs.readFileSync(f, 'utf8');
	for (const extra of ['detect : { binary: git }\n', 'actions:\n  - { id: a, kind : run, label: A }\n', 'detect: &d { binary: git }\n']) {
		fs.writeFileSync(f, base + extra);
		for (const flag of [[], ['--personal']]) { const r = run(d, 'lint', 'apps/g', ...flag); assert.equal(r.status, 1, extra + r.stdout); assert.match(r.stdout, /yaml_unreadable_here/); }
	}
});

test('a failed gallery pack of a tier 3 app or an app with scripts/ ends with the --personal hint', () => {
	const HINT = /The gallery takes tier 1 and 2 only\. Use `pack --personal` to build a pack for your own use\./;
	const d = tmp(); scriptApp(d); const key = keyed(d);
	// tier 3 app that also has an unpackable helper folder: personal lint fails too, so only the general hint can fire
	write(path.join(d, 'apps', 'eagle-info', 'scripts', 'lib', 'm.py'), 'x');
	assert.match(run(d, 'pack', 'apps/eagle-info', '--key', key).stderr, HINT);
	// a tier 2 app with a stray scripts/ folder
	run(d, 'new', 'plain', '--type', 'transform'); write(path.join(d, 'apps', 'plain', 'scripts', 'x.sh'), 'x');
	assert.match(run(d, 'pack', 'apps/plain', '--key', key).stderr, HINT);
	// a tier 2 app that fails for another reason, with no scripts/: no hint
	run(d, 'new', 'other', '--type', 'transform'); write(path.join(d, 'apps', 'other', 'notes.txt'), 'x');
	const r = run(d, 'pack', 'apps/other', '--key', key); assert.equal(r.status, 1); assert.doesNotMatch(r.stderr, /personal/);
});
