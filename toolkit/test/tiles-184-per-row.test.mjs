// Run: node --test toolkit/test/tiles-184-per-row.test.mjs
// S3b: bind.visual_from names a ROW FIELD whose value picks each tile's visual, so one cards grid can mix tiles. Bolt 0.1.184 or newer.
// The rules file, the schema, lint (bind_needs_newer_bolt) all agree.
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
const VISUALS = ['meter', 'ring', 'bullet', 'number', 'spark', 'strip', 'stack'];
const TILES = ['layout: tiles', 'title: "{{row.label}}"', 'value: "{{row.value}}"', 'max: "{{row.max}}"', 'trend: "{{row.trend}}"'];
const app = (bindLines, version = 2) => [`schema_version: ${version}`, 'runtime: bridge', 'id: demo', 'chip: demo', 'title: "Demo"', 'icon: globe', 'description: "Demo"', 'emits: Generic',
	'bridge:', '  command:', '    macos: "python3 {{scripts_dir}}/demo__run.py"', '    linux: "python3 {{scripts_dir}}/demo__run.py"', '    windows: "python {{scripts_dir}}/demo__run.py"', '  parse: json', '  timeout_seconds: 20',
	'presentation:', '  widget: list', '  title_field: title', '  right_widget:', '    kind: cards', '    mode: list_data', '    bind:', ...[...TILES, ...bindLines].map((l) => '      ' + l)].join('\n') + '\n';
const P = (y, opts) => assessYaml(y, 'demo', { minBoltKnown: true, minBolt: SINCE, ...opts }).problems;
const errs = (y, opts) => P(y, opts).filter((p) => p.level !== 'warning').map((p) => p.code).sort();

test('rules: visual_from is a 200 character text key since 0.1.184; visual lists the seven visuals', () => {
	const c = RULES.right_widget.bind.cards;
	assert.deepEqual(c.visual_from, { t: 'text', max: 200, since: SINCE });
	assert.deepEqual(c.visual.values, VISUALS);
	assert.equal(c.visual.values.includes('donut'), false, 'a donut is the ring');
});

test('schema: bindCards has visual_from as a string of at most 200 and the same visual list', () => {
	const s = JSON.parse(read('schema/user-app.schema.json')).$defs.bindCards.properties;
	assert.equal(s.visual_from.type, 'string');
	assert.equal(s.visual_from.maxLength, 200);
	assert.ok(s.visual_from.description.includes(SINCE));
	assert.deepEqual(s.visual.enum, VISUALS);
});

test('lint accepts visual_from with min_bolt_version 0.1.184 and every visual value', () => {
	assert.deepEqual(errs(app(['visual_from: kind', 'visual: ring', 'target: "{{row.target}}"'])), []);
	for (const v of VISUALS) assert.deepEqual(errs(app([`visual: ${v}`])), [], v);
});

test('lint refuses visual_from without min_bolt_version, and for an old schema_version 1 app and a pack', () => {
	const g = P(app(['visual_from: kind']), { minBolt: undefined }).find((p) => p.code === 'bind_needs_newer_bolt');
	assert.ok(g, 'bind_needs_newer_bolt');
	assert.match(g.message, /visual_from/);
	assert.deepEqual(errs(app(['visual_from: kind'], 1), { minBolt: undefined }), ['bind_needs_newer_bolt']);
	assert.deepEqual(errs(app(['visual_from: kind'], 1), { pack: true, minBolt: undefined }), ['bind_needs_newer_bolt']);
});

test('lint refuses a wrong typed or long visual_from and an unknown visual', () => {
	assert.ok(errs(app(['visual_from: [kind]'])).length > 0);
	assert.ok(errs(app(['visual_from: { a: 1 }'])).length > 0);
	assert.ok(errs(app([`visual_from: "${'x'.repeat(201)}"`])).length > 0);
	assert.ok(errs(app(['visual: donut'])).length > 0);
	assert.deepEqual(errs(app(['visual_fom: kind'])), ['right_widget_bind_unread']);
});

test('capabilities: pane.tile_visual_from exists with its own test, and pane.tile_visuals states what is not a tile', () => {
	const r = caps.rows.find((x) => x.id === 'pane.tile_visual_from');
	assert.ok(r);
	assert.ok(fs.existsSync(path.join(REPO, r.test)));
	const t = caps.rows.find((x) => x.id === 'pane.tile_visuals');
	assert.match(t.limit, /multi-series line or a full chart is not a tile/);
	assert.match(t.limit, /donut is the ring/);
});
