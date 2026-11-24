// Run: node --test toolkit/test/stack-184.test.mjs
// The stack pane Bolt 0.1.184 draws (kind stack, bind.children): the rules file lists the kind with the version that first reads it, the schema
// agrees, lint accepts a stack with min_bolt_version 0.1.184 and refuses it without (an older Bolt refuses the whole app file for every schema_version),
// each part is checked as its own kind, and the chart-types example uses it.
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
// a stack as YAML lines under bind; `parts` are given as raw lines (each part starts with "- ")
const app = (parts, { mode = 'list_data', version = 2, bind = true } = {}) => [`schema_version: ${version}`, 'runtime: bridge', 'id: demo', 'chip: demo', 'title: "Demo"', 'icon: globe', 'description: "Demo"', 'emits: Generic',
	'bridge:', '  command:', '    macos: "python3 {{scripts_dir}}/demo__run.py"', '    linux: "python3 {{scripts_dir}}/demo__run.py"', '    windows: "python {{scripts_dir}}/demo__run.py"', '  parse: json', '  timeout_seconds: 20',
	'presentation:', '  widget: list', '  title_field: title', '  right_widget:', '    kind: stack', ...(mode ? [`    mode: ${mode}`] : []),
	...(bind ? ['    bind:', '      children:', ...parts.map((l) => '        ' + l)] : [])].join('\n') + '\n';
const P = (y, opts) => assessYaml(y, 'demo', { minBoltKnown: true, minBolt: SINCE, ...opts }).problems;
const errs = (y, opts) => P(y, opts).filter((p) => p.level !== 'warning').map((p) => p.code).sort();
const msg = (y, opts) => P(y, opts).map((p) => p.message).join('\n');
const part = (kind, ...more) => [`- kind: ${kind}`, ...more.map((m) => '  ' + m)];
const GOOD = [...part('cards', 'bind:', '  layout: tiles', '  value: "{{row.v}}"', '  from:', '    set: tiles'), ...part('chart', 'bind:', '  type: bar', '  y: v', '  from:', '    set: trend'), ...part('table', 'bind:', '  columns:', '    - field: a', '  from:', '    set: hosts')];

test('rules: stack is a kind since 0.1.184, with the caps the launcher uses', () => {
	assert.ok(RULES.widget_kinds.includes('stack'));
	assert.equal(RULES.kind_since.stack, SINCE);
	assert.deepEqual(RULES.stack, { child_kinds: { cards: 'list_data', chart: 'list_data', table: 'list_data', heatmap: 'list_data', gauge: 'selected_row', detail: 'selected_row', markdown: 'selected_row' }, max_children: 6, row_budget: 1000 });
	assert.equal(RULES.right_widget.bind.stack.children.t, 'stackChildren');
});

test('schema: the kind, its bind and the part kinds agree with the rules file', () => {
	const S = JSON.parse(read('schema/user-app.schema.json'));
	const rw = JSON.stringify(S);
	assert.ok(rw.includes('"const":"stack"'));
	const b = S.$defs.bindStack;
	assert.deepEqual(b.required, ['children']);
	assert.equal(b.properties.children.maxItems, RULES.stack.max_children);
	assert.equal(b.properties.children.minItems, 1);
	assert.deepEqual(b.properties.children.items.properties.kind.enum, Object.keys(RULES.stack.child_kinds));
	assert.ok(b.properties.children.description.includes(SINCE));
});

test('lint accepts a stack of three parts with min_bolt_version 0.1.184', () => {
	assert.deepEqual(errs(app(GOOD)), []);
	assert.deepEqual(errs(app([...part('gauge', 'bind:', '  value: v'), ...part('detail'), ...part('markdown'), ...part('heatmap'), ...part('table', 'mode: selected_row')])), []);
	assert.deepEqual(errs(app(Array.from({ length: 6 }, () => part('table')).flat())), []);
});

test('lint refuses a stack without min_bolt_version 0.1.184, or with an older one, for every schema_version', () => {
	for (const version of [1, 2]) {
		assert.ok(errs(app(GOOD, { version }), { minBolt: undefined }).includes('bind_needs_newer_bolt'), `v${version} none`);
		assert.ok(errs(app(GOOD, { version }), { minBolt: '0.1.182' }).includes('bind_needs_newer_bolt'), `v${version} 182`);
	}
	const g = P(app(GOOD), { minBolt: undefined }).find((p) => p.code === 'bind_needs_newer_bolt');
	assert.ok(g.message.includes('min_bolt_version') && g.message.includes(SINCE), g.message);
	assert.ok(g.message.includes('stack'), g.message);
});

test('lint refuses zero, seven and nested parts, unknown kinds and malformed parts by name', () => {
	const bad = (parts, want, opts) => { const y = app(parts, opts); assert.deepEqual([...new Set(errs(y))], ['right_widget_bind_unread'], parts.join('|')); assert.ok(msg(y).includes(want), `${want} <- ${msg(y)}`); };
	bad(Array.from({ length: 7 }, () => part('table')).flat(), 'the limit is 6');
	bad(part('stack', 'bind:', '  children:', '    - kind: table'), 'cannot hold a stack');
	bad(part('banana'), 'children[0].kind');
	bad(part('constructor'), 'children[0].kind');
	bad(part('image'), 'children[0].kind');
	bad(['- extra: 1'], 'children[0].extra');
	bad(['- bind:', '    title: x'], 'children[0].kind: is required'.replace(': is', ' is').replace('.kind is', '.kind is'));
	bad(part('table', 'mode: weird'), 'children[0].mode');
	bad([...part('table'), ...part('chart', 'bind:', '  colr: x')], 'children[1].bind.colr');
	bad(part('cards', 'bind:', '  layout: tiles'), 'children[0].bind.value');
	bad(part('table', 'mode: selected_row', 'bind:', '  from:', '    set: a'), 'children[0].bind.from');
	bad(part('gauge', 'bind:', '  value: v', '  from:', '    set: a'), 'children[0].bind.from');
	bad(part('table', 'bind:', '  from:', '    set: Bad'), 'children[0].bind.from');
});

test('a stack needs mode list_data and children', () => {
	assert.ok(errs(app(GOOD, { mode: 'selected_row' })).includes('right_widget_bind_unread') && msg(app(GOOD, { mode: 'selected_row' })).includes('a stack needs mode: list_data'));
	assert.ok(msg(app(GOOD, { mode: null })).includes('a stack needs mode: list_data'));
	assert.ok(msg(app([], { bind: false })).includes('children'));
});

test('the chart-types example is a stack, passes lint with 0.1.184 and fails without', () => {
	const dir = path.join(REPO, 'kit/examples/chart-types'), y = fs.readFileSync(path.join(dir, 'utilities/chart-types.yaml'), 'utf8');
	assert.ok(y.includes('kind: stack'));
	assert.deepEqual(errs(y, { pack: true, minBolt: SINCE }), []);
	assert.ok(P(y, { pack: true, minBolt: undefined }).filter((p) => p.code === 'bind_needs_newer_bolt').length >= 1);
	const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'scripts/chart-types__config.json'), 'utf8'));
	assert.equal(cfg.overview.widget.kind, 'stack');
	assert.deepEqual(cfg.overview.widget.bind.children.map((c) => c.kind), ['cards', 'chart', 'table']);
	// one run, three sets: every set a part reads has rows in the overview
	const sets = new Set(cfg.overview.rows.map((r) => r.extra?.set).filter(Boolean));
	for (const c of cfg.overview.widget.bind.children) assert.ok(sets.has(c.bind.from.set), c.bind.from.set);
	const golden = JSON.parse(read('kit/examples/chart-types/golden/overview.json'));
	assert.ok(golden.filter((r) => r.set === 'trend').length === 7);
	assert.ok(golden.some((r) => !r.set && r.nav), 'link rows stay untagged list rows');
});

test('the capability row names the kind, the version and an existing test', () => {
	const r = caps.rows.find((x) => x.id === 'pane.stack');
	assert.ok(r); assert.equal(r.status, 'supported');
	assert.ok(r.limit.includes(SINCE) && r.limit.includes('min_bolt_version'));
	assert.ok(fs.existsSync(path.join(REPO, r.test)));
});
