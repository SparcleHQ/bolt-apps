// Run: node --test toolkit/test/graph-184.test.mjs
// The `graph` pane (service map) that Bolt 0.1.184 draws: nodes and edges as rows (bind.id, label, status, to, group, title), laid out by Bolt.
// It is a NEW KIND: a Bolt older than 184 refuses the whole pack that uses it, for every schema version, so lint demands min_bolt_version 0.1.184
// (the author's promise: Bolt does not read min_bolt_version). The rules file, the schema, the capability row, QUICKSTART and the gallery example agree.
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
const app = (bindLines, version = 2, kind = 'graph') => [`schema_version: ${version}`, 'runtime: bridge', 'id: demo', 'chip: demo', 'title: "Demo"', 'icon: globe', 'description: "Demo"', 'emits: Generic',
	'bridge:', '  command:', '    macos: "python3 {{scripts_dir}}/demo__run.py"', '    linux: "python3 {{scripts_dir}}/demo__run.py"', '    windows: "python {{scripts_dir}}/demo__run.py"', '  parse: json', '  timeout_seconds: 20',
	'presentation:', '  widget: list', '  title_field: title', '  right_widget:', `    kind: ${kind}`, '    mode: list_data', '    bind:', ...bindLines.map((l) => '      ' + l)].join('\n') + '\n';
const P = (y, opts) => assessYaml(y, 'demo', { minBoltKnown: true, minBolt: SINCE, ...opts }).problems;
const errs = (y, opts) => P(y, opts).filter((p) => p.level !== 'warning').map((p) => p.code).sort();
const KEYS = ['id', 'label', 'status', 'to', 'group', 'title'];

test('rules: graph is a widget kind that carries kind_since 0.1.184 and six text-name bind keys', () => {
	assert.ok(RULES.widget_kinds.includes('graph'));
	assert.equal(RULES.kind_since.graph, SINCE);
	assert.deepEqual(RULES.kind_since.heatmap, '0.1.182');
	assert.deepEqual(Object.keys(RULES.right_widget.bind.graph), KEYS);
	for (const k of KEYS) assert.equal(RULES.right_widget.bind.graph[k].t, 'text', k);
	assert.equal(RULES.right_widget.bind.graph.id.required, true);
});

test('rules: the caps are written down once and named the same as in Bolt', () => {
	assert.deepEqual(RULES.graph_caps, { max_nodes: 60, max_edges: 200, max_input_rows: 5000 });
});

test('schema: the kind list, the one-of and bindGraph agree with the rules file', () => {
	const s = JSON.parse(read('schema/user-app.schema.json'));
	const rw = s.$defs.presentation.properties.right_widget.properties.kind;
	assert.ok(rw.enum.includes('graph'));
	const one = rw.oneOf.find((o) => o.const === 'graph');
	assert.ok(one && one.description.includes(SINCE), 'oneOf entry names the version');
	assert.deepEqual(Object.keys(s.$defs.bindGraph.properties), KEYS);
	assert.equal(s.$defs.bindGraph.additionalProperties, false);
	assert.deepEqual(s.$defs.bindGraph.required, ['id']);
});

test('lint accepts a graph with min_bolt_version 0.1.184, in schema_version 1 and 2', () => {
	assert.deepEqual(errs(app(['id: id', 'label: name', 'status: state', 'to: calls', 'group: team', 'title: Service map'])), []);
	assert.deepEqual(errs(app(['id: id'], 1)), []);
	assert.deepEqual(errs(app(['title: Map'])), ['right_widget_bind_unread']);   // bind.id is required: a node needs an id
});

test('lint refuses graph without min_bolt_version 0.1.184, and with an older one, for every schema version (an old Bolt refuses the pack)', () => {
	for (const version of [1, 2]) {
		assert.deepEqual(errs(app(['id: id'], version), { minBolt: undefined }), ['bind_needs_newer_bolt'], `v${version} none`);
		assert.deepEqual(errs(app(['id: id'], version), { minBolt: '0.1.182' }), ['bind_needs_newer_bolt'], `v${version} 182`);
		assert.deepEqual(errs(app(['id: id'], version), { pack: true, minBolt: undefined }), ['bind_needs_newer_bolt'], `v${version} pack`);
	}
	const g = P(app(['id: id']), { minBolt: undefined }).find((p) => p.code === 'bind_needs_newer_bolt');
	assert.ok(g.message.includes('graph') && g.message.includes('min_bolt_version') && g.message.includes(SINCE), g.message);
});

test('lint refuses what no Bolt reads: unknown keys, a list or map for a name, keys of other kinds', () => {
	assert.deepEqual(errs(app(['id: id', 'colour: red'])), ['right_widget_bind_unread']);
	assert.deepEqual(errs(app(['id: [a]'])), ['right_widget_bind_unread']);
	assert.deepEqual(errs(app(['id: id', 'to: { a: 1 }'])), ['right_widget_bind_unread']);
	assert.deepEqual(errs(app(['id: id', 'x: a'])), ['right_widget_bind_unread']);
	assert.deepEqual(errs(app(['id: id', 'layout: grid'])), ['right_widget_bind_unread']);
	// the graph keys are not keys of the old panes
	assert.deepEqual(errs(app(['to: calls'], 2, 'heatmap')), ['right_widget_bind_unread']);
	assert.deepEqual(errs(app(['status: s'], 2, 'table')), ['right_widget_bind_unread']);
});

test('the capability row names the keys, the caps, the version and an existing test', () => {
	const r = caps.rows.find((x) => x.id === 'widget.graph');
	assert.ok(r, 'row widget.graph');
	assert.equal(r.status, 'supported');
	assert.equal(r.kind, 'graph');
	for (const w of [SINCE, 'min_bolt_version', '60 nodes', '200 edges', 'groups']) assert.ok(r.limit.includes(w), `limit says ${w}: ${r.limit}`);
	assert.ok(fs.existsSync(path.join(REPO, r.test)), r.test);
	assert.ok(r.snippet.includes('graph') && r.snippet.includes('"to"'));
});

test('QUICKSTART lists graph in the pane kinds and as newer than 181 with its version', () => {
	const q = read('kit/examples/QUICKSTART.md').split('\n');
	assert.ok(q.find((l) => l.startsWith('| Pane kinds with app data')).includes('graph'));
	const row = q.find((l) => l.startsWith('| Panes newer than 181'));
	assert.ok(row.includes('graph') && row.includes(SINCE), row);
});

test('the gallery example draws a service map: a graph view, min_bolt_version 0.1.184, a check case with a golden', () => {
	const dir = 'kit/examples/widget-gallery-2';
	assert.equal(JSON.parse(read(`${dir}/bolt-app.json`)).min_bolt_version, SINCE);
	assert.match(read(`${dir}/utilities/widget-gallery-2.yaml`), /kind: graph/);
	const c = JSON.parse(read(`${dir}/check.json`)).cases.find((x) => x.args[0] === 'graph');
	assert.ok(c && c.golden, 'a graph case with a golden');
	assert.ok(fs.existsSync(path.join(REPO, dir, c.golden)));
	const rows = JSON.parse(read(`${dir}/${c.golden}`));
	const text = JSON.stringify(rows);
	assert.ok(text.includes('checkout-api') && text.includes('payments'));
});
