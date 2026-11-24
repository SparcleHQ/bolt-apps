// Run: node --test toolkit/test/charts-182.test.mjs
// Chart types and panes that Bolt 0.1.182 draws (pie, donut, area, bind.series, heatmap, gauge): the rules file lists them with the
// version that first reads them, lint accepts them when the app says min_bolt_version 0.1.182, refuses them without it (a 181 refuses
// the whole pack), and QUICKSTART's rules table and rule 5 say the same as schema/bolt-rules.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessYaml } from '../lib/assess.mjs';
import { RULES } from '../lib/boltrules.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
const SINCE = '0.1.182';
const app = (kind, bindLines) => ['schema_version: 2', 'runtime: bridge', 'id: demo', 'chip: demo', 'title: "Demo"', 'icon: globe', 'description: "Demo"', 'emits: Generic',
	'bridge:', '  command:', '    macos: "python3 {{scripts_dir}}/demo__run.py"', '    linux: "python3 {{scripts_dir}}/demo__run.py"', '    windows: "python {{scripts_dir}}/demo__run.py"', '  parse: json', '  timeout_seconds: 20',
	'presentation:', '  widget: list', '  title_field: title', '  right_widget:', `    kind: ${kind}`, '    mode: list_data', '    bind:', ...bindLines.map((l) => '      ' + l)].join('\n') + '\n';
const P = (y, opts) => assessYaml(y, 'demo', { minBoltKnown: true, minBolt: SINCE, ...opts }).problems;
const errs = (y, opts) => P(y, opts).filter((p) => p.level !== 'warning').map((p) => p.code).sort();

test('rules: chart types and the two panes carry the version that first reads them', () => {
	const t = RULES.right_widget.bind.chart.type;
	assert.deepEqual(t.values, ['line', 'bar', 'sparkline', 'pie', 'donut', 'area']);
	assert.deepEqual(t.since_values, { pie: SINCE, donut: SINCE, area: SINCE });
	assert.equal(RULES.right_widget.bind.chart.series.since, SINCE);
	assert.equal(RULES.right_widget.bind.chart.series.items, 4);
	assert.equal(RULES.kind_since.heatmap, SINCE);
	assert.equal(RULES.kind_since.gauge, SINCE);
	for (const k of ['heatmap', 'gauge']) assert.ok(RULES.widget_kinds.includes(k) && RULES.right_widget.bind[k], k);
	assert.deepEqual(Object.keys(RULES.right_widget.bind.heatmap), ['x', 'y', 'value', 'rows', 'cols', 'col_labels', 'layout', 'label', 'unit']);
	assert.deepEqual(Object.keys(RULES.right_widget.bind.gauge), ['value', 'min', 'max', 'label', 'unit', 'shape', 'thresholds']);
});

test('lint accepts pie, donut, area and series with min_bolt_version 0.1.182', () => {
	for (const ty of ['pie', 'donut', 'area']) assert.deepEqual(errs(app('chart', [`type: ${ty}`, 'x: label', 'y: value'])), [], ty);
	assert.deepEqual(errs(app('chart', ['type: line', 'x: day', 'series:', '  - { y: visits, label: Visits }', '  - { y: signups, label: Sign-ups }'])), []);
});

test('lint refuses pie, series, heatmap and gauge without min_bolt_version 0.1.182 (a 181 refuses the pack)', () => {
	const old = { minBolt: undefined };
	assert.deepEqual(errs(app('chart', ['type: pie', 'x: a', 'y: b']), old), ['bind_needs_newer_bolt']);
	assert.deepEqual(errs(app('chart', ['type: line', 'series:', '  - { y: a }']), old), ['bind_needs_newer_bolt']);
	assert.deepEqual(errs(app('heatmap', ['x: a', 'y: b', 'value: c']), old), ['bind_needs_newer_bolt']);
	assert.deepEqual(errs(app('gauge', ['value: v']), old), ['bind_needs_newer_bolt']);
	assert.deepEqual(errs(app('chart', ['type: line', 'x: a', 'y: b']), old), []);   // the old types need nothing
});

test('lint still refuses what no Bolt reads: other chart types, more than 4 series, a color in a series', () => {
	assert.deepEqual(errs(app('chart', ['type: radar', 'y: v'])), ['right_widget_bind_unread']);
	const five = ['type: line', 'series:', ...[1, 2, 3, 4, 5].map((i) => `  - { y: s${i} }`)];
	assert.deepEqual(errs(app('chart', five)), ['right_widget_bind_unread']);
	assert.deepEqual(errs(app('chart', ['type: line', 'series:', '  - { y: a, color: red }'])), ['right_widget_bind_unread']);
});

test('heatmap and gauge binds: keys, enums and caps follow the 182 loader', () => {
	assert.deepEqual(errs(app('heatmap', ['x: hour', 'y: day', 'value: n', 'layout: grid'])), []);
	assert.deepEqual(errs(app('heatmap', ['layout: spiral'])), ['right_widget_bind_unread']);
	assert.deepEqual(errs(app('heatmap', ['colour: red'])), ['right_widget_bind_unread']);
	assert.deepEqual(errs(app('gauge', ['value: v', 'shape: half', 'thresholds:', '  - { at: 50, label: Fair, tone: warn }'])), []);
	assert.deepEqual(errs(app('gauge', ['shape: ring'])), ['right_widget_bind_unread']);   // value is required
	assert.deepEqual(errs(app('gauge', ['value: v', 'shape: arc'])), ['right_widget_bind_unread']);
	assert.deepEqual(errs(app('gauge', ['value: v', 'thresholds:', '  - { at: 1, tone: red }'])), ['right_widget_bind_unread']);
});

test('QUICKSTART: rule 5 no longer says pie, heatmap and gauge are not shipped, and the rules table lists every chart type with its version', () => {
	const qs = read('kit/examples/QUICKSTART.md');
	const rule5 = qs.split('\n').find((l) => /^5\. /.test(l));
	assert.ok(!/not shipped/i.test(rule5), rule5);
	const row = (label) => { const m = qs.split('\n').find((l) => l.startsWith(`| ${label}`)); assert.ok(m, `row ${label}`); return m.split('|').map((c) => c.trim()); };
	const cell = row('Chart types')[2], T = RULES.right_widget.bind.chart.type;
	const [oldPart, newPart] = cell.split(';').map((s) => s.trim());
	assert.deepEqual(oldPart.replace(/ \(.*\)$/, '').split(', '), T.values.filter((v) => !T.since_values[v]));
	for (const v of Object.keys(T.since_values)) assert.ok(newPart.includes(v), `Chart types row lacks ${v}`);
	assert.ok(newPart.includes('bind.series') && newPart.includes(SINCE), 'series and the version');
	const panes = row('Panes newer than 181')[2];
	for (const [k, v] of Object.entries(RULES.kind_since)) assert.ok(panes.includes(k) && panes.includes(v), k);
});

test('the chart-types example app passes lint with its min_bolt_version and fails without it', () => {
	const dir = path.join(REPO, 'kit/examples/chart-types'), y = fs.readFileSync(path.join(dir, 'utilities/chart-types.yaml'), 'utf8');
	assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'bolt-app.json'), 'utf8')).min_bolt_version, SINCE);
	assert.deepEqual(errs(y, { pack: true }), []);
	const bad = P(y, { pack: true, minBolt: undefined }).filter((p) => p.code === 'bind_needs_newer_bolt');
	assert.ok(bad.length >= 6, `each of the six panes needs the gate, got ${bad.length}`);
	for (const t of ['pie', 'donut', 'area', 'heatmap', 'gauge']) assert.ok(y.includes(t), t);
});
