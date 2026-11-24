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
import { spawnPython } from '../lib/python.mjs';

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

test('lint --personal refuses an unknown or admin-only top-level key as verify does, each reported once by verify', () => {
	const d = tmp(), dir = scriptApp(d);
	write(path.join(dir, 'utilities', 'eagle-info.yaml'), BRIDGE + 'colour: blue\nscopes: [read]\n');
	const lines = BRIDGE.split('\n').length;   // the two keys are the last two lines
	const l = run(d, 'lint', 'apps/eagle-info', '--personal', '--json'), lj = JSON.parse(l.stdout);
	assert.equal(l.status, 1, l.stdout);
	const got = lj.reports[0].findings.filter((x) => /^yaml_(key_unknown|admin_only_key)$/.test(x.code)).map((x) => [x.level, x.code, x.path, x.line]);
	assert.deepEqual(got, [['error', 'yaml_key_unknown', 'utilities/eagle-info.yaml', lines], ['error', 'yaml_admin_only_key', 'utilities/eagle-info.yaml', lines + 1]]);
	const v = run(d, 'verify', 'apps/eagle-info', '--json'), vj = JSON.parse(v.stdout);
	assert.equal(v.status, 1);
	for (const c of ['yaml_key_unknown', 'yaml_admin_only_key']) assert.equal(vj.findings.filter((x) => x.code === c).length, 1, `${c} once: ${v.stdout}`);
	const p = run(d, 'pack', 'apps/eagle-info', '--personal', '--key', keyed(d), '--out', path.join(d, 'e.boltpack'));
	assert.equal(p.status, 1); assert.match(p.stderr, /yaml_key_unknown: unknown key "colour"/); assert.ok(!fs.existsSync(path.join(d, 'e.boltpack')));
	// a known top-level key is not reported
	write(path.join(dir, 'utilities', 'eagle-info.yaml'), BRIDGE + 'description: "Look up eagles"\n');
	assert.equal(run(d, 'lint', 'apps/eagle-info', '--personal').status, 0);
});

test('lint and pack skip known OS and Git leftovers regardless of case', () => {
	const d = tmp(), dir = scriptApp(d);
	for (const f of ['.DS_Store', 'thumbs.db', '.GITIGNORE', '.GIT/HEAD', 'utilities/.DS_Store', 'utilities/Desktop.ini', 'scripts/.DS_Store', 'scripts/Thumbs.db', 'scripts/sub/desktop.INI']) write(path.join(dir, f), 'x');
	const l = run(d, 'lint', 'apps/eagle-info', '--personal'); assert.equal(l.status, 0, l.stdout + l.stderr); assert.doesNotMatch(l.stdout, /unknown_file/);
	const out = path.join(d, 'e.boltpack'), p = run(d, 'pack', 'apps/eagle-info', '--personal', '--key', keyed(d), '--out', out); assert.equal(p.status, 0, p.stdout + p.stderr);
	const rp = readPack(out); assert.ok(rp.ok, rp.reason);
	assert.deepEqual([...rp.files.keys()].sort(), ['scripts/eagle-info__eagle.py', 'utilities/eagle-info.yaml']);
	// the gallery rules skip them too: a tier 2 folder opened in Finder still lints
	const g = path.join(d, 'gallery'); assert.equal(run(d, 'new', 'g-app', '--type', 'transform', '--dir', g, '--author', 'Tester').status, 0);
	write(path.join(g, 'g-app', '.DS_Store'), 'x'); write(path.join(g, 'g-app', 'utilities', '.DS_Store'), 'x');
	const gl = run(d, 'lint', path.join(g, 'g-app')); assert.equal(gl.status, 0, gl.stdout + gl.stderr);
	// any other name, dot or not, is the author's: still refused, so lint, check and run never disagree about what is in the app
	write(path.join(dir, '.notes'), 'x'); write(path.join(dir, 'Thumbs.db.bak'), 'x');
	const o = run(d, 'lint', 'apps/eagle-info', '--personal'); assert.equal(o.status, 1);
	assert.match(o.stdout, /unknown_file.*\.notes/s);
	assert.match(o.stdout, /unknown_file.*Thumbs\.db\.bak/s);
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
	// A word Bolt does not know is still refused, by lint --personal and by the gallery lint
	j.permissions = ['opens_links', 'opens_link']; write(path.join(dir, 'bolt-app.json'), JSON.stringify(j));
	for (const mode of [['--personal'], []]) {
		const g = run(d, 'lint', 'apps/eagle-info', ...mode, '--json'), codes = JSON.parse(g.stdout).reports[0].findings.filter((x) => x.code === 'permission_unknown');
		assert.deepEqual(codes.map((x) => x.message), ['unknown permission "opens_link"'], mode.join(' ') || 'gallery');
	}
});

test('the gallery lint warns about a bare opens_links that no gallery content uses', () => {
	const d = tmp(); run(d, 'new', 'acmesearch', '--type', 'search');
	const f = path.join(d, 'apps', 'acmesearch', 'bolt-app.json'), j = JSON.parse(fs.readFileSync(f, 'utf8'));
	j.permissions.push('opens_links'); write(f, JSON.stringify(j));
	const r = run(d, 'lint', 'apps/acmesearch', '--json'), found = JSON.parse(r.stdout).reports[0].findings;
	assert.equal(r.status, 0, r.stdout);
	assert.deepEqual(found.map((x) => [x.level, x.code, x.message]), [['warning', 'permission_unused', '"opens_links" is declared but nothing uses it']]);
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

test('lint refuses an app whose ids disagree: the app file name, the id in it, config app.id and bolt-app.json id', () => {
	const REPO = path.resolve(HERE, '../..');
	const d = tmp(), codes = (r) => JSON.parse(r.stdout).reports[0].findings.map((x) => `${x.level}:${x.code}`);
	assert.equal(run(d, 'new', 'portal-template', 'zz', '--dir', d, '--full').status, 0);
	const app = path.join(d, 'zz'), ud = path.join(app, 'utilities'), cfg = path.join(app, 'scripts', 'zz__config.json');
	assert.equal(run(d, 'lint', app, '--personal').status, 0);
	// a renamed app file: the file name is no longer the id the copy was made for
	fs.renameSync(path.join(ud, 'zz.yaml'), path.join(ud, 'other.yaml'));
	let r = run(d, 'lint', app, '--personal', '--json'); assert.equal(r.status, 1, r.stdout); assert.ok(codes(r).includes('error:utilities_name_mismatch'), r.stdout);
	fs.renameSync(path.join(ud, 'other.yaml'), path.join(ud, 'zz.yaml'));
	// config app.id (and chip) changed and the app file generated again from it: bolt-app.json still says zz
	const j = JSON.parse(fs.readFileSync(cfg, 'utf8')); j.app.id = 'otherid'; j.app.chip = 'otherid'; fs.writeFileSync(cfg, JSON.stringify(j, null, 2));
	const y = spawnPython(['scripts/zz__engine.py', '--emit-yaml'], { cwd: app, encoding: 'utf8' }); assert.equal(y.status, 0, y.stderr);
	fs.rmSync(path.join(ud, 'zz.yaml')); fs.writeFileSync(path.join(ud, 'otherid.yaml'), y.stdout);
	r = run(d, 'lint', app, '--personal', '--json'); assert.equal(r.status, 1, r.stdout);
	for (const c of ['error:config_id_mismatch', 'error:utilities_id_mismatch']) assert.ok(codes(r).includes(c), c + r.stdout);
	// new renames the app file of a template that has no emitter, so the copy passes as made
	const made = run(d, 'new', 'local-service-template', 'zz-local', '--dir', d); assert.equal(made.status, 0, made.stderr);
	assert.deepEqual(fs.readdirSync(path.join(d, 'zz-local', 'utilities')), ['zz-local.yaml']);
	// the "Next: edit:" and "change first:" lines name files of the copy, and each one exists there
	const named = [...made.stdout.matchAll(/^\s*(?:\d+\.\s+)?(?:edit|change first): (.+)$/gm)].flatMap((m) => m[1].split(', ')).filter((f) => /^[\w.-]+\/[\w.-]+$/.test(f));
	assert.ok(named.includes('utilities/zz-local.yaml'), made.stdout);
	for (const f of named) assert.ok(fs.existsSync(path.join(d, 'zz-local', f)), `new names ${f}, which the copy does not have:\n${made.stdout}`);
	assert.doesNotMatch(fs.readFileSync(path.join(d, 'zz-local', 'README.md'), 'utf8'), /localmodels\.yaml/);
	r = run(d, 'lint', path.join(d, 'zz-local'), '--personal', '--json'); assert.equal(r.status, 0, r.stdout); assert.ok(!codes(r).some((c) => /_mismatch$/.test(c)), r.stdout);
	// a script app not built on the engine may name its file another way: a warning, not an error
	r = run(REPO, 'lint', 'kit/examples/local-service-template', '--personal', '--json'); assert.equal(r.status, 0, r.stdout); assert.ok(codes(r).includes('warning:utilities_name_mismatch'), r.stdout);
	// the gallery: utilities/<name>.yaml carries id <name> (AGENTS.md section 9: utilities/sortu.yaml holds id sortu)
	run(d, 'new', 'g', '--type', 'transform', '--author', 'T');
	fs.renameSync(path.join(d, 'apps', 'g', 'utilities', 'g.yaml'), path.join(d, 'apps', 'g', 'utilities', 'h.yaml'));
	r = run(d, 'lint', 'apps/g', '--json'); assert.equal(r.status, 1, r.stdout); assert.ok(codes(r).includes('error:utilities_name_mismatch'), r.stdout);
});

test('an id finding never says to delete the file it asks you to generate again', () => {
	const d = tmp();
	assert.equal(run(d, 'new', 'portal-template', 'zz', '--dir', d, '--full').status, 0);
	const app = path.join(d, 'zz'), f = path.join(app, 'utilities', 'zz.yaml');
	// the file has the right name (the listing id) but another id inside
	fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^id: .*$/m, 'id: other').replace(/^chip: .*$/m, 'chip: other'));
	const r = run(d, 'lint', app, '--personal', '--json'), fs_ = JSON.parse(r.stdout).reports[0].findings;
	assert.equal(r.status, 1, r.stdout);
	const msg = (c) => { const x = fs_.find((y) => y.code === c); assert.ok(x, c + r.stdout); return x.message; };
	assert.equal(msg('utilities_name_mismatch'), 'utilities/zz.yaml holds the app "other"; the file name must be the id. Generate it again: python3 scripts/zz__engine.py --emit-yaml > utilities/zz.yaml');
	assert.equal(msg('utilities_id_mismatch'), 'utilities/zz.yaml has the id "other", but bolt-app.json and the folder name say "zz". Set app.id to zz in scripts/zz__config.json and generate the app file again as utilities/zz.yaml');
	for (const m of [msg('utilities_name_mismatch'), msg('utilities_id_mismatch')]) assert.doesNotMatch(m, /delete/);
	// a file with another name: generating utilities/zz.yaml leaves it behind, so deleting it is part of the fix
	fs.renameSync(f, path.join(app, 'utilities', 'other.yaml'));
	const r2 = run(d, 'lint', app, '--personal', '--json'), m2 = JSON.parse(r2.stdout).reports[0].findings.find((y) => y.code === 'utilities_id_mismatch');
	assert.ok(m2 && /and delete utilities\/other\.yaml$/.test(m2.message), r2.stdout);
	// a name that differs from utilities/zz.yaml only in case: on a file system that ignores case (the macOS default) writing utilities/zz.yaml lands in this
	// same file, so deleting it afterwards would delete the new one. The fix renames it instead.
	fs.renameSync(path.join(app, 'utilities', 'other.yaml'), path.join(app, 'utilities', 'ZZ.yaml'));
	const r3 = run(d, 'lint', app, '--personal', '--json'), f3 = JSON.parse(r3.stdout).reports[0].findings, m3 = (c) => f3.find((y) => y.code === c)?.message;
	assert.equal(m3('utilities_name_mismatch'), 'utilities/ZZ.yaml holds the app "other"; the file name must be the id. Rename it (the names differ only in case, so a file system that ignores case treats them as one file): mv utilities/ZZ.yaml utilities/zz.yaml, then generate it again: python3 scripts/zz__engine.py --emit-yaml > utilities/zz.yaml', r3.stdout);
	assert.equal(m3('utilities_id_mismatch'), 'utilities/ZZ.yaml has the id "other", but bolt-app.json and the folder name say "zz". Set app.id to zz in scripts/zz__config.json, rename the file (mv utilities/ZZ.yaml utilities/zz.yaml) and generate the app file again as utilities/zz.yaml', r3.stdout);
	for (const m of [m3('utilities_name_mismatch'), m3('utilities_id_mismatch')]) assert.doesNotMatch(m, /delete/);
});

test('a script app without the engine may keep its own app.id in its config: the id checks are for engine apps', () => {
	const d = tmp(), dir = scriptApp(d);
	write(path.join(dir, 'scripts', 'eagle-info__config.json'), JSON.stringify({ app: { id: 'eagle-data-source' } }));
	const r = run(d, 'lint', 'apps/eagle-info', '--personal', '--json');
	assert.equal(r.status, 0, r.stdout);
	assert.ok(!JSON.parse(r.stdout).reports[0].findings.some((x) => /_id_mismatch$/.test(x.code)), r.stdout);
});
