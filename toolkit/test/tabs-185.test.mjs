// Run: node --test toolkit/test/tabs-185.test.mjs
// The `tabs` right pane (Bolt 0.1.185): several views in one pane, each tab one whole existing widget. The rules file lists it with the
// version that first reads it; lint refuses it without min_bolt_version 0.1.185 (a Bolt 0.1.184 or older REFUSES THE WHOLE PACK for an unknown
// kind) and accepts it with the declaration; the tab rules (1 to 12 tabs, labels, count_from, status, no tabs inside a tab) match the launcher's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assessYaml } from '../lib/assess.mjs';
import { RULES } from '../lib/boltrules.mjs';
import { FIXES } from '../lib/verify.mjs';

const SINCE = '0.1.185';
const app = (bindLines, mode = 'list_data') => ['schema_version: 2', 'runtime: bridge', 'id: demo', 'chip: demo', 'title: "Demo"', 'icon: globe', 'description: "Demo"', 'emits: Generic',
	'bridge:', '  command:', '    macos: "python3 {{scripts_dir}}/demo__run.py"', '    linux: "python3 {{scripts_dir}}/demo__run.py"', '    windows: "python {{scripts_dir}}/demo__run.py"', '  parse: json', '  timeout_seconds: 20',
	'presentation:', '  widget: list', '  title_field: title', '  right_widget:', '    kind: tabs', `    mode: ${mode}`, '    bind:', ...bindLines.map((l) => '      ' + l)].join('\n') + '\n';
const P = (y, opts) => assessYaml(y, 'demo', { minBoltKnown: true, minBolt: SINCE, ...opts }).problems;
const errs = (y, opts) => P(y, opts).filter((p) => p.level !== 'warning').map((p) => p.code).sort();
const msgs = (y, opts) => P(y, opts).filter((p) => p.level !== 'warning').map((p) => p.message).join(' | ');
const ONE = ['tabs:', '  - label: Alerts', '    widget: { kind: table }'];

test('rules: tabs is a kind with its own bind, first read by Bolt 0.1.185', () => {
	assert.ok(RULES.widget_kinds.includes('tabs'));
	assert.equal(RULES.kind_since.tabs, SINCE);
	const t = RULES.right_widget.bind.tabs.tabs;
	assert.equal(t.items, 12);
	assert.equal(t.min, 1);
	assert.deepEqual(Object.keys(t.keys), ['label', 'count_from', 'status', 'widget']);
	assert.equal(t.keys.label.max, 40);
	assert.deepEqual(t.keys.status.values, ['critical', 'warning']);
	assert.ok(!t.keys.widget.keys.kind.values.includes('tabs'), 'no tabs inside a tab');
});

test('lint accepts tabs with min_bolt_version 0.1.185', () => {
	assert.deepEqual(errs(app(ONE)), []);
	assert.deepEqual(errs(app(['tabs:', '  - label: Overview', '    widget: { kind: stack, bind: { children: [{ kind: cards }] } }', '  - label: Alerts', '    count_from: { set: alerts }', '    status: critical', '    widget: { kind: table }'])), []);
});

test('lint refuses tabs without min_bolt_version 0.1.185, and with an older one (older Bolt refuses the whole pack)', () => {
	assert.deepEqual(errs(app(ONE), { minBolt: undefined }), ['bind_needs_newer_bolt']);
	assert.deepEqual(errs(app(ONE), { minBolt: '0.1.184' }), ['bind_needs_newer_bolt']);
	assert.deepEqual(errs(app(ONE), { minBolt: '0.1.183' }), ['bind_needs_newer_bolt']);
	assert.deepEqual(errs(app(ONE), { minBolt: '0.1.186' }), []);
	assert.match(msgs(app(ONE), { minBolt: '0.1.184' }), /needs Bolt 185/);
});

test('lint holds the launcher tab rules: 1 to 12 tabs, labels, status needs count_from, no tabs in a tab, kinds', () => {
	assert.ok(errs(app(['tabs: []'])).includes('right_widget_bind_unread'));
	const thirteen = ['tabs:', ...Array.from({ length: 13 }, () => ['  - label: T', '    widget: { kind: table }']).flat()];
	assert.match(msgs(app(thirteen)), /more than 12 entries/);
	const twelve = ['tabs:', ...Array.from({ length: 12 }, () => ['  - label: T', '    widget: { kind: table }']).flat()];
	assert.deepEqual(errs(app(twelve)), []);
	assert.match(msgs(app(['tabs:', `  - label: ${'l'.repeat(41)}`, '    widget: { kind: table }'])), /longer than 40/);
	assert.deepEqual(errs(app(['tabs:', `  - label: ${'l'.repeat(40)}`, '    widget: { kind: table }'])), []);
	assert.match(msgs(app(['tabs:', '  - label: "   "', '    widget: { kind: table }'])), /must not be empty/);
	assert.match(msgs(app(['tabs:', '  - widget: { kind: table }'])), /label: is required/);
	assert.match(msgs(app(['tabs:', '  - label: A'])), /widget: is required/);
	assert.match(msgs(app(['tabs:', '  - label: A', '    icon: x', '    widget: { kind: table }'])), /icon: not a key/);
	assert.match(msgs(app(['tabs:', '  - label: A', '    widget: { kind: tabs }'])), /must be one of cards, chart, table, heatmap, gauge, detail, markdown, stack/);
	assert.match(msgs(app(['tabs:', '  - label: A', '    widget: { kind: banana }'])), /must be one of/);
	assert.match(msgs(app(['tabs:', '  - label: A', '    status: critical', '    widget: { kind: table }'])), /status needs count_from|count_from/);
});

test('labels refuse invisible format characters (Unicode Cf, U+2028, U+2029) the way the launcher does', () => {
	const label = (l) => app(['tabs:', `  - label: "${l}"`, '    widget: { kind: table }']);
	// Some of them the file reader already refuses anywhere in a file (the app reads as unknown, tier 3): that must stay so.
	for (const c of ['\u200B', '\u2028', '\u2029', '\u202E', '\u00AD', '\u2060', '\uFEFF']) {
		const r = assessYaml(label(c), 'demo', { minBoltKnown: true, minBolt: SINCE });
		assert.equal(r.unknown, true, JSON.stringify(c));
	}
	// The rest parse, and the tab label rule is what refuses them: blank without them is "must not be empty", else the control-character words.
	for (const blank of ['\u200D', '\u200C \u200D', '\u180E', '\u061C', '\u{E0001}', '\u200D\u061C']) assert.match(msgs(label(blank)), /must not be empty/, JSON.stringify(blank));
	for (const mixed of ['a\u200Db', 'a\u200C', '\u180Ea', 'a\u061Cb', 'a\u{E0001}']) assert.match(msgs(label(mixed)), /must not contain control characters or line breaks/, JSON.stringify(mixed));
	assert.deepEqual(errs(label('Caf\u00E9')), []);
});

test('a tab widget is checked like the launcher checks a part: stack needs list_data and children, no activate, from needs list_data, own bind keys', () => {
	const w = (widget) => app(['tabs:', '  - label: A', `    widget: ${widget}`]);
	const refused = (widget, re) => assert.match(msgs(w(widget)), re, widget);
	refused('{ kind: stack }', /widget\.bind\.children: is required for a stack/);
	refused('{ kind: stack, mode: selected_row, bind: { children: [{ kind: cards }] } }', /widget\.mode: a stack needs mode: list_data/);
	refused('{ kind: table, bind: { activate: { view: x } } }', /activate is not supported inside a tab/);
	refused('{ kind: table, mode: selected_row, bind: { from: { set: a } } }', /bind\.from: needs mode: list_data/);
	refused('{ kind: table, bind: { bogus: 1 } }', /bogus/);
	// accepted, as the launcher accepts them: a stack with no mode (it defaults to list_data in a tab), a table with from and no mode (a table defaults to list_data)
	assert.deepEqual(errs(w('{ kind: stack, bind: { children: [{ kind: cards }] } }')), []);
	assert.deepEqual(errs(w('{ kind: stack, mode: list_data, bind: { children: [{ kind: cards }] } }')), []);
	if (RULES.right_widget.bind.table.from) assert.deepEqual(errs(w('{ kind: table, bind: { from: { set: a } } }')), []);   // bind.from is a table key from Bolt 184 (not in this rules file until then)
	assert.deepEqual(errs(w('{ kind: gauge, mode: selected_row, bind: { value: "{{row.a}}" } }')), []);
});

test('the version gate for tabs names the right versions: a 184 or older refuses, set 0.1.185', () => {
	const m = msgs(app(ONE), { minBolt: undefined });
	assert.match(m, /needs Bolt 185/);
	assert.match(m, /0\.1\.184 or older REFUSES THE WHOLE PACK/);
	assert.match(m, /Set "min_bolt_version": "0\.1\.185"/);
	assert.doesNotMatch(m, /0\.1\.181/);
	assert.match(FIXES.bind_needs_newer_bolt, /0\.1\.185/);
});

test('a tab status is critical or warning', () => {
	assert.deepEqual(errs(app(['tabs:', '  - label: A', '    count_from: { set: a }', '    status: warning', '    widget: { kind: table }'])), []);
	assert.match(msgs(app(['tabs:', '  - label: A', '    count_from: { set: a }', '    status: fine', '    widget: { kind: table }'])), /must be one of critical, warning/);
});

test('tabs with a bind the other kinds do not read: the other kinds refuse the tabs key', () => {
	const y = app(ONE).replace('kind: tabs', 'kind: table');
	assert.ok(errs(y).includes('right_widget_bind_unread'));
});

// The agent guide and the sample: an agent reading QUICKSTART must be told tabs needs Bolt 0.1.185, and a working sample must exist.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const REPO185 = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const rd = (f) => fs.readFileSync(path.join(REPO185, f), 'utf8');

test('guide: the rules step tells an agent that tabs needs min_bolt_version 0.1.185 and that an older Bolt refuses the pack', () => {
	const step = rd('kit/examples/QUICKSTART.md').split('\n').find((l) => l.startsWith('5. Use only the panes'));
	assert.ok(step, 'step 5 exists');
	assert.match(step, /`tabs`/);
	assert.match(step, /min_bolt_version` 0\.1\.185/);
	assert.match(step, /184 or older refuses the whole pack/);
});

test('sample: tabs-gallery uses a tabs pane, declares 0.1.185, is listed in the index and named by the tabs capability row', () => {
	const dir = 'kit/examples/tabs-gallery';
	assert.equal(JSON.parse(rd(`${dir}/bolt-app.json`)).min_bolt_version, SINCE);
	const yaml = rd(`${dir}/utilities/tabs-gallery.yaml`);
	assert.match(yaml, /kind: tabs/);
	assert.match(yaml, /label: "Trend"/);
	assert.deepEqual(errs(yaml.replace(/^schema_version: 1/m, 'schema_version: 2')), []);
	assert.ok(JSON.parse(rd('kit/examples/index.json')).apps.some((a) => a.id === 'tabs-gallery'));
	assert.equal(JSON.parse(rd('kit/examples/capabilities.json')).rows.find((r) => r.id === 'widget.tabs').example, dir);
});
