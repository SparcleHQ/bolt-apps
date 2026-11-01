// Run: node --test toolkit/test/yaml-subset.test.mjs
// The YAML reader is an allowlist. Anything outside the supported subset is "unknown" (tier 3), never a lower tier.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessYaml, unreadable } from '../lib/assess.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '../bin/bolt-apps.mjs');
const run = (cwd, ...a) => spawnSync(process.execPath, [CLI, ...a], { cwd, encoding: 'utf8' });
const BASE = 'schema_version: 1\nruntime: transform\nid: g\nchip: g\ntitle: G\nemits: Generic\npresentation:\n  widget: detail\ntransform:\n  pipe:\n    - trim\n';
const CORPUS = {
	anchor: BASE + 'detect: &d { binary: git }\n',
	alias: BASE + 'actions:\n  - *x\n',
	tag: BASE + 'emits2: !!str Generic\n',
	'space before colon': BASE + 'detect : { binary: git }\n',
	'space before colon in a list item': BASE + 'actions:\n  - { id: a, kind : run, label: A }\n',
	'quoted key after a dash': BASE + 'actions:\n  - "kind": run\n',
	'quoted key in a flow map': BASE + 'actions:\n  - { "kind": run }\n',
	'single-quoted key': BASE + "'detect': { binary: git }\n",
	'bare CR': BASE.replace('title: G', 'title: G\rdetect: { binary: git }'),
	'NEL separator': BASE.replace('title: G', 'title: G\u0085detect: { binary: git }'),
	'LS separator': BASE.replace('title: G', 'title: G detect: { binary: git }'),
	'PS separator': BASE.replace('title: G', 'title: G detect: { binary: git }'),
	BOM: '﻿' + BASE,
	'block scalar >-': BASE + 'description: >-\n  hello\n',
	'block scalar |2-': BASE + 'description: |2-\n  hello\n',
	'block scalar -| order': BASE + 'description: |-2\n  hello\n',
	'tab indent': BASE.replace('  widget: detail', '\twidget: detail'),
	'duplicate key': BASE + 'runtime: bridge\n',
	'duplicate key in a flow map': BASE + 'actions:\n  - { id: a, id: b, kind: run }\n',
	'merge key': BASE + '<<: {}\n',
	directive: '%YAML 1.2\n' + BASE,
	'document marker': '---\n' + BASE,
	'second document': BASE + '---\nruntime: bridge\n',
	'flow document': '{ runtime: bridge }\n',
	'multi-line plain scalar': BASE + 'description: first\n  second\n',
	'escape sequence': BASE.replace('title: G', 'title: "G\\u0041"'),
	'text after a value': BASE + 'description: "a" b\n',
	'line over 64 KB': BASE + 'description: ' + 'a'.repeat(70000) + '\n',
	'file over 1 MB': BASE + Array.from({ length: 60000 }, (_, i) => `# ${'x'.repeat(20)}${i}`).join('\n') + '\n',
	'unterminated string': BASE + 'description: "abc\n',
	'deep flow nesting': BASE + 'x: ' + '['.repeat(50) + ']'.repeat(50) + '\n',
};
for (const [name, y] of Object.entries(CORPUS)) {
	test(`unreadable (never lower): ${name}`, () => {
		assert.ok(unreadable(y).length > 0, 'reader must refuse');
		const a = assessYaml(y, 'g'); assert.equal(a.unknown, true); assert.equal(a.tier, 3);
	});
}

test('lint (gallery and personal) refuses every corpus file with yaml_unreadable_here', () => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bolt-yaml-')); run(d, 'new', 'g', '--type', 'transform');
	const f = path.join(d, 'apps/g/utilities/g.yaml');
	for (const [name, y] of Object.entries(CORPUS)) for (const flag of [[], ['--personal']]) {
		fs.writeFileSync(f, y); const r = run(d, 'lint', 'apps/g', ...flag);
		assert.equal(r.status, 1, `${name} ${flag}`); assert.match(r.stdout, /yaml_unreadable_here/, name);
	}
});

test('the reader is linear: pathological lines finish fast', () => {
	const t0 = Date.now();
	for (const y of [BASE + 'x: "' + '\\\\'.repeat(30000) + '\n', BASE + 'x: ' + 'a: '.repeat(20000) + '\n', BASE + 'x:' + ' '.repeat(60000) + '#\n', BASE + 'k: {' + 'a: 1, '.repeat(9000) + '}\n', BASE + 'x: ' + "'".repeat(60000) + '\n']) unreadable(y);
	assert.ok(Date.now() - t0 < 1500, `${Date.now() - t0} ms`);
});

test('comments and quoted text that mention kind, detect or url_template change nothing', () => {
	const y = BASE + '# detect: { binary: git }\n# kind: run\ndescription: "kind: run, url_template: {{x}}, detect:"\nactions:\n  - { id: a, kind: composer, label: "kind: url" } # kind: run\n';
	const a = assessYaml(y, 'g'); assert.equal(a.unknown, false); assert.equal(a.tier, 2);
	assert.deepEqual(a.permissions.filter((p) => /run|detect|opens/.test(p)), []);
});

test('each action is judged with ITS OWN url_template and target_chip', () => {
	const two = BASE + 'actions:\n  - { id: a, kind: url, label: A, url_template: "https://ok.example/x" }\n  - { id: b, kind: url, label: B, url_template: "{{link}}" }\n';
	assert.ok(assessYaml(two, 'g').permissions.includes('opens_any_link'));
	const swapped = BASE + 'actions:\n  - { id: a, kind: url, label: A }\n  - { id: b, kind: composer, label: B, url_template: "https://ok.example/x" }\n';
	assert.ok(assessYaml(swapped, 'g').permissions.includes('opens_any_link'), 'a url action with no template of its own is loose');
	const util = BASE + 'actions:\n  - { id: a, kind: utility, label: A, target_chip: one }\n  - { id: b, kind: utility, label: B, target_chip: two }\n  - { id: c, kind: utility, label: C }\n';
	assert.deepEqual(assessYaml(util, 'g').permissions.filter((p) => p.startsWith('routes_to_app')), ['routes_to_app:', 'routes_to_app:one', 'routes_to_app:two']);
	const block = BASE + 'actions:\n  - id: a\n    kind: url\n    url_template: "https://ok.example/{{q}}"\n  - id: b\n    kind: run\n';
	const a = assessYaml(block, 'g'); assert.ok(a.permissions.includes('opens_links:ok.example') && a.permissions.includes('runs_own_command_on_press'));
});

test('Windows line endings and emoji joiners are fine; a lone CR still is not', () => {
	assert.deepEqual(unreadable(BASE.replace(/\n/g, '\r\n')), []);
	assert.deepEqual(unreadable(BASE.replace('title: G', 'title: "\u{1F468}\u200D\u{1F469}\u200D\u{1F467} Family"')), []);
	assert.ok(unreadable(BASE.replace('title: G', 'title: G\rx: 1')).length);
});

test('review fixes: scripts-only is empty, comments do not name scripts, long app names, fixed https links are permissions', () => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bolt-yaml-')); run(d, 'new', 'g', '--type', 'transform');
	const dir = path.join(d, 'apps/g'), f = path.join(dir, 'utilities/g.yaml'), base = fs.readFileSync(f, 'utf8');
	fs.mkdirSync(path.join(dir, 'scripts')); fs.writeFileSync(path.join(dir, 'scripts/x.py'), 'x');
	fs.writeFileSync(f, base + '# was {{scripts_dir}}/old.py\n');
	assert.match(run(d, 'lint', 'apps/g', '--personal').stdout, /script_unused/);
	assert.doesNotMatch(run(d, 'lint', 'apps/g', '--personal').stdout, /script_missing/);
	fs.rmSync(f); assert.match(run(d, 'lint', 'apps/g', '--personal').stdout, /empty_app/);
	fs.writeFileSync(path.join(dir, 'utilities', 'a'.repeat(90) + '.yaml'), base);
	assert.match(run(d, 'lint', 'apps/g', '--personal').stdout, /at most 100 bytes/);
	fs.rmSync(path.join(dir, 'utilities', 'a'.repeat(90) + '.yaml')); fs.writeFileSync(f, base + 'actions:\n  - { id: a, kind: url, label: A, url_template: "https://evil.example/x" }\n');
	const j = JSON.parse(run(d, 'lint', 'apps/g', '--json').stdout); assert.ok(JSON.stringify(j).includes('permission_undeclared') && JSON.stringify(j).includes('opens_links:evil.example'));
});

test('a gallery transform with a composer or utility action still lints clean', () => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bolt-yaml-')); run(d, 'new', 'g', '--type', 'transform');
	const f = path.join(d, 'apps/g/utilities/g.yaml');
	fs.writeFileSync(f, fs.readFileSync(f, 'utf8') + 'actions:\n  - { id: a, kind: composer, label: A }\n  - { id: b, kind: utility, label: B, target_chip: other }\n');
	const r = run(d, 'lint', 'apps/g'); assert.equal(r.status, 0, r.stdout);
});

test('many keys parse in linear time, and a missing runtime is one finding', () => {
	const t0 = Date.now(), keys = Array.from({ length: 40000 }, (_, i) => `k${i}: 1`).join('\n');
	assert.ok(unreadable(BASE + keys + '\n').length === 0); assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
	assert.equal(assessYaml(BASE.replace('runtime: transform\n', ''), 'g').problems.length, 0);
});
test('a fixed https link with a port is a declarable permission; a long script name is a finding', () => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bolt-yaml-')); run(d, 'new', 'g', '--type', 'transform');
	const dir = path.join(d, 'apps/g'), f = path.join(dir, 'utilities/g.yaml'), j = path.join(dir, 'bolt-app.json');
	fs.writeFileSync(f, fs.readFileSync(f, 'utf8') + 'actions:\n  - { id: a, kind: url, label: A, url_template: "https://api.example.com:8443/x" }\n');
	const app = JSON.parse(fs.readFileSync(j, 'utf8')); app.permissions.push('opens_links:api.example.com:8443'); fs.writeFileSync(j, JSON.stringify(app));
	assert.equal(run(d, 'lint', 'apps/g').status, 0, run(d, 'lint', 'apps/g').stdout);
	fs.mkdirSync(path.join(dir, 'scripts')); fs.writeFileSync(path.join(dir, 'scripts', 'a'.repeat(90) + '.py'), 'x');
	assert.match(run(d, 'lint', 'apps/g', '--personal').stdout, /at most 100 bytes/);
});

test('an app file with no id is field_missing in both modes', () => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bolt-yaml-')); run(d, 'new', 'g', '--type', 'transform');
	const f = path.join(d, 'apps/g/utilities/g.yaml'); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^id:.*\n/m, ''));
	for (const flag of [[], ['--personal']]) assert.match(run(d, 'lint', 'apps/g', ...flag).stdout, /field_missing: id is required/);
});

test('a missing runtime is field_missing; .DS_Store and __pycache__ in scripts/ are ignored; a long trailing-space line is fast', () => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bolt-yaml-')); run(d, 'new', 'g', '--type', 'transform');
	const dir = path.join(d, 'apps/g'), f = path.join(dir, 'utilities/g.yaml'), base = fs.readFileSync(f, 'utf8');
	fs.writeFileSync(f, base.replace(/^runtime:.*\n/m, ''));
	assert.match(run(d, 'lint', 'apps/g', '--personal').stdout, /field_missing: runtime is required/);
	fs.writeFileSync(f, base); fs.mkdirSync(path.join(dir, 'scripts', '__pycache__'), { recursive: true }); fs.writeFileSync(path.join(dir, 'scripts', '.DS_Store'), 'x');
	assert.equal(run(d, 'lint', 'apps/g', '--personal').status, 0, run(d, 'lint', 'apps/g', '--personal').stdout);
	const t0 = Date.now(); unreadable(BASE + 'description: a' + ' '.repeat(60000) + 'b\n'); assert.ok(Date.now() - t0 < 500);
});

test('final minors: backslash host, empty id, gallery missing runtime, message points at a real section', () => {
	assert.ok(assessYaml(BASE + 'actions:\n  - { id: a, kind: url, label: A, url_template: "https://evil.example\\\\good.example/x" }\n', 'g').permissions.includes('opens_any_link'));
	assert.ok(assessYaml(BASE + 'actions:\n  - { id: a, kind: url, label: A, url_template: "https://ok .example/x" }\n', 'g').permissions.includes('opens_any_link'));
	const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bolt-yaml-')); run(d, 'new', 'g', '--type', 'transform');
	const f = path.join(d, 'apps/g/utilities/g.yaml'), base = fs.readFileSync(f, 'utf8');
	fs.writeFileSync(f, base.replace(/^id:.*\n/m, 'id: ""\n'));
	for (const flag of [[], ['--personal']]) assert.match(run(d, 'lint', 'apps/g', ...flag).stdout, /field_missing: id is required/);
	fs.writeFileSync(f, base.replace(/^runtime:.*\n/m, ''));
	const g = run(d, 'lint', 'apps/g').stdout; assert.match(g, /field_missing: runtime is required/); assert.doesNotMatch(g, /tier3_not_accepted/);
	fs.writeFileSync(f, base + 'detect : { binary: git }\n');
	const m = /AGENTS\.md section (\w+)/.exec(run(d, 'lint', 'apps/g').stdout)[1];
	assert.match(fs.readFileSync(path.resolve(HERE, '../../AGENTS.md'), 'utf8'), new RegExp(`^## ${m}\\.`, 'm'));
});

test('the --personal hint appears only for a real tier 3 app, not for a stray file in a tier 2 app', () => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bolt-yaml-')); run(d, 'new', 'g', '--type', 'transform');
	fs.writeFileSync(path.join(d, 'apps/g/check.json'), '{}'); run(d, 'keygen', '--out', path.join(d, 'k.pem'));
	const r = run(d, 'pack', 'apps/g', '--key', path.join(d, 'k.pem'));
	assert.equal(r.status, 1); assert.doesNotMatch(r.stderr, /tier 3/); assert.match(r.stderr, /unknown_file/);
});
