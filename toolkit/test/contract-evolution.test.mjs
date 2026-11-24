// Run: node --test toolkit/test/contract-evolution.test.mjs
// Guards for CONTRACT-EVOLUTION.md: every capability states the Bolt version that first reads it, what an older Bolt does, and has a sample;
// a reserved extension point is never listed as supported and lint always refuses it; `migrate` is wired and does nothing while nothing is deprecated.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessYaml } from '../lib/assess.mjs';
import { RULES } from '../lib/boltrules.mjs';
import { DEPRECATIONS, migrateText, migrateApp } from '../lib/migrate.mjs';
import { caps } from '../../scripts/build-capabilities.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const VERSION = /^0\.1\.\d+$/;

test('every row has a since-version (or none, only when it is not available) and says what an older Bolt does', () => {
	for (const r of caps.rows) {
		assert.ok(typeof r.since === 'string' && (VERSION.test(r.since) || r.since === 'none'), `${r.id}: since "${r.since}"`);
		assert.ok(typeof r.older_bolt === 'string' && r.older_bolt.length > 10, `${r.id}: older_bolt`);
		if (r.status === 'supported' || r.status === 'partial') assert.match(r.since, VERSION, `${r.id}: a row that works needs a Bolt version`);
		else assert.equal(r.since, 'none', `${r.id}: a row that is not available has no version`);
	}
});

test('a pane or kind row has a sample, or says so and names the release that adds it', () => {
	for (const r of caps.rows.filter((x) => (x.status === 'supported' || x.status === 'partial') && (x.group === 'panes' || x.group === 'layout' || x.kind))) {
		if (r.example) assert.ok(fs.existsSync(path.join(REPO, r.example)), `${r.id}: example ${r.example}`);
		else assert.ok(r.example_note && /^\d+\.\d+$/.test(r.sample_due || ''), `${r.id}: no example and no sample_due`);
	}
	const due = caps.rows.filter((r) => r.sample_due).map((r) => r.id).sort();
	assert.deepEqual(due, ['pane.graph_184', 'pane.tile_visual_from', 'pane.tile_visuals'], 'a new missing sample must be fixed, not added to the list');
});

test('a kind row carries the version the rules file gives the kind, and every kind has a row', () => {
	for (const k of RULES.widget_kinds) {
		const r = caps.rows.find((x) => x.kind === k || (x.kinds || []).includes(k));
		assert.ok(r, `kind ${k} has no capability row`);
		if (r.status === 'not supported') continue;
		assert.equal(r.since, (RULES.kind_since || {})[k] || '0.1.181', `${k}: row.since must equal kind_since in the rules`);
	}
});

test('a row with a 0.1.184 key carries since 0.1.184', () => {
	const newer = new Set();
	for (const [kind, keys] of Object.entries(RULES.right_widget.bind)) for (const [k, v] of Object.entries(keys)) if (v && v.since === '0.1.184') newer.add(`${kind}.${k}`);
	assert.ok(newer.size > 10);
	for (const r of caps.rows.filter((x) => x.since === '0.1.184')) assert.match(r.older_bolt, /0\.1\.184|kit|older/i, r.id);
});

const probeApp = ({ runtime, kind, bind }) => [`schema_version: 2`, `runtime: ${runtime}`, 'id: demo', 'chip: demo', 'title: "Demo"', 'icon: globe', 'description: "Demo"', 'emits: Generic',
	'bridge:', '  command:', '    macos: "python3 {{scripts_dir}}/demo__run.py"', '    linux: "python3 {{scripts_dir}}/demo__run.py"', '    windows: "python {{scripts_dir}}/demo__run.py"', '  parse: json', '  timeout_seconds: 20',
	'presentation:', '  widget: list', '  title_field: title', '  right_widget:', `    kind: ${kind}`, '    mode: list_data', '    bind:', ...bind.map((l) => '      ' + l)].join('\n') + '\n';
const lint = (y) => assessYaml(y, 'demo', { minBoltKnown: true, minBolt: '0.1.184' }).problems.filter((p) => p.level !== 'warning').map((p) => p.code);

test('the probe app itself is accepted (so a refusal below is about the reserved item)', () => {
	assert.deepEqual(lint(probeApp({ runtime: 'bridge', kind: 'cards', bind: ['layout: tiles', 'title: "{{row.a}}"', 'value: "{{row.v}}"'] })), []);
});

test('a reserved item is never supported, has no sample or kind of its own, and lint always refuses it', () => {
	const reserved = caps.rows.filter((r) => r.status === 'reserved');
	assert.ok(reserved.length >= 8);
	for (const r of reserved) {
		assert.equal(r.since, 'none', r.id);
		assert.ok(!r.example && !r.kind && !r.kinds && !r.keys, `${r.id}: a reserved row names no example, kind or key`);
		assert.ok(r.probe && r.probe.runtime && r.probe.kind && Array.isArray(r.probe.bind), `${r.id}: needs a probe`);
		assert.ok(lint(probeApp(r.probe)).length > 0, `${r.id}: lint accepted a reserved item`);
	}
	for (const need of ['source_http', 'source_stream', 'source_ts_bridge', 'kind_registry', 'renderer_rich']) assert.ok(reserved.some((r) => r.id === `reserved.${need}`), need);
	assert.ok(!caps.rows.some((r) => r.status === 'supported' && /^reserved\./.test(r.id)));
});

test('migrate: nothing is deprecated in 184, the command says so and writes nothing; a deprecation would be applied', () => {
	assert.deepEqual(DEPRECATIONS, []);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-'));
	fs.mkdirSync(path.join(dir, 'utilities'));
	const f = path.join(dir, 'utilities', 'a.yaml'), text = 'id: a\nold_key: 1\n';
	fs.writeFileSync(f, text);
	assert.deepEqual(migrateApp(dir).changes, []);
	assert.equal(fs.readFileSync(f, 'utf8'), text);
	const dep = [{ id: 'old_key', since: '0.1.190', remove_not_before: '0.1.192', find: /^old_key:/, replace: 'new_key:' }];
	assert.deepEqual(migrateText(text, dep).changes.map((c) => c.line), [2]);
	assert.equal(migrateApp(dir, { dryRun: true, deprecations: dep }).changes.length, 1);
	assert.equal(fs.readFileSync(f, 'utf8'), text, 'dry run writes nothing');
	migrateApp(dir, { deprecations: dep });
	assert.equal(fs.readFileSync(f, 'utf8'), 'id: a\nnew_key: 1\n');
});

test('CONTRACT-EVOLUTION.md states the rules and CAPABILITIES.md carries the version columns', () => {
	const t = fs.readFileSync(path.join(REPO, 'CONTRACT-EVOLUTION.md'), 'utf8');
	for (const h of ['## Additive only', '## Unknown keys, per Bolt version', '## Deprecation', '## Reserved extension points']) assert.ok(t.includes(h), h);
	assert.match(t, /at least two releases/);
	const c = fs.readFileSync(path.join(REPO, 'kit/examples/CAPABILITIES.md'), 'utf8');
	assert.ok(c.includes('| Since | Older Bolt |') && c.includes('## Pick the version first') && c.includes('## Do not use in this version'));
});
