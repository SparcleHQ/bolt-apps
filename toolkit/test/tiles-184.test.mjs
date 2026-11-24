// Run: node --test toolkit/test/tiles-184.test.mjs
// Tile visuals that Bolt 0.1.184 draws on a cards tiles pane (bind.visual ring or bullet, bind.target, bind.limit): the rules file lists
// them with the version that first reads them, the schema agrees, lint accepts them when the app says min_bolt_version 0.1.184 and refuses
// them without it (an older Bolt refuses the whole pack, or ignores the key with a warning in a personal schema_version 1 file).
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
const TILES = ['layout: tiles', 'title: "{{row.label}}"', 'value: "{{row.value}}"', 'max: "{{row.max}}"', 'trend: "{{row.trend}}"'];
const app = (bindLines, version = 2) => [`schema_version: ${version}`, 'runtime: bridge', 'id: demo', 'chip: demo', 'title: "Demo"', 'icon: globe', 'description: "Demo"', 'emits: Generic',
	'bridge:', '  command:', '    macos: "python3 {{scripts_dir}}/demo__run.py"', '    linux: "python3 {{scripts_dir}}/demo__run.py"', '    windows: "python {{scripts_dir}}/demo__run.py"', '  parse: json', '  timeout_seconds: 20',
	'presentation:', '  widget: list', '  title_field: title', '  right_widget:', '    kind: cards', '    mode: list_data', '    bind:', ...[...TILES, ...bindLines].map((l) => '      ' + l)].join('\n') + '\n';
const P = (y, opts) => assessYaml(y, 'demo', { minBoltKnown: true, minBolt: SINCE, ...opts }).problems;
const errs = (y, opts) => P(y, opts).filter((p) => p.level !== 'warning').map((p) => p.code).sort();

test('rules: the three tile keys carry since 0.1.184 and the old cards keys carry none', () => {
	const c = RULES.right_widget.bind.cards;
	assert.deepEqual(c.visual, { t: 'enum', values: ['meter', 'ring', 'bullet', 'number', 'spark', 'strip', 'stack'], since: SINCE });
	assert.deepEqual(c.target, { t: 'textOrNumber', max: 4096, since: SINCE });
	assert.deepEqual(c.limit, { t: 'textOrNumber', max: 4096, since: SINCE });
	for (const [k, v] of Object.entries(c)) if (!['visual', 'visual_from', 'target', 'limit'].includes(k)) assert.equal(v.since, undefined, k);
	assert.equal(RULES.right_widget.bind.entity_preview.tiles_above.keys.visual, undefined, 'tiles_above does not read them yet');
});

test('schema: bindCards lists the keys with the same enum and the version in the description', () => {
	const s = JSON.parse(read('schema/user-app.schema.json')).$defs.bindCards.properties;
	assert.deepEqual(s.visual.enum, RULES.right_widget.bind.cards.visual.values);
	assert.deepEqual(s.target.type, ['string', 'number']);
	assert.deepEqual(s.limit.type, ['string', 'number']);
	for (const k of ['visual', 'target', 'limit']) assert.ok(s[k].description.includes(SINCE), k);
});

test('lint accepts ring, bullet with target, and a sparkline limit with min_bolt_version 0.1.184', () => {
	assert.deepEqual(errs(app(['visual: ring'])), []);
	assert.deepEqual(errs(app(['visual: bullet', 'target: "{{row.target}}"'])), []);
	assert.deepEqual(errs(app(['visual: meter', 'target: 70', 'limit: "{{row.limit}}"'])), []);
	assert.deepEqual(errs(app(['limit: 12.5'])), []);
});

test('lint refuses each new key without min_bolt_version 0.1.184, and with an older one', () => {
	for (const lines of [['visual: ring'], ['target: 70'], ['limit: 5']]) {
		assert.deepEqual(errs(app(lines), { minBolt: undefined }), ['bind_needs_newer_bolt'], lines.join());
		assert.deepEqual(errs(app(lines), { minBolt: '0.1.182' }), ['bind_needs_newer_bolt'], lines.join());
	}
	const g = P(app(['visual: ring']), { minBolt: undefined }).find((p) => p.code === 'bind_needs_newer_bolt');
	assert.ok(g.message.includes('min_bolt_version') && g.message.includes(SINCE), g.message);
	assert.deepEqual(errs(app([]), { minBolt: undefined }), []);   // a tiles pane without the new keys needs nothing
});

test('lint refuses what no Bolt reads: an unknown visual, a list or map for target and limit, a misspelt key', () => {
	assert.deepEqual(errs(app(['visual: donut'])), ['right_widget_bind_unread']);
	assert.deepEqual(errs(app(['target: [1, 2]'])), ['right_widget_bind_unread']);
	assert.deepEqual(errs(app(['limit: { a: 1 }'])), ['right_widget_bind_unread']);
	assert.deepEqual(errs(app(['visuel: ring'])), ['right_widget_bind_unread']);
});

test('a personal schema_version 1 file is gated too (an older Bolt warns and ignores the key; a pack is refused)', () => {
	assert.deepEqual(errs(app(['visual: ring'], 1), { minBolt: undefined }), ['bind_needs_newer_bolt']);
	assert.deepEqual(errs(app(['visual: ring'], 1), { pack: true, minBolt: undefined }), ['bind_needs_newer_bolt']);
});

test('the capability row names the keys, the version and an existing test', () => {
	const r = caps.rows.find((x) => x.id === 'pane.tile_visuals');
	assert.ok(r, 'row pane.tile_visuals');
	assert.equal(r.status, 'supported');
	assert.ok(r.limit.includes(SINCE) && r.limit.includes('min_bolt_version'), r.limit);
	assert.ok(fs.existsSync(path.join(REPO, r.test)), r.test);
	assert.ok(r.snippet.includes('visual') && r.snippet.includes('limit'));
});

test('QUICKSTART names the version of the new tile keys in the Panes newer row', () => {
	const row = read('kit/examples/QUICKSTART.md').split('\n').find((l) => l.startsWith('| Panes newer than 181'));
	assert.ok(row.includes('visual') && row.includes(SINCE), row);
});
