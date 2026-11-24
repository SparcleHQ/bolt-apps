// Run: node --test toolkit/test/activate-184.test.mjs
// Pane-item events that Bolt 0.1.184 reads (bind.activate on a table or cards pane): the rules file lists the key with the version that first reads it,
// the schema agrees, lint accepts a valid one when the app says min_bolt_version 0.1.184, refuses it without, and refuses every target the launcher
// would silently ignore (both or neither of nav and action, a view or action the app does not declare, a run or utility action, a literal arg that
// is not one plain token, no view binding).
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
const ACTIONS = ['actions:', '  - { id: open, kind: url, target: row, label: Open, url_template: "{{row.u}}" }', '  - { id: copy, kind: composer, target: row, label: Copy, insert: "{{row.c}}" }',
	'  - { id: go, kind: run, label: Go, query_template: "refresh" }', '  - { id: chain, kind: utility, target_chip: other, label: Chain, query_template: "{{row.id}}" }'];
const app = (kind, bindLines, { version = 2, viewArg = true, actions = ACTIONS } = {}) => [`schema_version: ${version}`, 'runtime: bridge', 'id: demo', 'chip: demo', 'title: "Demo"', 'icon: globe', 'description: "Demo"', 'emits: Generic',
	...(viewArg ? ['args:', '  - { name: view, from: "query.word(0)", default: overview }'] : []),
	'bridge:', '  command:', '    macos: "python3 {{scripts_dir}}/demo__run.py"', '    linux: "python3 {{scripts_dir}}/demo__run.py"', '    windows: "python {{scripts_dir}}/demo__run.py"', '  parse: json', '  timeout_seconds: 20',
	'presentation:', '  widget: list', '  title_field: title', ...(viewArg ? ['  view_arg: view'] : []), '  right_widget:', `    kind: ${kind}`, '    mode: list_data', '    bind:', ...bindLines.map((l) => '      ' + l),
	...(viewArg ? ['  views:', '    overview: {}', '    detail:', '      right_widget:', '        kind: detail', '        mode: selected_row', '        bind:', '          title: "{{row.title}}"'] : []),
	...actions].join('\n') + '\n';
const P = (y, opts) => assessYaml(y, 'demo', { minBoltKnown: true, minBolt: SINCE, ...opts }).problems;
const errs = (y, opts) => P(y, opts).filter((p) => p.level !== 'warning').map((p) => p.code).sort();
const msg = (y, code) => P(y).find((p) => p.code === code)?.message ?? '';
const NAV = ['activate:', '  nav: { view: detail, arg: "{{row.id}}" }'];

test('rules: activate carries since 0.1.184 on table and cards and nothing else gained it', () => {
	for (const kind of ['table', 'cards']) {
		const a = RULES.right_widget.bind[kind].activate;
		assert.equal(a.t, 'map', kind);
		assert.equal(a.since, SINCE, kind);
		assert.deepEqual(a.keys.nav.keys.view, { t: 'text', max: 200, required: true });
		assert.deepEqual(a.keys.nav.keys.arg, { t: 'text', max: 4096 });
		assert.deepEqual(a.keys.action, { t: 'text', max: 200 });
	}
	for (const kind of ['chart', 'detail', 'heatmap', 'gauge', 'card']) assert.equal(RULES.right_widget.bind[kind].activate, undefined, kind);
});

test('schema: bindTable and bindCards take activate, one of nav or action, with the version in the description', () => {
	const defs = JSON.parse(read('schema/user-app.schema.json')).$defs;
	for (const k of ['bindTable', 'bindCards']) assert.deepEqual(defs[k].properties.activate, { $ref: '#/$defs/bindActivate' }, k);
	const a = defs.bindActivate;
	assert.deepEqual(Object.keys(a.properties), ['nav', 'action']);
	assert.deepEqual(a.oneOf, [{ required: ['nav'] }, { required: ['action'] }]);
	assert.equal(a.additionalProperties, false);
	assert.ok(a.description.includes(SINCE));
	assert.deepEqual(a.properties.nav.required, ['view']);
});

test('lint accepts nav to a declared view and an action that is a url or composer action, with min_bolt_version 0.1.184', () => {
	for (const kind of ['table', 'cards']) {
		assert.deepEqual(errs(app(kind, NAV)), [], kind);
		assert.deepEqual(errs(app(kind, ['activate:', '  nav: { view: detail }'])), [], kind);
		assert.deepEqual(errs(app(kind, ['activate:', '  nav: { view: detail, arg: fixed-token }'])), [], kind);
		assert.deepEqual(errs(app(kind, ['activate:', '  action: copy'])), [], kind);
		assert.deepEqual(errs(app(kind, ['activate:', '  action: open'])), [], kind);
	}
});

test('lint refuses activate without min_bolt_version 0.1.184, and with an older one', () => {
	assert.deepEqual(errs(app('table', NAV), { minBolt: undefined }), ['bind_needs_newer_bolt']);
	assert.deepEqual(errs(app('table', NAV), { minBolt: '0.1.182' }), ['bind_needs_newer_bolt']);
	assert.ok(msg(app('table', NAV), 'bind_needs_newer_bolt') === '', 'no gate problem when the version is declared');
	const g = P(app('cards', NAV), { minBolt: undefined }).find((p) => p.code === 'bind_needs_newer_bolt');
	assert.ok(g.message.includes('min_bolt_version') && g.message.includes(SINCE), g.message);
	assert.deepEqual(errs(app('table', ['sort: { field: a }']), { minBolt: undefined }), [], 'a table without activate needs nothing');
});

test('lint: exactly one of nav or action', () => {
	assert.deepEqual(errs(app('table', ['activate: {}'])), ['activate_one_of']);
	assert.deepEqual(errs(app('table', ['activate:', '  nav: { view: detail }', '  action: copy'])), ['activate_one_of']);
	assert.ok(msg(app('table', ['activate: {}']), 'activate_one_of').includes('exactly one of nav or action'));
});

test('lint: a view or an action the app does not declare is an error (the launcher would do nothing)', () => {
	assert.deepEqual(errs(app('table', ['activate:', '  nav: { view: ghost }'])), ['activate_view']);
	assert.deepEqual(errs(app('table', ['activate:', '  nav: { view: constructor }'])), ['activate_view']);
	assert.deepEqual(errs(app('table', ['activate:', '  action: nope'])), ['activate_action']);
	assert.deepEqual(errs(app('table', ['activate:', '  action: __proto__'])), ['activate_action']);
	assert.ok(msg(app('table', ['activate:', '  nav: { view: ghost }']), 'activate_view').includes('detail'), 'names the declared views');
});

test('lint: a run or utility action cannot take an item (it has no item fields to run with)', () => {
	for (const id of ['go', 'chain']) {
		assert.deepEqual(errs(app('cards', ['activate:', `  action: ${id}`])), ['activate_action_kind'], id);
		assert.ok(msg(app('cards', ['activate:', `  action: ${id}`]), 'activate_action_kind').includes('url or composer'), id);
	}
});

test('lint: a literal arg that is not one plain token is an error; a template is left to the pane', () => {
	for (const arg of ['"../x"', '"-all"', '"a b"', '"a..b"', `"${'a'.repeat(65)}"`]) {
		assert.deepEqual(errs(app('table', ['activate:', `  nav: { view: detail, arg: ${arg} }`])), ['activate_arg'], arg);
	}
	assert.deepEqual(errs(app('table', ['activate:', '  nav: { view: detail, arg: "{{row.a}}-{{row.b}}" }'])), []);
});

test('lint: nav needs the app to bind a view arg, else no navigation exists', () => {
	assert.deepEqual(errs(app('table', ['activate:', '  nav: { view: detail }'], { viewArg: false })), ['activate_view', 'activate_view_arg'].sort());
	assert.deepEqual(errs(app('table', ['activate:', '  action: copy'], { viewArg: false })), []);
});

test('lint: unknown and mistyped keys under activate are refused by name', () => {
	assert.deepEqual(errs(app('table', ['activate:', '  nav: { view: detail, args: x }'])), ['right_widget_bind_unread']);
	assert.deepEqual(errs(app('table', ['activate:', '  on: copy'])).includes('right_widget_bind_unread'), true);
	assert.deepEqual(errs(app('table', ['activate: copy'])).includes('right_widget_bind_unread'), true);
	assert.deepEqual(errs(app('table', ['activate:', '  nav: { arg: x }'])).includes('right_widget_bind_unread'), true);
});

test('a personal schema_version 1 file is gated too', () => {
	assert.deepEqual(errs(app('table', NAV, { version: 1 }), { minBolt: undefined }), ['bind_needs_newer_bolt']);
});

test('the capability row names the key, the version and an existing test', () => {
	const r = caps.rows.find((x) => x.id === 'pane.item_activate');
	assert.ok(r, 'row pane.item_activate');
	assert.equal(r.status, 'supported');
	assert.ok(r.limit.includes(SINCE) && r.limit.includes('min_bolt_version'), r.limit);
	assert.ok(fs.existsSync(path.join(REPO, r.test)), r.test);
	assert.ok(r.snippet.includes('activate'));
});

test('the widget gallery table drills into the detail view and says so in its check case', () => {
	const y = read('kit/examples/widget-gallery/utilities/widget-gallery.yaml');
	assert.match(y, /activate:\n\s+nav:\n\s+view: "detail"\n\s+arg: "\{\{row\.service\}\}"/);
	assert.equal(JSON.parse(read('kit/examples/widget-gallery/bolt-app.json')).min_bolt_version, SINCE);
	const c = JSON.parse(read('kit/examples/widget-gallery/check.json')).cases.find((x) => /activate/.test(x.name));
	assert.ok(c, 'a check case about activate');
	assert.deepEqual(errs(y, {}), []);
});

test('QUICKSTART names the version of activate in the Panes newer row', () => {
	const row = read('kit/examples/QUICKSTART.md').split('\n').find((l) => l.startsWith('| Panes newer than 181'));
	assert.ok(row.includes('activate') && row.includes(SINCE), row);
});
