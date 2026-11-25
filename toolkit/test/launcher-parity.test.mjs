// Run: node --test toolkit/test/launcher-parity.test.mjs
// schema/bolt-rules.json, the schema and the docs must equal a pinned snapshot of the launcher constants at Bolt 0.1.181
// (conformance/launcher-constants.json, read from the launcher source, not run live).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RULES } from '../lib/boltrules.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
const snap = JSON.parse(read('conformance/launcher-constants.json'));
const at = (o, p) => p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);

test('every launcher constant in the snapshot equals the rules file', () => {
	for (const [k, v] of Object.entries(snap.constants)) assert.deepEqual(at(RULES, k), v, `bolt-rules.json ${k}`);
	assert.ok(Object.keys(snap.constants).length >= 40);
});

test('sets: image types, no-data kinds, row pane kinds and the list sizes', () => {
	const s = snap.sets;
	assert.deepEqual(RULES.widgets.images.inline_types, s['widgets.images.inline_types']);
	assert.deepEqual([...RULES.no_app_data_kinds].sort(), [...s.no_app_data_kinds].sort());
	assert.deepEqual([...RULES.row_pane_kinds].sort(), [...s.row_pane_kinds].sort());
	assert.equal(RULES.widget_kinds.length, s.widget_kinds_count + s.widget_kinds_added_182.length + s.widget_kinds_added_185.length);
	assert.deepEqual(RULES.widget_kinds.slice(s.widget_kinds_count), [...s.widget_kinds_added_182, ...s.widget_kinds_added_185]);
	assert.equal(RULES.actions.icons.length, s['actions.icons_count']);
	assert.equal(RULES.actions.reserved_label_words.length, s['actions.reserved_label_words_count']);
	assert.equal(RULES.actions.forbidden_ids.length, s['actions.forbidden_ids_count']);
	assert.equal(RULES.env.benign_passthrough.length, s['env.benign_passthrough_count']);
});

test('chart types: the rules and the schema list only what the launcher loader accepts (the 181 types plus those 182 added)', () => {
	const all = [...snap.chart_types.launcher_native, ...snap.chart_types.added_182];
	assert.deepEqual(RULES.right_widget.bind.chart.type.values, all);
	assert.deepEqual(Object.keys(RULES.right_widget.bind.chart.type.since_values), snap.chart_types.added_182);
	const sc = JSON.parse(read('schema/user-app.schema.json'));
	assert.deepEqual(sc.$defs.bindChart.properties.type.enum, all);
});

test('the schema accepts every action kind the launcher accepts, and the runner environment the docs state is the one in the rules', () => {
	const sc = JSON.parse(read('schema/user-app.schema.json'));
	assert.deepEqual(sc.$defs.action.properties.kind.enum, snap.constants['actions.kinds']);
	const qs = read('kit/examples/QUICKSTART.md');
	for (const k of Object.keys(snap.constants['runner_env.fixed'])) assert.ok(qs.includes(k), `QUICKSTART lacks ${k}`);
	for (const v of snap.constants['invoke.vars']) assert.ok(qs.includes(`{{${v}}}`) || ['query', 'args', 'inputs', 'home', 'scripts_dir'].includes(v), `QUICKSTART does not explain {{${v}}}`);
});

test('the docs state the numbers the launcher uses for the drill cache, the nav stack, the stderr cut and {{limit}}', () => {
	const qs = read('kit/examples/QUICKSTART.md');
	assert.ok(qs.includes(`last ${snap.constants['cache.drill_entries']} lists`) && qs.includes('5 minutes'));
	assert.ok(qs.includes(`${snap.constants['nav.stack_max']} deep`));
	assert.ok(qs.includes('2 KiB'));
	assert.ok(qs.includes(`{{limit}}\` is always ${snap.constants['invoke.limit_var']}`));
});
