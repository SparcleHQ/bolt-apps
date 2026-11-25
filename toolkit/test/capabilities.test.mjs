// Run: node --test toolkit/test/capabilities.test.mjs
// kit/examples/capabilities.json is the capability matrix. A supported row must point at a real example (or say none exists), carry a
// copy-paste snippet and name a test file that exists; kinds and limits must agree with schema/bolt-rules.json; CAPABILITIES.md must be fresh.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RULES } from '../lib/boltrules.mjs';
import { caps, placeholders, resolve, render } from '../../scripts/build-capabilities.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const exists = (p) => fs.existsSync(path.join(REPO, p));
const index = JSON.parse(fs.readFileSync(path.join(REPO, 'kit/examples/index.json'), 'utf8'));

test('every row has the fields and a known status; ids are unique', () => {
	const ids = new Set();
	for (const r of caps.rows) {
		for (const k of ['id', 'group', 'name', 'status', 'snippet', 'test', 'limit']) assert.ok(typeof r[k] === 'string' && r[k].length, `${r.id}: ${k}`);
		assert.ok(caps.status_words.includes(r.status), `${r.id}: status ${r.status}`);
		assert.ok(!ids.has(r.id), `duplicate ${r.id}`); ids.add(r.id);
		assert.ok(exists(r.test), `${r.id}: test file ${r.test} does not exist`);
	}
});

test('a supported or partial row has an existing example (or says there is none), and a snippet', () => {
	for (const r of caps.rows.filter((x) => x.status !== 'not supported')) {
		if (r.example) assert.ok(exists(r.example), `${r.id}: example ${r.example} does not exist`);
		else assert.ok(r.example_note, `${r.id}: no example and no example_note`);
		for (const a of r.also || []) assert.ok(exists(`kit/examples/${a}`), `${r.id}: example ${a} does not exist`);
		assert.ok(r.snippet.trim().length > 3, r.id);
	}
	assert.ok(caps.rows.filter((r) => r.status === 'supported' && !r.example).length <= 10, 'too many supported rows without an example: add one');
});

test('a not-supported row names no example and does not claim a snippet that works', () => {
	for (const r of caps.rows.filter((x) => x.status === 'not supported')) assert.ok(!r.example && /none|use a url action|use table/.test(r.snippet), r.id);
});

// a JSON snippet taken from an example must really be in that example's config.json
const subset = (frag, doc) => {
	if (frag && typeof frag === 'object') return doc && typeof doc === 'object' && (Array.isArray(frag) ? frag.every((f) => Array.isArray(doc) && doc.some((d) => subset(f, d))) : Object.entries(frag).every(([k, v]) => subset(v, doc[k])));
	return frag === doc;
};
const anywhere = (frag, doc) => subset(frag, doc) || (doc && typeof doc === 'object' && Object.values(doc).some((d) => anywhere(frag, d)));
test('a JSON snippet appears in its example config.json', () => {
	let checked = 0;
	for (const r of caps.rows.filter((x) => x.example && x.status === 'supported')) {
		const cfg = path.join(REPO, r.example, 'scripts', `${path.basename(r.example)}__config.json`);
		let frag; try { frag = JSON.parse(r.snippet.trim().startsWith('{') ? r.snippet : `{${r.snippet}}`); } catch { continue; }
		if (!fs.existsSync(cfg)) continue;
		const yamlText = fs.readFileSync(path.join(REPO, r.example, 'utilities', fs.readdirSync(path.join(REPO, r.example, 'utilities'))[0]), 'utf8');
		const doc = JSON.parse(fs.readFileSync(cfg, 'utf8'));
		const inYaml = yamlText.includes(`kind: ${frag.kind}`) && frag.mode && yamlText.includes(`mode: ${frag.mode}`);
		assert.ok(anywhere(frag, doc) || inYaml, `${r.id}: the snippet is not in ${r.example}`); checked++;
	}
	assert.ok(checked >= 15, `only ${checked} snippets were checked`);
});

test('widget kinds in the matrix equal the rules file', () => {
	const kinds = caps.rows.flatMap((r) => (r.kind ? [r.kind] : r.kinds || []));
	assert.deepEqual([...new Set(kinds)].sort(), [...RULES.widget_kinds].sort());
	for (const r of caps.rows.filter((x) => x.kind)) { assert.equal(r.status, 'supported'); assert.ok(!RULES.no_app_data_kinds.includes(r.kind) && r.kind !== 'map', r.kind); }
	const none = caps.rows.find((r) => r.id === 'widget.no_app_data'), map = caps.rows.find((r) => r.id === 'widget.map');
	assert.deepEqual([...none.kinds].sort(), [...RULES.no_app_data_kinds].sort());
	assert.deepEqual(map.kinds, ['map']);
	assert.equal(none.status, 'not supported'); assert.equal(map.status, 'not supported');
});

test('limits come from the rules file: every placeholder resolves and the key limits are present', () => {
	for (const r of caps.rows) for (const p of placeholders(r.limit)) assert.notEqual(resolve(`{rules:${p}}`), 'undefined', `${r.id}: ${p}`);
	const footer = resolve(caps.rows.find((r) => r.id === 'actions.footer').limit);
	for (const n of [RULES.actions.footer_max_bolt, RULES.actions.footer_max_kit, RULES.actions.label_kept_bolt, RULES.actions.label_shown]) assert.ok(footer.includes(String(n)), `footer row lacks ${n}`);
	assert.ok(resolve(caps.rows.find((r) => r.id === 'layout.views').limit).includes(String(RULES.views.max)));
	assert.ok(resolve(caps.rows.find((r) => r.id === 'api.rest_list').limit).includes(String(RULES.rows.engine_max)));
	// a bare number in a limit must not contradict the rules: no row may state a footer count or label length of its own
	for (const r of caps.rows) if (r.id !== 'actions.footer') assert.ok(!/footer buttons/i.test(r.limit) || /rules/.test(r.limit), r.id);
});

test('no row claims a sandbox or confinement', () => {
	const bad = /\b(sandboxed|confined)\b/i, strip = (x) => x.replace(/\bnot confined\b/gi, '');
	for (const r of caps.rows.filter((x) => x.status !== 'not supported')) assert.ok(!bad.test(strip(r.name + ' ' + r.limit)), r.id);
	assert.equal(caps.rows.find((r) => r.id === 'security.sandbox').status, 'not supported');
	assert.equal(caps.rows.find((r) => r.id === 'platform.windows').status, 'partial');
});

test('every example in index.json is named by at least one row', () => {
	const named = new Set(caps.rows.flatMap((r) => [r.example && path.basename(r.example), ...(r.also || [])]).filter(Boolean));
	for (const a of index.apps) assert.ok(named.has(a.id), `${a.id} is in index.json but in no capability row`);
});

test('CAPABILITIES.md is the rendering of capabilities.json', () => {
	assert.equal(fs.readFileSync(path.join(REPO, 'kit/examples/CAPABILITIES.md'), 'utf8'), render());
});

test('index.json: one "verified" wording, a need for every template, and edit lists that name files that exist', () => {
	for (const a of index.apps) {
		// one wording for an app nobody has dropped into Bolt; an app a maintainer drop test covered says what was seen, when, and that it is not the shipped 181 binary
		assert.ok(a.verified === 'not verified in real Bolt' || (/maintainer drop test/.test(a.verified) && /not run on the shipped 181 binary/.test(a.verified)), a.id);
		assert.ok(typeof a.need === 'string' && a.need.length > 10, `${a.id}: need`);
		assert.ok(Array.isArray(a.edit) && a.edit.length, `${a.id}: edit`);
		const dir = path.join(REPO, 'kit/examples', a.id);
		assert.ok(fs.existsSync(dir), `${a.id} is listed in index.json but its folder is missing`);
		for (const e of a.edit) assert.ok(fs.existsSync(path.join(dir, e)), `${a.id}: edit path ${e} does not exist`);
		for (const e of a.edit_in_script || []) assert.ok(fs.existsSync(path.join(dir, e.split(':')[0])), `${a.id}: ${e}`);
		assert.ok(a.edit.every((e) => !/[ (]/.test(e)), `${a.id}: edit holds plain paths only`);
	}
});

test('a row that names keys: the cited test file mentions each key, and the example config uses each example key', () => {
	let n = 0;
	for (const r of caps.rows) {
		for (const k of r.keys || []) { assert.ok(fs.readFileSync(path.join(REPO, r.test), 'utf8').includes(k), `${r.id}: ${r.test} never mentions "${k}"`); n++; }
		for (const k of r.example_keys || []) {
			assert.ok(r.example, `${r.id}: example_keys without an example`);
			const dir = path.join(REPO, r.example), files = [path.join(dir, 'scripts', `${path.basename(dir)}__config.json`), ...fs.readdirSync(path.join(dir, 'utilities')).map((f) => path.join(dir, 'utilities', f))].filter((f) => fs.existsSync(f));
			assert.ok(files.some((f) => fs.readFileSync(f, 'utf8').includes(k)), `${r.id}: ${r.example} never uses "${k}"`); n++;
		}
	}
	assert.ok(n >= 10, `only ${n} keys were checked`);
	for (const id of ['nav.id_field', 'actions.run', 'actions.icon', 'api.id_hydrate', 'api.date_tokens', 'api.object_keyed_lists']) assert.ok((caps.rows.find((r) => r.id === id).keys || []).length, `${id} must name the key its test exercises`);
});
