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
