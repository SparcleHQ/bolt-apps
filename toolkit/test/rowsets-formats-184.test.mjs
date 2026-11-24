// Run: node --test toolkit/test/rowsets-formats-184.test.mjs
// Named row sets (bind.from) and number formats (bind.format, digits, locale) that Bolt 0.1.184 reads: the rules file lists them with the
// version that first reads them, the schema agrees, lint accepts them when the app says min_bolt_version 0.1.184 and refuses them without it
// (an older Bolt refuses the whole pack, or ignores the key with a warning in a personal schema_version 1 file).
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
const BASE = { chart: ['type: line', 'x: day', 'y: n'], table: [], cards: ['layout: tiles', 'value: "{{row.v}}"'], heatmap: ['x: a', 'y: b', 'value: c'], image_grid: ['src: "{{row.s}}"'], gauge: ['value: v'] };
const app = (kind, bindLines, { mode = 'list_data', version = 2 } = {}) => [`schema_version: ${version}`, 'runtime: bridge', 'id: demo', 'chip: demo', 'title: "Demo"', 'icon: globe', 'description: "Demo"', 'emits: Generic',
	'bridge:', '  command:', '    macos: "python3 {{scripts_dir}}/demo__run.py"', '    linux: "python3 {{scripts_dir}}/demo__run.py"', '    windows: "python {{scripts_dir}}/demo__run.py"', '  parse: json', '  timeout_seconds: 20',
	'presentation:', '  widget: list', '  title_field: title', '  right_widget:', `    kind: ${kind}`, ...(mode ? [`    mode: ${mode}`] : []), '    bind:', ...[...BASE[kind], ...bindLines].map((l) => '      ' + l)].join('\n') + '\n';
const P = (y, opts) => assessYaml(y, 'demo', { minBoltKnown: true, minBolt: SINCE, ...opts }).problems;
const errs = (y, opts) => P(y, opts).filter((p) => p.level !== 'warning').map((p) => p.code).sort();
const msg = (y, opts) => P(y, opts).map((p) => p.message).join('\n');

test('rules: every new key carries since 0.1.184 and the old keys carry none', () => {
	const B = RULES.right_widget.bind;
	for (const k of ['chart', 'table', 'cards', 'heatmap', 'image_grid']) assert.deepEqual(B[k].from, { t: 'rowSet', since: SINCE }, k);
	for (const k of ['chart', 'cards', 'gauge']) {
		assert.deepEqual(B[k].format, { t: 'enum', values: ['number', 'percent', 'compact', 'bytes', 'duration'], since: SINCE }, k);
		assert.deepEqual(B[k].digits, { t: 'int', lo: 0, hi: 6, since: SINCE }, k);
		assert.deepEqual(B[k].locale, { t: 'text', max: 35, since: SINCE }, k);
	}
	const col = B.table.columns.keys;
	assert.deepEqual(col.format.since_values, { compact: SINCE, bytes: SINCE, duration: SINCE });
	assert.equal(col.format.since, undefined, 'the old column format words need no version');
	assert.equal(col.digits.since, SINCE);
	assert.equal(col.locale.since, SINCE);
	for (const k of ['detail', 'markdown', 'json_tree']) assert.equal(B[k].from, undefined, `${k} reads one row, never a set`);
	assert.equal(B.heatmap.format, undefined, 'heatmap takes no format in 0.1.184');
});

test('schema: the same keys, enums and caps as the rules file', () => {
	const D = JSON.parse(read('schema/user-app.schema.json')).$defs;
	for (const [def, kind] of [['bindChart', 'chart'], ['bindCards', 'cards'], ['bindGauge', 'gauge']]) {
		assert.deepEqual(D[def].properties.format.enum, RULES.right_widget.bind[kind].format.values, def);
		assert.equal(D[def].properties.digits.minimum, 0); assert.equal(D[def].properties.digits.maximum, 6);
		assert.equal(D[def].properties.locale.maxLength, 35);
	}
	for (const def of ['bindChart', 'bindTable', 'bindCards', 'bindHeatmap', 'bindImageGrid']) {
		const f = D[def].properties.from;
		assert.deepEqual(f.required, ['set']); assert.equal(f.properties.set.pattern, '^[a-z][a-z0-9_-]{0,23}$'); assert.equal(f.properties.where.maxProperties, 3);
		assert.ok(f.description.includes(SINCE), def);
	}
	assert.deepEqual(D.bindTable.properties.columns.items.properties.format.enum, RULES.right_widget.bind.table.columns.keys.format.values);
});

test('lint accepts from and formats with min_bolt_version 0.1.184', () => {
	for (const kind of ['chart', 'table', 'cards', 'heatmap', 'image_grid']) assert.deepEqual(errs(app(kind, ['from:', '  set: kpis'])), [], kind);
	assert.deepEqual(errs(app('table', ['from:', '  set: rows_by_host', '  where:', '    kind: server', '    ok: true', '    n: 3'])), []);
	for (const f of ['number', 'percent', 'compact', 'bytes', 'duration']) for (const kind of ['chart', 'cards', 'gauge']) assert.deepEqual(errs(app(kind, [`format: ${f}`, 'digits: 2', 'locale: de-DE'], { mode: kind === 'gauge' ? 'selected_row' : 'list_data' })), [], `${kind} ${f}`);
	assert.deepEqual(errs(app('table', ['columns:', '  - field: a', '    format: bytes', '    digits: 1', '    locale: fr'])), []);
});

test('lint refuses each new key without min_bolt_version 0.1.184, and with an older one', () => {
	const cases = [app('table', ['from:', '  set: k']), app('chart', ['format: bytes']), app('chart', ['digits: 1']), app('cards', ['locale: de']),
		app('gauge', ['format: percent'], { mode: 'selected_row' }), app('table', ['columns:', '  - field: a', '    format: duration']), app('table', ['columns:', '  - field: a', '    digits: 2'])];
	for (const y of cases) {
		// a gauge pane is itself newer than 181, so it can carry two gates (the kind and the key): the code is the same
		assert.deepEqual([...new Set(errs(y, { minBolt: undefined }))], ['bind_needs_newer_bolt'], y);
		assert.deepEqual([...new Set(errs(y, { minBolt: '0.1.182' }))], ['bind_needs_newer_bolt'], y);
	}
	assert.ok(msg(cases[0], { minBolt: undefined }).includes('min_bolt_version'));
	// a column format that existed before needs nothing
	assert.deepEqual(errs(app('table', ['columns:', '  - field: a', '    format: currency']), { minBolt: undefined }), []);
});

test('lint refuses a bad from, by name', () => {
	const bad = (lines, want) => { const y = app('table', ['from:', ...lines.map((l) => '  ' + l)]); assert.deepEqual(errs(y), ['right_widget_bind_unread'], lines.join(' ')); assert.ok(msg(y).includes(want), `${lines.join(' ')} -> ${msg(y)}`); };
	bad(['set: Kpis'], 'must match');
	bad(['set: ""'], 'must match');
	bad(['set: 9x'], 'must match');
	bad([`set: ${'s'.repeat(25)}`], 'must match');
	bad(['set: constructor'], 'reserved');
	bad(['set: prototype'], 'reserved');
	bad(['set: __proto__'], 'must match');
	bad(['set: k', 'extra: 1'], 'not a key a row set reads');
	bad(['where:', '  a: 1'], 'set is required');
	bad(['set: k', 'where:', '  a: 1', '  b: 2', '  c: 3', '  d: 4'], 'at most 3');
	bad(['set: k', 'where:', '  constructor: x'], 'field name that is not allowed');
	bad(['set: k', 'where:', '  - a'], 'where must be a mapping');
	bad(['set: k', 'where:', '  a:', '    b: 1'], 'where.a');
	bad(['set: k', 'where:', `  a: ${'v'.repeat(201)}`], 'longer than 200');
	const y = app('table', []).replace('      from:', '      from:'); // control: no from, no error
	assert.deepEqual(errs(y), []);
	const s = app('table', ['from: kpis']);
	assert.deepEqual(errs(s), ['right_widget_bind_unread']); assert.ok(msg(s).includes('must be a mapping'));
});

test('from needs mode list_data; panes that draw one row take no from', () => {
	assert.deepEqual(errs(app('table', ['from:', '  set: k'], { mode: 'selected_row' })), ['right_widget_bind_unread']);
	assert.ok(msg(app('table', ['from:', '  set: k'], { mode: null })).includes('needs mode: list_data'));
	for (const kind of ['gauge']) assert.deepEqual(errs(app(kind, ['from:', '  set: k'], { mode: 'selected_row' })).includes('right_widget_bind_unread'), true);
});

test('lint refuses bad format values and numbers', () => {
	for (const l of ['format: hex', 'digits: 7', 'digits: -1', 'digits: "2"', `locale: ${'x'.repeat(36)}`, 'locale: [de]']) assert.deepEqual(errs(app('chart', [l])), ['right_widget_bind_unread'], l);
	assert.deepEqual(errs(app('chart', ['locale:', '  - de'])), ['right_widget_bind_unread']);
	assert.deepEqual(errs(app('heatmap', ['format: number'])), ['right_widget_bind_unread'], 'heatmap takes no format');
	assert.deepEqual(errs(app('table', ['columns:', '  - field: a', '    digits: 9'])), ['right_widget_bind_unread']);
});

test('a personal schema_version 1 file is gated too (an older Bolt warns and ignores the key; a pack is refused)', () => {
	assert.deepEqual(errs(app('table', ['from:', '  set: k'], { version: 1 }), { minBolt: undefined }), ['bind_needs_newer_bolt']);
	assert.deepEqual(errs(app('chart', ['format: bytes'], { version: 1 }), { pack: true, minBolt: undefined }), ['bind_needs_newer_bolt']);
});

test('the capability rows name the keys, the version and an existing test', () => {
	for (const [id, key] of [['pane.row_sets', 'from'], ['pane.number_formats', 'format']]) {
		const r = caps.rows.find((x) => x.id === id);
		assert.ok(r, `row ${id}`);
		assert.equal(r.status, 'supported');
		assert.ok(r.limit.includes(SINCE) && r.limit.includes('min_bolt_version'), r.limit);
		assert.ok(fs.existsSync(path.join(REPO, r.test)), r.test);
		assert.ok(r.snippet.includes(key), id);
	}
});

test('QUICKSTART names the version of the new keys in the Panes newer row', () => {
	const row = read('kit/examples/QUICKSTART.md').split('\n').find((l) => l.startsWith('| Panes newer than 181'));
	assert.ok(row.includes('from') && row.includes('format') && row.includes(SINCE), row);
});
