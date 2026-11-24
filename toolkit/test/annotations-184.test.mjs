// Run: node --test toolkit/test/annotations-184.test.mjs
// Chart limit, limit_label and marker, and table column bars and mark, that Bolt 0.1.184 draws (S4 and S5): the rules file lists them with the
// version that first reads them, the schema agrees, lint accepts them when the app says min_bolt_version 0.1.184 and refuses them without it
// (an older Bolt refuses the whole pack, or ignores the key with a warning in a personal schema_version 1 file), and the widget-gallery example
// shows each one with a check case and a golden.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessYaml } from '../lib/assess.mjs';
import { RULES } from '../lib/boltrules.mjs';
import { caps } from '../../scripts/build-capabilities.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
const SINCE = '0.1.184';
const app = (kind, bindLines, version = 2) => [`schema_version: ${version}`, 'runtime: bridge', 'id: demo', 'chip: demo', 'title: "Demo"', 'icon: globe', 'description: "Demo"', 'emits: Generic',
	'bridge:', '  command:', '    macos: "python3 {{scripts_dir}}/demo__run.py"', '    linux: "python3 {{scripts_dir}}/demo__run.py"', '    windows: "python {{scripts_dir}}/demo__run.py"', '  parse: json', '  timeout_seconds: 20',
	'presentation:', '  widget: list', '  title_field: title', '  right_widget:', `    kind: ${kind}`, '    mode: list_data', '    bind:', ...bindLines.map((l) => '      ' + l)].join('\n') + '\n';
const chart = (lines, v) => app('chart', ['x: t', 'y: v', ...lines], v);
const table = (colLines, v) => app('table', ['columns:', ...colLines.map((l) => '  ' + l)], v);
const P = (y, opts) => assessYaml(y, 'demo', { minBoltKnown: true, minBolt: SINCE, ...opts }).problems;
const errs = (y, opts) => P(y, opts).filter((p) => p.level !== 'warning').map((p) => p.code).sort();

test('rules: the chart and column keys carry since 0.1.184 and the old keys carry none', () => {
	const c = RULES.right_widget.bind.chart;
	assert.deepEqual(c.limit, { t: 'textOrNumber', max: 4096, since: SINCE });
	assert.deepEqual(c.limit_label, { t: 'text', max: 200, since: SINCE });
	assert.deepEqual(c.marker, { t: 'map', since: SINCE, keys: { field: { t: 'text', max: 200, required: true }, label: { t: 'text', max: 200 } } });
	for (const [k, v] of Object.entries(c)) if (!['limit', 'limit_label', 'marker'].includes(k)) assert.equal(v.since === undefined || k === 'series' || k === 'type', true, k);
	const col = RULES.right_widget.bind.table.columns.keys;
	assert.deepEqual(col.bars, { t: 'bool', since: SINCE });
	assert.deepEqual(col.mark, { t: 'enum', values: ['tone'], since: SINCE });
	for (const [k, v] of Object.entries(col)) if (!['bars', 'mark'].includes(k)) assert.equal(v.since, undefined, k);
});

test('schema: bindChart and the table column list the keys and name the version', () => {
	const d = JSON.parse(read('schema/user-app.schema.json')).$defs;
	const c = d.bindChart.properties;
	assert.deepEqual(c.limit.type, ['string', 'number']);
	assert.equal(c.limit.maxLength, 4096);
	assert.equal(c.marker.additionalProperties, false);
	assert.deepEqual(c.marker.required, ['field']);
	assert.deepEqual(Object.keys(c.marker.properties), ['field', 'label']);
	for (const k of ['limit', 'limit_label', 'marker']) assert.ok(c[k].description.includes(SINCE), k);
	const col = d.bindTable.properties.columns.items.properties;
	assert.equal(col.bars.type, 'boolean');
	assert.deepEqual(col.mark.enum, RULES.right_widget.bind.table.columns.keys.mark.values);
	for (const k of ['bars', 'mark']) assert.ok(col[k].description.includes(SINCE), k);
});

test('lint accepts limit, limit_label and marker with min_bolt_version 0.1.184', () => {
	assert.deepEqual(errs(chart(['limit: 80'])), []);
	assert.deepEqual(errs(chart(['limit: "{{row.cap}}"', 'limit_label: "budget"'])), []);
	assert.deepEqual(errs(chart(['limit: 0.003', 'marker: { field: deploy, label: note }'])), []);
	assert.deepEqual(errs(app('chart', ['type: pie', 'x: t', 'y: v', 'limit: 5'])), []);
});

test('lint accepts column bars and mark with min_bolt_version 0.1.184', () => {
	assert.deepEqual(errs(table(['- { field: n, bars: true }'])), []);
	assert.deepEqual(errs(table(['- { field: n, bars: false, mark: tone, total: sum }'])), []);
});

test('lint refuses each new key without min_bolt_version 0.1.184, and with an older one', () => {
	const cases = [chart(['limit: 5']), chart(['limit_label: x']), chart(['marker: { field: d }']), table(['- { field: n, bars: true }']), table(['- { field: n, mark: tone }'])];
	for (const y of cases) {
		assert.deepEqual(errs(y, { minBolt: undefined }), ['bind_needs_newer_bolt'], y);
		assert.deepEqual(errs(y, { minBolt: '0.1.182' }), ['bind_needs_newer_bolt'], y);
	}
	const g = P(chart(['limit: 5']), { minBolt: undefined }).find((p) => p.code === 'bind_needs_newer_bolt');
	assert.ok(g.message.includes('min_bolt_version') && g.message.includes(SINCE), g.message);
	assert.deepEqual(errs(chart([]), { minBolt: undefined }), []);   // a chart without the new keys needs nothing
	assert.deepEqual(errs(table(['- { field: n, total: sum }']), { minBolt: undefined }), []);
});

test('lint refuses what no Bolt reads: wrong types, a marker without field, misspelt and stray keys', () => {
	assert.deepEqual(errs(chart(['limit: { a: 1 }'])), ['right_widget_bind_unread']);
	assert.deepEqual(errs(chart(['limit: [1, 2]'])), ['right_widget_bind_unread']);
	assert.deepEqual(errs(chart(['marker: deploy'])), ['right_widget_bind_unread']);
	assert.deepEqual(errs(chart(['marker: { label: note }'])), ['right_widget_bind_unread']);
	assert.deepEqual(errs(chart(['marker: { field: d, colour: red }'])), ['right_widget_bind_unread']);
	assert.deepEqual(errs(chart(['limit_lable: x'])), ['right_widget_bind_unread']);
	assert.deepEqual(errs(table(['- { field: n, bars: yes_please }'])), ['right_widget_bind_unread']);
	assert.deepEqual(errs(table(['- { field: n, bars: "true" }'])), ['right_widget_bind_unread']);
	assert.deepEqual(errs(table(['- { field: n, mark: glyph }'])), ['right_widget_bind_unread']);
	assert.deepEqual(errs(table(['- { field: n, bar: true }'])), ['right_widget_bind_unread']);
	assert.deepEqual(errs(app('cards', ['layout: tiles', 'value: v', 'limit_label: x'])), ['right_widget_bind_unread']);
});

test('a personal schema_version 1 file is gated too (an older Bolt warns and ignores the key; a pack is refused)', () => {
	assert.deepEqual(errs(chart(['limit: 5'], 1), { minBolt: undefined }), ['bind_needs_newer_bolt']);
	assert.deepEqual(errs(table(['- { field: n, bars: true }'], 1), { pack: true, minBolt: undefined }), ['bind_needs_newer_bolt']);
});

test('the capability rows name the keys, the version and an existing test', () => {
	for (const [id, words] of [['pane.chart_limit_marker', ['limit', 'marker']], ['pane.table_bars_mark', ['bars', 'mark']]]) {
		const r = caps.rows.find((x) => x.id === id);
		assert.ok(r, `row ${id}`);
		assert.equal(r.status, 'supported');
		assert.ok(r.limit.includes(SINCE) && r.limit.includes('min_bolt_version'), r.limit);
		assert.ok(fs.existsSync(path.join(REPO, r.test)), r.test);
		assert.ok(fs.existsSync(path.join(REPO, r.example)), r.example);
		for (const w of words) assert.ok(r.snippet.includes(w), `${id} snippet ${w}`);
	}
});

test('QUICKSTART names the new chart and table keys and the version', () => {
	const row = read('kit/examples/QUICKSTART.md').split('\n').find((l) => l.startsWith('| Panes newer than 181'));
	assert.ok(row.includes(SINCE), row);
	for (const w of ['limit', 'marker', 'bars', 'mark']) assert.ok(row.includes(w), w);
});

test('widget-gallery shows each key, declares min_bolt_version 0.1.184, and has a check case with a golden for each', () => {
	const dir = 'kit/examples/widget-gallery';
	assert.equal(JSON.parse(read(`${dir}/bolt-app.json`)).min_bolt_version, SINCE);
	const yaml = read(`${dir}/utilities/widget-gallery.yaml`);
	for (const w of ['limit:', 'limit_label:', 'marker:', 'bars: true', 'mark: "tone"']) assert.ok(yaml.includes(w), w);
	assert.deepEqual(errs(yaml), [], 'the gallery lints clean at 0.1.184');
	assert.deepEqual(errs(yaml, { minBolt: '0.1.183' }).filter((c) => c === 'bind_needs_newer_bolt').length > 0, true, 'and is gated below it');
	const cases = JSON.parse(read(`${dir}/check.json`)).cases;
	for (const [name, golden] of [['chart limit and marker', 'golden/chart-limit-marker.json'], ['table bars and mark', 'golden/table-bars-mark.json']]) {
		const c = cases.find((x) => x.name.startsWith(name));
		assert.ok(c, name);
		assert.equal(c.golden, golden);
		assert.ok(fs.existsSync(path.join(REPO, dir, golden)), golden);
	}
	assert.ok(read(`${dir}/README.md`).includes('not verified in real Bolt'), 'README is honest that no real Bolt drew it');
});
