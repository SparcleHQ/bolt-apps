// Run: node --test toolkit/test/row-stack-185.test.mjs
// Per-row stack and tabs (Bolt 0.1.185, E4): a stack or tabs right pane with mode selected_row is bound to the selected row, and a `where`
// value may be one exact {{row.field}}. A Bolt 0.1.184 or older refuses mode selected_row on a stack or tabs (the whole pack), and silently
// matches nothing for the reference, so lint demands min_bolt_version 0.1.185 for each (promise B). Stripped of those keys an app needs nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assessYaml } from '../lib/assess.mjs';
import { RULES } from '../lib/boltrules.mjs';

const SINCE = '0.1.185';
const app = (kind, mode, bindLines) => ['schema_version: 2', 'runtime: bridge', 'id: demo', 'chip: demo', 'title: "Demo"', 'icon: globe', 'description: "Demo"', 'emits: Generic',
	'bridge:', '  command:', '    macos: "python3 {{scripts_dir}}/demo__run.py"', '    linux: "python3 {{scripts_dir}}/demo__run.py"', '    windows: "python {{scripts_dir}}/demo__run.py"', '  parse: json', '  timeout_seconds: 20',
	'presentation:', '  widget: list', '  title_field: title', '  right_widget:', `    kind: ${kind}`, ...(mode ? [`    mode: ${mode}`] : []), '    bind:', ...bindLines.map((l) => '      ' + l)].join('\n') + '\n';
const stackRow = (children) => app('stack', 'selected_row', ['children:', ...children.map((c) => '  - ' + c)]);
const tabsRow = (tabs) => app('tabs', 'selected_row', ['tabs:', ...tabs.map((t) => '  - ' + t)]);
const P = (y, opts) => assessYaml(y, 'demo', { minBoltKnown: true, minBolt: SINCE, ...opts }).problems;
const errs = (y, opts) => P(y, opts).filter((p) => p.level !== 'warning').map((p) => p.code).sort();
const msgs = (y, opts) => P(y, opts).filter((p) => p.level !== 'warning').map((p) => p.message).join(' | ');
const HIST = '{ kind: chart, bind: { y: v, from: { set: hist, where: { h_src: "{{row.source}}" } } } }';
const OK_STACK = stackRow(['{ kind: detail }', HIST]);
const OK_TABS = tabsRow(['{ label: Details, widget: { kind: detail } }', `{ label: History, count_from: { set: hist, where: { h_src: "{{row.source}}" } }, widget: ${HIST} }`]);

test('rules: feature_since names the three per-row features at 0.1.185; stack and tabs may be a row pane', () => {
	assert.deepEqual(RULES.feature_since, { 'stack.mode.selected_row': SINCE, 'tabs.mode.selected_row': SINCE, 'where.row_ref': SINCE });
	assert.ok(RULES.row_pane_kinds.includes('stack') && RULES.row_pane_kinds.includes('tabs'));
});

test('lint accepts a per-row stack and per-row tabs with min_bolt_version 0.1.185', () => {
	assert.deepEqual(errs(OK_STACK), []);
	assert.deepEqual(errs(OK_TABS), []);
	assert.deepEqual(errs(app('tabs', 'selected_row', ['tabs:', '  - label: A', '    widget: { kind: stack, bind: { children: [{ kind: detail }, { kind: gauge }] } }'])), []);
});

test('promise B: each new key is gated on min_bolt_version 0.1.185 and says what an older Bolt does', () => {
	const noRef = stackRow(['{ kind: detail }', '{ kind: gauge }']);   // only mode: selected_row is new here
	for (const [y, feat] of [[noRef, 'stack.mode.selected_row'], [tabsRow(['{ label: A, widget: { kind: detail } }']), 'tabs.mode.selected_row']]) {
		for (const minBolt of [undefined, '0.1.184', '0.1.183']) {
			const e = P(y, { minBolt }).filter((p) => p.code === 'bind_needs_newer_bolt' && p.message.includes(`(${feat})`));
			assert.equal(e.length, 1, `${feat} ${minBolt}`);
			assert.match(e[0].message, /mode/);
			assert.match(e[0].message, /REFUSES THE WHOLE PACK/);
		}
		assert.deepEqual(errs(y), []);
	}
	// the where reference alone (a stack that stays list_data cannot hold it, so it is tested inside a row pane with a gate on the reference)
	const e = P(OK_STACK, { minBolt: '0.1.184' }).filter((p) => p.code === 'bind_needs_newer_bolt' && p.message.includes('(where.row_ref)'));
	assert.equal(e.length, 1);
	assert.match(e[0].message, /per-row pane/);
	assert.match(e[0].message, /install-time check is not built/);
});

test('a packed read (minBoltKnown false) is a warning, as for every other gate', () => {
	const w = P(OK_STACK, { minBolt: undefined, minBoltKnown: false }).filter((p) => p.code === 'bind_needs_newer_bolt' && p.message.includes('.selected_row)'));
	assert.ok(w.length >= 1 && w.every((p) => p.level === 'warning'));
});

test('stripped of the new keys the app needs no newer Bolt and still lints clean', () => {
	const stripped = app('detail', 'selected_row', ['title: "{{row.t}}"']);
	assert.deepEqual(P(stripped, { minBolt: undefined }).filter((p) => p.code === 'bind_needs_newer_bolt'), []);
	const overview = app('stack', 'list_data', ['children:', '  - { kind: table, bind: { from: { set: hist, where: { h_src: cpu } } } }']);
	assert.deepEqual(P(overview, { minBolt: '0.1.184' }).filter((p) => p.code === 'bind_needs_newer_bolt'), []);
});

test('row pane rules mirror the launcher: list_data part needs from, tab stack is selected_row, absent mode says both values', () => {
	assert.match(msgs(stackRow(['{ kind: table }'])), /children\[0\]\.bind\.from is required in a row pane/);
	assert.match(msgs(tabsRow(['{ label: A, widget: { kind: chart } }'])), /tabs\[0\]\.widget\.bind\.from is required in a row pane/);
	assert.deepEqual(errs(stackRow(['{ kind: table, mode: selected_row }', '{ kind: detail }'])), []);
	assert.match(msgs(tabsRow(['{ label: A, widget: { kind: stack, mode: list_data, bind: { children: [{ kind: detail }] } } }'])), /a stack inside row tabs needs mode: selected_row/);
	assert.match(msgs(app('stack', undefined, ['children:', '  - { kind: detail }'])), /a stack needs mode: list_data/);
});

test('a row reference is exactly {{row.field}}, only in a row pane, at most 6 distinct fields', () => {
	for (const bad of ['{{row.x}} suffix', 'pre {{row.x}}', '{{row.x|upper}}', '{{count}}', '{{env.HOME}}', '{{row.}}', '{{row.X}}', '{{ row.x }}', '{{row.__proto__}}', '{{row.a.b}}']) {
		const y = tabsRow([`{ label: A, widget: { kind: chart, bind: { from: { set: hist, where: { h: "${bad}" } } } } }`]);
		assert.match(msgs(y), /where\.h/, bad);
	}
	const overview = app('tabs', 'list_data', ['tabs:', `  - { label: A, widget: { kind: chart, bind: { from: { set: hist, where: { h: "{{row.x}}" } } } } }`]);
	assert.match(msgs(overview), /only allowed in a pane with mode: selected_row/);
	const tab = (f) => `{ label: T${f}, widget: { kind: chart, bind: { from: { set: s, where: { k: "{{row.${f}}}" } } } } }`;
	assert.deepEqual(errs(tabsRow(['a', 'b', 'c', 'd', 'e', 'f'].map(tab))), []);
	assert.match(msgs(tabsRow(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(tab))), /at most 6 distinct row fields/);
	assert.deepEqual(errs(tabsRow(Array.from({ length: 8 }, () => tab('a')))), []);
});

test('reserved names: only constructor and prototype can be spelled; lower case look-alikes are ordinary fields (native and pwa agree)', () => {
	const y = (f) => tabsRow([`{ label: A, widget: { kind: chart, bind: { from: { set: hist, where: { h: "{{row.${f}}}" } } } } }`]);
	for (const ok of ['tostring', 'valueof', 'hasownproperty']) assert.deepEqual(errs(y(ok)), [], ok);
	for (const bad of ['constructor', 'prototype', '__proto__']) assert.match(msgs(y(bad)), /where\.h/, bad);
});

test('a plain Overview stack and tabs lint exactly as before', () => {
	assert.deepEqual(errs(app('stack', 'list_data', ['children:', '  - { kind: table }'])), []);
	assert.match(msgs(app('tabs', 'list_data', ['tabs:', '  - label: A', '    widget: { kind: stack, mode: selected_row, bind: { children: [{ kind: detail }] } }'])), /a stack needs mode: list_data/);
});
