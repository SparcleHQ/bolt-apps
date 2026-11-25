// Run: node --test toolkit/test/docs-gate.test.mjs
// The docs gate. Every widget kind and bind key that schema/bolt-rules.json marks `since` 0.1.184 or later must have
//   1. a row in kit/examples/CAPABILITIES.md or capabilities.json,
//   2. a reference in an example under kit/examples/ (a `"key":` or `key:` line, or a `"kind": "<kind>"` pane), and
//   3. a mention in kit/examples/QUICKSTART.md.
// A gap fails this test, so a widget cannot merge without its docs. Older keys (0.1.183 and earlier, or no `since`) are
// not gated: their gaps are counted and listed in the test output as a warning, never as a failure.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { caps } from '../../scripts/build-capabilities.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
export const GATE_FROM = '0.1.184';
const vnum = (v) => String(v).split('.').map((n) => parseInt(n, 10) || 0);
const atLeast = (v, min) => { const a = vnum(v), b = vnum(min); for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0); } return true; };
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Every thing the rules name: a widget kind (kind_since or widget_kinds) or a key under right_widget.bind. Returns [{ id, name, since, kind }].
export function collect(rules) {
	const out = [];
	const walk = (o, p) => {
		if (Array.isArray(o)) return;
		if (!o || typeof o !== 'object') return;
		if (typeof o.since === 'string' && p.length) out.push({ id: p.join('.'), name: p[p.length - 1], since: o.since, kind: false });
		for (const [k, v] of Object.entries(o)) { if (k !== 'kind_since') walk(v, [...p, k]); }
	};
	walk(rules.right_widget || {}, ['right_widget']);
	for (const [k, v] of Object.entries(rules.kind_since || {})) out.push({ id: `kind.${k}`, name: k, since: v, kind: true });
	for (const k of rules.widget_kinds || []) if (!(rules.kind_since || {})[k]) out.push({ id: `kind.${k}`, name: k, since: null, kind: true });
	return out;
}

// What the docs and examples say. Pass real text, or fakes in the self-test.
export function gaps(items, docs) {
	const res = [];
	for (const it of items) {
		const w = new RegExp(`(^|[^A-Za-z0-9_])${esc(it.name)}($|[^A-Za-z0-9_])`);
		const exRe = it.kind ? new RegExp(`["']kind["']?\\s*:\\s*["']${esc(it.name)}["']`) : new RegExp(`["']?${esc(it.name)}["']?\\s*:`);
		const miss = [];
		if (!w.test(docs.capabilities)) miss.push('CAPABILITIES row');
		// A key whose capability row says sample_due (the list contract-evolution.test.mjs pins) is excused the example only; every other check still applies.
		const due = (docs.dueSnippets || []).some((t) => new RegExp(`["']${esc(it.name)}["']\\s*:`).test(t));
		if (!due && !docs.examples.some((t) => exRe.test(t))) miss.push('example reference');
		if (!w.test(docs.quickstart)) miss.push('QUICKSTART mention');
		if (miss.length) res.push({ ...it, miss });
	}
	return res;
}

const exampleFiles = () => execFileSync('git', ['ls-files', 'kit/examples'], { cwd: REPO, encoding: 'utf8' }).split('\n')
	.filter((f) => /\.(json|ya?ml|py)$/.test(f) && !f.endsWith('capabilities.json') && !f.endsWith('index.json'));
const realDocs = () => ({
	capabilities: read('kit/examples/CAPABILITIES.md') + '\n' + read('kit/examples/capabilities.json'),
	quickstart: read('kit/examples/QUICKSTART.md'),
	examples: exampleFiles().map(read),
	dueSnippets: caps.rows.filter((r) => r.sample_due).map((r) => r.snippet || ''),
});
const rulesFile = () => JSON.parse(fs.readFileSync(process.env.BOLT_RULES_FILE || path.join(REPO, 'schema/bolt-rules.json'), 'utf8'));

test(`docs gate: every kind and key since ${GATE_FROM} has a CAPABILITIES row, an example and a QUICKSTART mention`, () => {
	const items = collect(rulesFile());
	const all = gaps(items, realDocs());
	const gated = all.filter((g) => g.since && atLeast(g.since, GATE_FROM));
	const legacy = all.filter((g) => !(g.since && atLeast(g.since, GATE_FROM)));
	// Warning list, not a failure: older gaps. Written to the test output so the count is visible and can only be worked down.
	console.log(`docs-gate warning: ${legacy.length} older kinds or keys (since before ${GATE_FROM}, or no since) have a docs gap out of ${items.length} checked. Not gated.`);
	for (const g of legacy) console.log(`  warn ${g.id} (${g.since || 'no since'}): missing ${g.miss.join(', ')}`);
	assert.deepEqual(gated.map((g) => `${g.id} (since ${g.since}): missing ${g.miss.join(', ')}`), [], `a 0.1.184 or later kind or key has no docs; add a CAPABILITIES row, an example and a QUICKSTART mention`);
});

test('docs gate self-test: a new key with no docs is caught, a documented one is not', () => {
	const rules = { right_widget: { bind: { cards: { zzgate: { since: '0.1.185' }, old_one: { since: '0.1.180' } } } }, kind_since: { qqkind: '0.1.185' }, widget_kinds: [] };
	const items = collect(rules);
	assert.equal(items.length, 3);
	const bare = { capabilities: '', quickstart: '', examples: [] };
	assert.equal(gaps(items, bare).length, 3);
	const full = { capabilities: 'zzgate old_one qqkind', quickstart: 'zzgate old_one qqkind', examples: ['{"zzgate": 1, "old_one": 2, "kind": "qqkind"}'] };
	assert.equal(gaps(items, full).length, 0);
	const noExample = { ...full, examples: [] };
	assert.deepEqual(gaps(items, noExample).map((g) => g.miss), [['example reference'], ['example reference'], ['example reference']]);
	assert.ok(atLeast('0.1.184', GATE_FROM) && atLeast('0.1.190', GATE_FROM) && atLeast('0.2.0', GATE_FROM) && !atLeast('0.1.183', GATE_FROM));
});

test('docs gate: sample_due excuses only the example, and only for a key its row snippet names', () => {
	const item = { id: 'right_widget.bind.cards.visual', name: 'visual', since: '0.1.184', kind: false };
	const base = { capabilities: 'visual', quickstart: 'visual', examples: [] };
	assert.deepEqual(gaps([item], base).map((g) => g.miss), [['example reference']]);
	assert.deepEqual(gaps([item], { ...base, dueSnippets: ['"bind": {"visual": "bullet"}'] }), []);
	assert.deepEqual(gaps([item], { ...base, capabilities: '', dueSnippets: ['"visual": "x"'] }).map((g) => g.miss), [['CAPABILITIES row']]);
	assert.equal(gaps([item], { ...base, dueSnippets: ['"other": 1'] }).length, 1);
});
