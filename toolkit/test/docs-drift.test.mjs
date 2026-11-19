// Run: node --test toolkit/test/docs-drift.test.mjs
// The docs, the toolkit, the engine and schema/bolt-rules.json must not contradict each other. Each test names the single source.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RULES } from '../lib/boltrules.mjs';
import { RIGHT_WIDGET_KINDS } from '../lib/assess.mjs';
import { FIXES } from '../lib/verify.mjs';
import { ASSESS_CODES } from '../lib/assess.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
const tracked = () => execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' }).split('\n').filter(Boolean);
const DOCS = tracked().filter((f) => f.endsWith('.md') && !f.startsWith('apps/') && !f.startsWith('.github/'));
const sorted = (a) => [...a].sort();

// ---------------------------------------------------------------- the quick path
const QS = read('kit/examples/QUICKSTART.md');
test('QUICKSTART.md stays small: a cold agent reads one short page', () => {
	const words = QS.split(/\s+/).filter(Boolean).length, lines = QS.split('\n').length;
	// Budget raised from 1500 words and 130 lines to 2000 and 150 when section 6 (what Bolt does with rows and runs) was added from the
	// launcher audit: authors hit those behaviours, and it is still one page.
	assert.ok(words <= 2700, `${words} words (budget 2700)`);   // 2000 plus the hero picture row and its 181 refusal row (Bolt 182), plus the notes that chip must equal id, the three start states, re-approval and code sharing on 181
	assert.ok(lines <= 150, `${lines} lines (budget 150)`);
	assert.ok((QS.match(/^\d+\. /gm) || []).length >= 10, 'ten hard rules');
});

test('the rules table in QUICKSTART.md equals schema/bolt-rules.json', () => {
	const row = (label) => { const m = QS.split('\n').find((l) => l.startsWith(`| ${label}`)); assert.ok(m, `row ${label}`); return m.split('|').map((c) => c.trim()); };
	const A = RULES.actions;
	assert.match(row('Entries in `presentation.views`')[2], new RegExp(`^${RULES.views.max} `));
	assert.match(row('Footer buttons')[2], new RegExp(`^${A.footer_max_bolt}$`)); assert.match(row('Footer buttons')[3], new RegExp(`^${A.footer_max_kit} `));
	assert.match(row('Footer label')[2], new RegExp(`${A.label_kept_bolt} kept, ${A.label_shown} shown`));
	assert.match(row('Rows in a list')[2], new RegExp(`^${RULES.rows.bolt_max}$`)); assert.match(row('Rows in a list')[3], new RegExp(`${RULES.rows.kit_schema_max} .*${RULES.rows.engine_max}`));
	assert.match(row('Script timeout')[2], new RegExp(`${RULES.timeouts.min_s} to ${RULES.timeouts.max_s} s, default ${RULES.timeouts.default_s}`));
	assert.deepEqual(sorted(row('Pane kinds with app data')[2].split(', ')), sorted(RULES.widget_kinds.filter((k) => !RULES.no_app_data_kinds.includes(k) && k !== 'map')));
	assert.deepEqual(sorted(row('Panes that cannot show app data')[2].split(' (')[0].split(', ')), sorted(RULES.no_app_data_kinds));
	assert.match(row('`map` pane')[2], /own map/);
	assert.deepEqual(row('Footer action kinds')[2].split(', '), A.kinds);
	assert.match(row('App file `schema_version`')[2], new RegExp(`^${RULES.schema_versions.join(' or ')} `));
	const env = row('Environment a script sees')[2];
	for (const n of RULES.runner_env.allowlisted_from_host) assert.ok(env.includes(n), `env row lacks ${n}`);
	for (const n of [...RULES.runner_env.ca_bundle, ...Object.keys(RULES.runner_env.fixed)]) assert.ok(env.includes(n), `env row lacks ${n}`);
	for (const p of RULES.runner_env.allowlisted_prefixes) assert.ok(env.includes(p + '*'), `env row lacks ${p}*`);
	for (const p of RULES.env.secret_name_parts) assert.ok(row('Environment a script sees')[3].includes(p), `secret part ${p}`);
	assert.match(row('Sandbox')[2], /not shipped/); assert.match(row('Sandbox')[2], /private working folder/);
	const cannot = row('What the kit cannot hide')[3];
	for (const w of ['Basic base64', 'HTML entities', 'colon-separated hex', 'split across lines', 'JSON number', 'URL-encoded twice']) assert.ok(cannot.includes(w), `redaction limit missing: ${w}`);
	const min = /^MIN_REDACT = (\d+)/m.exec(read('kit/python/bolt_app_kit/secrets.py'))[1];
	assert.ok(cannot.includes(`under ${min} characters`), 'MIN_REDACT in the table');
});

test('other docs link to the one rules table instead of stating limits of their own', () => {
	const limitWords = /\b(at most|up to|no more than)\s+(\d+)\s+(footer|views?|rows|buttons)\b|\b(\d+)\s+footer buttons\b|\b14 characters\b|\b40 characters\b/i;
	for (const f of DOCS.filter((d) => !/QUICKSTART|CAPABILITIES|CHANGELOG|^kit\/examples\/[a-z0-9-]+\/README/.test(d))) {
		read(f).split('\n').forEach((l, i) => assert.ok(!limitWords.test(l), `${f}:${i + 1} states a limit; link to kit/examples/QUICKSTART.md#4-the-rules-table instead: ${l.slice(0, 120)}`));
	}
});

// ---------------------------------------------------------------- widget kinds
test('pane kinds are identical across schema, toolkit, rules file and ENGINE.md', () => {
	const schema = JSON.parse(read('schema/user-app.schema.json')).$defs.presentation.properties.right_widget.properties.kind.enum;
	assert.deepEqual(sorted(schema), sorted(RIGHT_WIDGET_KINDS));
	assert.deepEqual(sorted(RULES.widget_kinds), sorted(RIGHT_WIDGET_KINDS));
	const line = read('kit/examples/ENGINE.md').split('\n').join(' ').match(/Pane kinds with app data: ([a-z_, ]+) \(/);
	assert.ok(line, 'ENGINE.md lists the pane kinds');
	assert.deepEqual(sorted(line[1].split(', ')), sorted(RULES.widget_kinds.filter((k) => !RULES.no_app_data_kinds.includes(k) && k !== 'map')));
});

// ---------------------------------------------------------------- engine config fields
test('every config field ENGINE.md documents exists in engine.py, and every field engine.py reads is documented', () => {
	const eng = read('kit/examples/portal-template/scripts/portal-template__engine.py');
	const E = new Set([...eng.matchAll(/\.get\("([a-z_]+)"/g), ...eng.matchAll(/\["([a-z_]+)"\]/g), ...eng.matchAll(/"([a-z_]+)" in /g)].map((m) => m[1]));
	const md = read('kit/examples/ENGINE.md');
	const region = (md.slice(md.indexOf('## Modes'), md.indexOf('## Files named in the command')) + md.slice(md.indexOf('## More options'), md.indexOf('## What backs your app'))).replace(/```[\s\S]*?```/g, '');
	const spans = [...region.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
	const pure = new Set(spans.filter((x) => /^[A-Za-z_]+$/.test(x))), anyWord = new Set(spans.flatMap((x) => x.match(/[A-Za-z_]+/g) || []));
	// a lone backticked word that is a value, a template filter, a mode or an example, not a config key
	const notFields = new Set(['setup', 'sample', '_lines', 'api_key', 'count', 'day', 'dots', 'header', 'hhmm', 'human', 'join', 'key', 'left', 'list_data', 'lower', 'query', 'right', 'round', 'thousands', 'true', 'unknown', 'upper', 'when', 'whenday', 'yes']);
	// keys the engine reads that are row fields it builds, not config
	const engineOnly = new Set(['back', 'kpi_badge', 'nav', 'bolt_app_kit', '__', 'layout', 'kpi_value', 'kpi_foot', 'kpi_note']);
	assert.deepEqual([...pure].filter((w) => !E.has(w) && !notFields.has(w)), [], 'documented as a field but engine.py never reads it');
	assert.deepEqual([...E].filter((w) => !anyWord.has(w) && !engineOnly.has(w)), [], 'engine.py reads it but ENGINE.md does not document it');
});

// ---------------------------------------------------------------- codes
const SRC = ['toolkit/bin/bolt-apps.mjs', ...fs.readdirSync(path.join(REPO, 'toolkit/lib')).map((f) => 'toolkit/lib/' + f)];
const universe = new Set(), emitted = new Set(Object.keys(FIXES));
for (const c of ASSESS_CODES) emitted.add(c);
for (const f of SRC) {
	const t = read(f);
	for (const m of t.matchAll(/'([a-z][a-z0-9]*(?:_[a-z0-9]+)+)'/g)) universe.add(m[1]);
	for (const re of [/\b[EW]\('([a-z][a-z0-9_]+)'/g, /add\('(?:error|warning)',\s*'([a-z][a-z0-9_]+)'/g, /\btop\('(?:error|warning)',\s*'([a-z][a-z0-9_]+)'/g, /code:\s*'([a-z][a-z0-9_]+)'/g]) for (const m of t.matchAll(re)) emitted.add(m[1]);
}
for (const c of emitted) universe.add(c);
// codes the unpublished checker inside Bolt emits; CHECKER.md says so and the toolkit does not
const BOLT_ONLY = new Set(['sensitive_secret', 'sensitive_email', 'sensitive_internal_url', 'test_failed', 'snippet_invalid', 'search_engine_invalid', 'user_app_invalid', 'listing_invalid', 'parse_error', 'load_error', 'signature_invalid', 'owned_by_other']);
const known = new Set([...universe, ...BOLT_ONLY]);
{
	const add = (o) => { if (Array.isArray(o)) o.forEach(add); else if (o && typeof o === 'object') Object.entries(o).forEach(([k, v]) => { known.add(k); add(v); }); else if (typeof o === 'string') known.add(o); };
	add(RULES.keys); add(RULES.actions.kinds); add(RULES.right_widget.modes); add(RULES.widget_kinds); add(JSON.parse(read('schema/install-rules.json')).contract);
	for (const n of ['bolt-app', 'user-app', 'boltpack-manifest', 'connector']) { const walk = (o) => { if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (k === 'properties' && v && typeof v === 'object') Object.keys(v).forEach((x) => known.add(x)); walk(v); } }; walk(JSON.parse(read(`schema/${n}.schema.json`))); }
	const py = tracked().filter((f) => /^kit\/python\/(bolt_app_kit|tests)\/.*\.py$|^kit\/examples\/(portal-template|script-template)\/scripts\/[a-z-]+\.py$/.test(f)).map(read).join('\n');
	for (const m of py.matchAll(/[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+/g)) known.add(m[0]);   // any identifier in the kit, the engine or their tests, so a name in a doc must at least exist there
	for (const m of read('kit/examples/portal-template/scripts/portal-template__engine.py').matchAll(/"([a-z_]+)"/g)) known.add(m[1]);
	for (const f of [...SRC, 'conformance/verify-cases.json', 'kit/conformance/cases.json', 'kit/examples/index.json', 'kit/examples/capabilities.json']) for (const m of read(f).matchAll(/[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+/g)) known.add(m[0]);
	for (const w of ['reads_clipboard', 'reads_launcher_input', 'copies_to_clipboard', 'runs_commands', 'agent_tools', 'opens_links', 'scripts_dir', 'bolt_app_kit', 'bolt_safenet']) known.add(w);
}
test('every code or identifier named in the docs exists in the toolkit, the engine, the kit or the rules file (or is marked Bolt-checker-only)', () => {
	for (const f of DOCS.filter((d) => /^(AGENTS|CHECKER|README|CONTRIBUTING)\.md$|^toolkit\/README|^docs\/|^kit\/README|^kit\/examples\/(ENGINE|QUICKSTART)/.test(d))) {
		for (const m of read(f).replace(/```[\s\S]*?```/g, '').matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)) assert.ok(known.has(m[1]), `${f} names \`${m[1]}\`, which is not in the toolkit, engine, kit or rules file`);
	}
});

test('CHECKER.md lists every code the toolkit emits, and says which codes are Bolt-checker-only', () => {
	const doc = read('CHECKER.md');
	const block = /<!-- codes:start -->([\s\S]*?)<!-- codes:end -->/.exec(doc);
	assert.ok(block, 'CHECKER.md has the codes block');
	const listed = new Set([...block[1].matchAll(/`([a-z0-9_]+)`/g)].map((m) => m[1]));
	assert.deepEqual(sorted([...emitted].filter((c) => !listed.has(c))), [], 'emitted but not in CHECKER.md');
	assert.deepEqual(sorted([...listed].filter((c) => !universe.has(c))), [], 'in CHECKER.md but not in the toolkit');
	assert.match(doc, /Bolt's own checker/);
});

// ---------------------------------------------------------------- claims
test('no unqualified sandbox, confinement or safety claim in any doc', () => {
	const claim = /sandbox|confine|\bsafe(ly)?\b|safest/i, ok = /\b(not|no|never|planned|proposal|not built|fail safe|yet|harbour|console code page|safe_copy|roadmap|natural place|run it only)\b/i;
	for (const f of DOCS) read(f).split('\n').forEach((l, i) => { if (claim.test(l)) assert.ok(ok.test(l), `${f}:${i + 1} ${l.slice(0, 140)}`); });
});

test('docs name the one command form, say Windows is unproven and never name a chart type that is not shipped', () => {
	assert.match(QS, /\.\/bolt-apps new /);
	assert.match(QS, /Windows is unproven/);
	for (const f of DOCS.filter((d) => !/CAPABILITIES|QUICKSTART|CHANGELOG/.test(d))) read(f).split('\n').forEach((l, i) => { if (/\b(pie|donut|heatmap|gauge)\b/i.test(l)) assert.match(l, /\b(not|cannot|never)\b/i, `${f}:${i + 1}`); });
});

// ---------------------------------------------------------------- runnable shell blocks
test('every shell block marked "sh run" runs in a fresh copy of the repo', { timeout: 280000 }, () => {
	const blocks = [];
	for (const f of DOCS) for (const m of read(f).matchAll(/```sh run\n([\s\S]*?)```/g)) blocks.push({ f, code: m[1] });
	assert.ok(blocks.length >= 1, 'at least the QUICKSTART block');
	for (const b of blocks) {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bolt-docs-run-')), copy = path.join(tmp, 'clone'), home = path.join(tmp, 'home');
		fs.mkdirSync(home);
		fs.mkdirSync(copy);
		for (const f of tracked()) { const to = path.join(copy, f); fs.mkdirSync(path.dirname(to), { recursive: true }); if (fs.existsSync(path.join(REPO, f))) fs.copyFileSync(path.join(REPO, f), to); }
		const r = spawnSync('sh', ['-ec', b.code], { cwd: copy, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8', timeout: 240000 });
		assert.equal(r.status, 0, `${b.f}: block failed\n${b.code}\n${r.stdout.slice(-800)}\n${r.stderr.slice(-800)}`);
		assert.ok(fs.readdirSync(path.join(home, '.bolt-apps', 'packs')).some((p) => p.endsWith('.boltpack')), 'the block ends with a .boltpack');
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test('QUICKSTART.md and CAPABILITIES.md hold no raw HTML outside code (the website injects them into a page)', () => {
	for (const f of ['kit/examples/QUICKSTART.md', 'kit/examples/CAPABILITIES.md']) {
		const bare = read(f).replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
		for (const [re, what] of [[/<\s*[A-Za-z!\/?]/, 'an HTML tag or comment'], [/\bon[a-z]+\s*=/i, 'an event handler'], [/(javascript|vbscript)\s*:|\]\(\s*data\s*:/i, 'a script-like URL'], [/&#?\w+;/, 'an HTML entity']]) assert.ok(!re.test(bare), `${f} holds ${what}`);
	}
});

test('no doc promises "no Reload" or a newer Remove behaviour without saying it is newer than 181', () => {
	const promise = /\b(no|without|never need(s)?( a)?|not need(ed)?) reload\b|reload (is )?not (needed|required)|appears? immediately|in-place confirm/i;
	for (const f of DOCS) read(f).split('\n').forEach((l, i) => { if (promise.test(l)) assert.match(l, /newer than 181|0\.1\.18[2-9]|not promised/i, `${f}:${i + 1} ${l.slice(0, 140)}`); });
});

test('every doc that tells a person to Remove an app carries the 181 qualification, or points at the Remove row that does', () => {
	const mention = /\b(click|press|use)\s+Remove\b|\bRemove (the|an|this) (installed )?(app|User App)\b|\bremove the (installed )?app\b|\bthe Remove button\b/i;
	const ok = /on the app's row in 181|see the Remove row|newer builds|tell us which Bolt version/i;
	for (const f of DOCS) read(f).split('\n').forEach((l, i) => { if (mention.test(l)) assert.match(l, ok, `${f}:${i + 1} ${l.slice(0, 140)}`); });
	const row = read('kit/examples/QUICKSTART.md').split('\n').find((l) => l.startsWith('| Remove |'));
	for (const w of ["on the app's row in 181", 'not yet seen on a running 181', 'next to Revoke approval', 'Do not delete files by hand', 'owned_by_other', "its scripts and install record", 'tell us which Bolt version']) assert.ok(row.includes(w), `Remove row lacks: ${w}`);
});

test('no doc says 181 cannot do per-row panes or one-Enter drilling; the rules say how (selected_row views, nav)', () => {
	const wrong = /(cannot|can't|does not|doesn't|no) (do |draw |show |support )?(list[- ]view )?(per-row|row) panes?|(cannot|can't|does not|doesn't) (do )?(one-Enter|drill)/i;
	for (const f of DOCS) read(f).split('\n').forEach((l, i) => assert.ok(!wrong.test(l), `${f}:${i + 1} ${l.slice(0, 140)}`));
	const qs = read('kit/examples/QUICKSTART.md');
	assert.match(qs, /Drill with `nav` \(one Enter\)/); assert.match(qs, /only pre-fills the next command/); assert.match(qs, /same app written in the app file runs directly/);
	assert.match(qs, /mode `selected_row` and kind entity_preview, detail, markdown, json_tree, chart, table or card/);
	assert.match(qs, /ignored for mode `list_data`, a view with no right pane, or kind diff, cards or image_grid/);
});
