#!/usr/bin/env node
// bolt-apps: the Bolt Apps author toolkit. Zero dependencies, Node 18 or newer.
//   new <id> [--type snippet|search|transform|recognizer]   start an app from a working template
//   lint [path]                                             offline shape checks (not the full checker)
//   keygen [--out file]                                     make your signing key
//   pack <app-folder> [--key file] [--out file] [--personal]  build and self-sign a .boltpack
//   verify <app-folder | file.boltpack> [--json]            the checks Bolt runs at install, offline, with the fix for each problem
// The pack layout and hash are Bolt's own (bolt-manifest-verify). Bolt checks every pack again at install.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { checkManifests, confirmPreview, checkPackShape, FIXES } from '../lib/verify.mjs';
import { get, str, notYamlHint } from '../lib/yamlsubset.mjs';
import { assessYaml, plainPermission, listingPermissions, plainName, dataFilesUsed, escapeProblem, ASSESS_CODES, MAX_HASHED_FILE_BYTES } from '../lib/assess.mjs';
import { iconProblem, chipMismatch } from '../lib/assess.mjs';
import { versionProblem, layoutProblems, namespaceProblems } from '../lib/boltrules.mjs';
import { newList, newFromTemplate, listTemplates, hasTemplate, runApp, ship, doctor, staleCloneNote } from '../lib/workflow.mjs';
import { exportShared } from '../lib/shared.mjs';
import { checkApp, formatReport, reportOk, platformFindings, vendorKit, OSES } from '../lib/check.mjs';

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/, KEY = /^[a-z][a-z0-9_-]{0,23}$/, PREFIX = /^[a-z][a-z0-9]{0,11}$/;
const PERMS = ['reads_clipboard', 'reads_launcher_input', 'copies_to_clipboard', 'runs_commands', 'network', 'files', 'agent_tools'];
const DEFAULT_KEY = path.join(os.homedir(), '.bolt-apps', 'key.pem');
const die = (m, code = 2) => { console.error(`bolt-apps: ${m}`); process.exit(code); };
const rd = (f) => fs.readFileSync(f, 'utf8');
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

// ---------- lint ----------
// opts.personal: the app is for its author's own use (tier 3 and script apps allowed). The gallery rules are the default.
export function lintApp(dir, opts = {}) {
	const personal = opts.personal === true;
	const out = [], add = (level, code, message, p) => out.push({ level, code, message, path: p });
	const E = (c, m, p) => add('error', c, m, p), W = (c, m, p) => add('warning', c, m, p);
	const id = path.basename(path.resolve(dir));
	let app;
	try { app = JSON.parse(rd(path.join(dir, 'bolt-app.json'))); } catch (e) { E('listing_unreadable', `bolt-app.json is missing or not JSON: ${e.message}`, 'bolt-app.json'); return { id, out, app: null, files: {} }; }
	if (!isObj(app)) { E('listing_unreadable', 'bolt-app.json must be a JSON object', 'bolt-app.json'); return { id, out, app: null, files: {} }; }
	if (app.schema_version !== 1) E('schema_version', 'schema_version must be 1', 'bolt-app.json');
	if (app.id !== id || !ID.test(String(app.id))) E('id_mismatch', `id must match ${ID} and equal the folder name "${id}"`, 'bolt-app.json');
	for (const k of ['title', 'role', 'saves']) if (typeof app[k] !== 'string' || !app[k].trim()) E('field_missing', `${k} is required`, 'bolt-app.json');
	{ const todo = ['summary', 'role', 'saves'].filter((k) => typeof app[k] === 'string' && /\bTODO\b/.test(app[k])); if (todo.length) W('listing_todo', `${todo.join(', ')} in bolt-app.json still say TODO (./bolt-apps new leaves them for you). Write one real line each before you share the pack`, 'bolt-app.json'); }
	// The description is SHIPPED (utilities/<id>.yaml, shown in the launcher): a TODO there reaches the people who install the pack. A warning, not an error: the pack still builds.
	{ const where = []; try { for (const y of fs.existsSync(path.join(dir, 'utilities')) ? fs.readdirSync(path.join(dir, 'utilities')).filter((f) => /\.ya?ml$/.test(f)) : []) if (/^description:\s*["']?TODO\b/m.test(rd(path.join(dir, 'utilities', y)))) where.push(`utilities/${y}`); } catch { /* unreadable: other checks say so */ }
	  try { const sd = path.join(dir, 'scripts'); for (const c of fs.existsSync(sd) ? fs.readdirSync(sd).filter((f) => f.endsWith('__config.json')) : []) { const j = JSON.parse(rd(path.join(sd, c))); if (j && j.app && typeof j.app.description === 'string' && /^TODO\b/.test(j.app.description)) where.push(`scripts/${c}`); } } catch { /* not an engine config */ }
	  if (where.length) W('description_todo', `your app description still says TODO (${where.join(', ')}). It is shipped in the pack and shown in the launcher: write one line about what the app shows in the config's app.description and regenerate the app file`, where[0]); }
	if (!app.author || typeof app.author.name !== 'string' || !app.author.name.trim()) E('field_missing', 'author.name is required', 'bolt-app.json');
	if (app.author?.link && !String(app.author.link).startsWith('https://')) E('author_link', 'author.link must start with https://', 'bolt-app.json');
	// files
	const files = { snippets: [], search_engines: [], utilities: [] }, scripts = [], assessed = [], sizes = {};
	if (personal) files.scripts = scripts;
	for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
		if (ent.isFile() && (ent.name === 'bolt-app.json' || ent.name === 'README.md' || ent.name.endsWith('.boltpack'))) continue; // a pack built here earlier is never packed
		if (personal && ((ent.isFile() && (ent.name === 'check.json' || ent.name === 'bolt_app_kit.lock.json')) || (ent.isDirectory() && (ent.name === 'fixtures' || ent.name === 'golden')))) continue; // author-side only, never packed
		if (personal && ent.isDirectory() && ent.name === 'scripts') {
			// What the launcher refuses is a link, an odd name, a case clash, a file that is also a folder, or a script another app already owns: every file here must be named <app id>__<name>.
			const walk = (rel) => {
				for (const f of fs.readdirSync(path.join(dir, 'scripts', rel), { withFileTypes: true })) {
					if (f.name.startsWith('.') || f.name === '__pycache__') continue; // editor and OS leftovers are never packed
					const r = rel ? `${rel}/${f.name}` : f.name;
					if (f.isSymbolicLink()) E('script_symlink', `scripts/${r} is a symlink. Bolt refuses a script that is a link ("is a link, not a file"), and a pack cannot carry one. Copy the real file in`, `scripts/${r}`);
					else if (f.isDirectory()) walk(r);
					else if (!f.isFile()) E('script_not_plain', `scripts/${r} is not a plain file (a folder-like, device or pipe entry). Bolt refuses it ("is not a plain file")`, `scripts/${r}`);
					else if (`manifests/scripts/${r}`.length > 100) E('app_file_name', `the name is too long: <app id>__<name> is ${r.split('/').pop().length} characters. Bolt accepts up to 128 characters per name (ids are up to 64, and every file starts with <app id>__, which counts), and this toolkit can pack at most 82 for a script name (a pack path manifests/scripts/<name> may be 100 characters). Shorten the file name or the app id`, `scripts/${r}`);
					else if (!r.split('/').every(plainName)) E('script_name', r.split('/').some((s) => s.length > 128) ? `the name is ${r.length} characters; Bolt allows at most 128 per name, and every file starts with <app id>__ (up to 64 characters), which counts. Shorten the file name or the app id` : 'a script name may use only letters, digits, . _ and -, and may not start or end with a dot (Bolt refuses the whole pack otherwise)', `scripts/${r}`);
					else { scripts.push(r); try { sizes[r] = fs.statSync(path.join(dir, 'scripts', r)).size; } catch { /* listed above */ } }
				}
			};
			walk('');
			for (const lp of layoutProblems(scripts)) E(lp.code, lp.message, 'scripts');
			for (const np of namespaceProblems(scripts, app.id)) E(np.code, np.message, `scripts/${np.file}`);
			continue;
		}
		if (ent.isDirectory() && Object.hasOwn(files, ent.name)) {
			for (const f of fs.readdirSync(path.join(dir, ent.name))) {
				const okExt = ent.name === 'utilities' ? /\.ya?ml$/.test(f) : f.endsWith('.json');
				if (okExt) files[ent.name].push(f); else E('unknown_file', 'not an allowed file here', `${ent.name}/${f}`);
			}
		} else E('unknown_file', 'only bolt-app.json, README.md, snippets/, search_engines/ and utilities/ are allowed', ent.name);
	}
	const targets = new Set(), perms = new Set(); let tier = 0;
	const need = (...p) => p.forEach((x) => perms.add(x));
	for (const f of files.snippets) {
		const p = `snippets/${f}`; tier = Math.max(tier, 1);
		let s; try { s = JSON.parse(rd(path.join(dir, p))); } catch (e) { E('bad_json', e.message, p); continue; }
		if (!isObj(s)) { E('bad_json', 'must be a JSON object', p); continue; }
		if (!KEY.test(s.key || '')) E('snippet_key', `key must match ${KEY}`, p);
		if (!s.label) E('field_missing', 'label is required', p);
		if (typeof s.content !== 'string' || !s.content || s.content.length > 10000) E('snippet_content', 'content must be 1 to 10,000 characters', p);
		else if (/\{clipboard[|}]/.test(s.content)) need('reads_clipboard');
		need('copies_to_clipboard'); targets.add(`snippet:${s.key}`);
	}
	for (const f of files.search_engines) {
		const p = `search_engines/${f}`; tier = Math.max(tier, 1);
		let s; try { s = JSON.parse(rd(path.join(dir, p))); } catch (e) { E('bad_json', e.message, p); continue; }
		if (!isObj(s)) { E('bad_json', 'must be a JSON object', p); continue; }
		if (!PREFIX.test(s.id || '')) E('search_prefix', `id (the prefix) must match ${PREFIX}`, p);
		if (!s.name) E('field_missing', 'name is required', p);
		const u = String(s.urlTemplate || '');
		if (!u.startsWith('https://')) E('search_url', 'urlTemplate must start with https://', p);
		else { if (u.split('{q}').length > 2) E('search_url', 'at most one {q}', p); try { need(`opens_links:${new URL(u.replace('{q}', 'x')).hostname}`); } catch { E('search_url', 'urlTemplate is not a URL', p); } }
		targets.add(`search:${s.id}`);
	}
	for (const f of files.utilities) {
		const p = `utilities/${f}`; const y = rd(path.join(dir, p));
		const esc_ = personal ? escapeProblem(y) : null; if (esc_) E(esc_.code, esc_.message, p);
		{ const ia = assessYaml(y, undefined, {}); const ic = ia.tree ? str(get(ia.tree, 'icon')?.value) : undefined; const ip = ic && iconProblem(ic); if (ip) W('icon_unknown', `${p}: ${ip} (a warning here: the launcher still shows the app; an icon in scripts/config.json is an error because the kit refuses it)`, p); }
		const a = assessYaml(y, undefined, { platforms: app.platforms, pack: personal, minBolt: app.min_bolt_version, minBoltKnown: true }), rt = a.runtime, yid = a.unknown || !a.tree ? undefined : (str(get(a.tree, 'id')?.value) || '').trim() || undefined;
		if (a.unknown) { tier = 3; E('yaml_unreadable_here', `this tool cannot interpret ${a.why}, so it cannot tell what the app can do; Bolt may read it differently. Write plain YAML in the supported subset (see AGENTS.md section 2). ${notYamlHint(y)}`.trim(), p); if (personal) assessed.push(a); continue; }
		if (personal) {
			if (`manifests/utilities/${f}`.length > 100) E('app_file_name', 'the name is too long for a pack (manifests/utilities/<name> must be at most 100 bytes)', p);
			if (!plainName(f)) E('app_file_name', 'a file name may use only letters, digits, . _ and -, and may not start or end with a dot (Bolt refuses the whole pack otherwise)', p);
			assessed.push(a);
			{ const cm = chipMismatch(a.tree); if (cm) W('description_chip_mismatch', `the description or placeholder says to type ${cm.wrong.join(', ')}, but this app's chip is =${cm.chip}. A copied template keeps its old words`, p); }
			if (a.runtime === undefined) E('field_missing', 'runtime is required', p);
			for (const pr of a.problems) add(pr.level || 'error', pr.code, pr.message, p);
			{ const cch = a.tree ? (str(get(a.tree, 'chip')?.value) || '').trim() : ''; if (yid && cch && /^[a-z0-9][a-z0-9-]{0,63}$/.test(cch) && /^[a-z0-9][a-z0-9-]{0,63}$/.test(yid) && cch !== yid) E('chip_not_id', `chip "${cch}" is not the id "${yid}". Bolt only runs an app whose chip equals its id (the launcher looks apps up by id): set chip to ${yid}`, p); }
			if (!yid) E('field_missing', 'id is required', p);
			tier = Math.max(tier, a.tier); for (const x of a.permissions) perms.add(x);
			continue;
		}
		if (rt === undefined) { E('field_missing', 'runtime is required', p); continue; }
		if (rt !== 'transform') { tier = 3; E('tier3_not_accepted', `runtime "${rt}" runs commands or the network; only runtime: transform is allowed here`, p); continue; }
		if (a.tier >= 3 || a.permissions.includes('runs_own_command_on_press')) { tier = 3; E('tier3_not_accepted', `${a.reasons[0] || (a.tier < 3 ? 'it has a button that runs a command (Bolt rates it tier 2, the gallery does not take it)' : 'it can act outside Bolt')}; only apps that act inside Bolt (no detect block, fixed https links) are allowed here`, p); continue; }
		tier = Math.max(tier, 2); need(...a.permissions.filter((x) => PERMS.includes(x) || x.startsWith('opens_links:')));
		if (!yid) E('field_missing', 'id is required', p); else targets.add(`transform:${yid}`), targets.add(`recognizer:${yid}`);
	}
	const cfgRel = personal ? ['config.json', `${app.id}__config.json`].find((n) => fs.existsSync(path.join(dir, 'scripts', n))) : undefined;
	if (cfgRel) {   // a kit app keeps its row icons in scripts/<app id>__config.json
		try { const walk = (o, at) => { if (Array.isArray(o)) o.forEach((v, i) => walk(v, `${at}[${i}]`)); else if (isObj(o)) for (const [k, v] of Object.entries(o)) { if (k === 'icon' && typeof v === 'string') { const ip = iconProblem(v); if (ip) E('icon_unknown', `scripts/${cfgRel} ${at ? at + '.' : ''}icon: ${ip}`, `scripts/${cfgRel}`); } walk(v, at ? `${at}.${k}` : k); } }; walk(JSON.parse(rd(path.join(dir, 'scripts', cfgRel))), ''); } catch { /* an unreadable config.json is the script's own error */ }
	}
	if (personal && files.utilities.length > 1) {
		// A copy that regenerates utilities/<new>.yaml but leaves the old file behind would pack two apps. If one file already carries this app's id,
		// any other file with a different id is the leftover.
		const ids = files.utilities.map((f) => { const a = assessYaml(rd(path.join(dir, `utilities/${f}`)), undefined, {}); return [f, a.unknown || !a.tree ? undefined : (str(get(a.tree, 'id')?.value) || '').trim() || undefined]; });
		if (ids.some(([, i]) => i === app.id)) for (const [f, i] of ids) if (i && i !== app.id) E('utilities_stale_copy', `utilities/${f} has the id "${i}", but this app is "${app.id}" and another file here already has that id. A copy left the old app file behind, and the pack would carry two apps. Delete utilities/${f}`, `utilities/${f}`);
	}
	if (personal && scripts.length) { tier = 3; perms.add('runs_commands'); }
	if (personal) {
		const have = new Set(scripts);
		for (const a of assessed) for (const r of a.refs) if (!have.has(r)) E('script_missing', `${a.id} runs scripts/${r} but the app has no such file. Bolt would install the app and it would fail when run`, 'utilities');
		const used = new Set(assessed.flatMap((a) => [...a.refs]));
		const usedAll = dataFilesUsed(used, scripts, (n) => fs.readFileSync(path.join(dir, 'scripts', n), 'utf8'));
		// The launcher: a script over 2 MB cannot be hashed, so Bolt calls it "too large to check" and will not run an app that names it
		for (const sc of scripts) if (sizes[sc] > MAX_HASHED_FILE_BYTES) (used.has(sc) ? E : W)('script_too_large', `scripts/${sc} is ${(sizes[sc] / 1048576).toFixed(1)} MB; Bolt hashes a script only up to 2 MB and refuses to run an app that names a larger one`, `scripts/${sc}`);
		for (const sc of scripts) if (!usedAll.has(sc)) W('script_unused', `scripts/${sc} is not named by {{scripts_dir}}/${sc} in any app file`, `scripts/${sc}`);
	}
	if (!tier || (personal && !files.utilities.length && !files.snippets.length && !files.search_engines.length)) E('empty_app', 'the app holds no snippet, search engine or User App', '.');
	if (personal) { if (app.tier !== tier) W('tier_recomputed', `bolt-app.json says tier ${app.tier}; the content is tier ${tier}. The pack carries tier ${tier}`, 'bolt-app.json'); }
	else if (!Number.isInteger(app.tier) || app.tier < 1 || app.tier > 3) E('field_missing', 'tier must be 1, 2 or 3', 'bolt-app.json');
	else if (app.tier < tier) E('tier_understated', `declares tier ${app.tier} but the content needs tier ${tier}`, 'bolt-app.json');
	for (const x of platformFindings(app)) out.push(x);
	if (!Array.isArray(app.permissions)) E('field_missing', 'permissions must be an array', 'bolt-app.json');
	const declared = new Set((Array.isArray(app.permissions) ? app.permissions : []).filter((x) => typeof x === 'string'));
	for (const x of declared) if (!PERMS.includes(x) && !/^opens_links:[a-z0-9.:-]+$/.test(x)) E('permission_unknown', `unknown permission "${x}"`, 'bolt-app.json');
	if (!personal) for (const x of perms) if (!declared.has(x)) E('permission_undeclared', `content needs "${x}" but bolt-app.json does not declare it`, 'bolt-app.json');
	if (personal) {
		// The install prompt and `verify` show the permissions computed from the app files; bolt-app.json permissions is listing text only.
		const comp = new Set(listingPermissions(perms).filter((x) => PERMS.includes(x) || /^opens_links:/.test(x)));
		const missing = [...comp].filter((x) => !declared.has(x)), ignored = [...declared].filter((x) => !comp.has(x));
		if (missing.length) W('permissions_differ', `bolt-app.json permissions and the permissions computed from the app files disagree${missing.length ? `; computed but not declared: ${missing.join(', ')}` : ''}${ignored.length ? `; declared but not computed: ${ignored.join(', ')} (verify and the install prompt never show these and nothing checks them: keep one only if it is true of the app, for example network for a script that makes web requests)` : ''}. The computed list wins for what verify and the install prompt show; bolt-app.json is listing text`, 'bolt-app.json');
	}
	for (const x of declared) if (!perms.has(x) && PERMS.includes(x) && tier < 3 && !personal) W('permission_unused', `"${x}" is declared but nothing uses it`, 'bolt-app.json');
	// tests
	const tests = (Array.isArray(app.tests) ? app.tests : []).filter(isObj);
	if (!tests.length && !personal) E('no_tests', 'every content file needs at least one test in bolt-app.json', 'bolt-app.json');
	const covered = new Set();
	for (const t of tests) {
		covered.add(`${t.kind}:${t.target}`);
		if (t.kind === 'recognizer' && !(Array.isArray(t.negative) && t.negative.length)) E('recognizer_no_negative', 'a recognizer test needs at least one negative sample', 'bolt-app.json');
		if (!['snippet', 'search', 'transform', 'recognizer'].includes(t.kind)) E('test_kind', `unknown test kind "${t.kind}"`, 'bolt-app.json');
	}
	if (!personal) for (const t of targets) if (!covered.has(t)) { const [k, n] = t.split(':'); if (k === 'snippet' || k === 'search' || ![...covered].some((c) => /^(transform|recognizer):/.test(c) && c.endsWith(`:${n}`))) { if (k !== 'recognizer') E('no_test_for', `no ${k} test targets "${n}"`, 'bolt-app.json'); } }
	return { id, out, app, files, tier, perms: [...perms], assessed };
}
function appDirs(target) {
	if (fs.existsSync(path.join(target, 'bolt-app.json'))) return [target];
	const root = fs.existsSync(path.join(target, 'apps')) ? path.join(target, 'apps') : target;
	return fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(root, e.name, 'bolt-app.json'))).map((e) => path.join(root, e.name));
}
function cmdLint(args) {
	const json = args.includes('--json'), personal = args.includes('--personal'), target = args.find((a) => !a.startsWith('--')) || '.';
	if (!fs.existsSync(target)) die(`no such folder: ${target}`);
	const dirs = appDirs(target); if (!dirs.length) die(`no Bolt Apps under ${target} (an app folder has a bolt-app.json)`);
	let bad = 0; const reports = [];
	for (const d of dirs) {
		const r = lintApp(d, { personal }), errs = r.out.filter((x) => x.level === 'error'); if (errs.length) bad++;
		reports.push({ app: r.id, ok: !errs.length, findings: r.out.map((x) => ({ ...x, file: x.path, fix: FIXES[x.code] || x.message })) });   // file and fix as verify --json has them; path stays
		if (!json) { console.log(`${errs.length ? 'FAIL' : 'ok  '} ${r.id}`); for (const f of r.out) console.log(`     ${f.level} ${f.code}: ${f.message} (${f.path})`); }
	}
	if (json) console.log(JSON.stringify({ ok: !bad, reports }, null, 2));
	else console.log(`\n${dirs.length - bad} of ${dirs.length} passed offline shape checks. This is not the full check: tests are not run. Bolt runs them when you add the app.`);
	process.exit(bad ? 1 : 0);
}

// ---------- new ----------
const TEMPLATES = {
	snippet: (id) => { const key = keyOf(id); return { tier: 1, perms: ['copies_to_clipboard'], summary: `Type ;${key}, fill in a name, get a greeting. Replace this with your text.`, files: { [`snippets/${key}.json`]: { key, label: id, content: 'Hello {input:Name=world}' } }, tests: [{ kind: 'snippet', name: 'fills the name', target: key, fields: { Name: 'Bolt' }, expect: 'Hello Bolt' }] }; },
	search: (id) => { const p = prefixOf(id); return { tier: 1, perms: ['opens_links:example.com'], summary: `Type ${p} and a query to search example.com. Replace the site.`, files: { [`search_engines/${p}.json`]: { id: p, name: id, urlTemplate: 'https://example.com/search?q={q}' } }, tests: [{ kind: 'search', name: 'builds the link', target: p, query: 'hello', expect: 'https://example.com/search?q=hello' }] }; },
	transform: (id) => ({ tier: 2, perms: ['copies_to_clipboard', 'reads_launcher_input'], summary: `Type =${id}, paste text, get it upper-cased. Replace the pipe steps.`, files: { [`utilities/${id}.yaml`]: `schema_version: 1\nruntime: transform\nid: "${id}"\nchip: "${id}"\ntitle: "${id}"\nicon: wand\ndescription: Trim and upper-case what you paste\nemits: Generic\n\npresentation:\n  widget: detail\n\ntransform:\n  pipe:\n    - trim\n    - upper\n` }, tests: [{ kind: 'transform', name: 'trims and upper-cases', target: id, input: '  hello  ', expect: 'HELLO' }] }),
	recognizer: (id) => ({ tier: 2, perms: ['copies_to_clipboard', 'reads_launcher_input'], summary: 'Paste a ticket key like TKT-123 and get its link. Replace the pattern and links.', files: { [`utilities/${id}.yaml`]: `schema_version: 1\nruntime: transform\nid: "${id}"\nchip: "${id}"\ntitle: "${id}"\nicon: link\ndescription: Recognize a ticket key and copy its link\nemits: Generic\nplaceholder_examples:\n  - "TKT-123"\n\npresentation:\n  widget: detail\n\ntransform:\n  pipe:\n    - trim\n    - upper\n\nrecognize:\n  patterns:\n    - regex: "(TKT-\\\\d{1,6})"\n  reps:\n    - label: Link\n      template: "https://example.com/tickets/{1}"\n` }, tests: [{ kind: 'recognizer', name: 'recognizes ticket keys and nothing else', target: id, positive: ['TKT-123'], negative: ['TKT', 'TKT-', 'see TKT-123 here'], expect_rep: [{ input: 'TKT-123', label: 'Link', value: 'https://example.com/tickets/TKT-123' }] }] }),
};
const keyOf = (id) => { let k = id.replace(/[^a-z0-9_-]/g, '').slice(0, 24); return /^[a-z]/.test(k) ? k : `a${k}`.slice(0, 24); };
const prefixOf = (id) => { let k = id.replace(/[^a-z0-9]/g, '').slice(0, 12); return /^[a-z]/.test(k) ? k : `a${k}`.slice(0, 12); };
function flag(args, name, dflt) { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; }
function cmdNew(args) {
	staleCloneNote();
	if (args[0] === '--list' || args[0] === 'list') return newList();
	if (args.length >= 2 && !args[0].startsWith('--') && !args[1].startsWith('--') && hasTemplate(args[0])) return newFromTemplate(args[0], args[1], flag(args, '--dir', '.'));
	const id = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--type' && args[args.indexOf(a) - 1] !== '--dir' && args[args.indexOf(a) - 1] !== '--author');
	const type = flag(args, '--type', 'snippet'), root = flag(args, '--dir', 'apps'), author = flag(args, '--author', os.userInfo().username);
	if (!id || !ID.test(id)) die(`usage: ./bolt-apps new <id> [--type ${Object.keys(TEMPLATES).join('|')}] [--dir apps] [--author "Your name"]\n  id: lowercase letters, digits and hyphens`);
	if (!TEMPLATES[type]) die(`unknown --type "${type}". Types: ${Object.keys(TEMPLATES).join(', ')}`);
	const dir = path.join(root, id); if (fs.existsSync(dir)) die(`${dir} already exists`);
	const t = TEMPLATES[type](id);
	for (const [f, c] of Object.entries(t.files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), typeof c === 'string' ? c : JSON.stringify(c, null, 2) + '\n'); }
	const listing = { schema_version: 1, id, title: id, role: 'Who this is for. Replace me.', saves: 'What it saves them. Replace me.', summary: t.summary, author: { name: author }, tier: t.tier, permissions: t.perms, tests: t.tests };
	fs.writeFileSync(path.join(dir, 'bolt-app.json'), JSON.stringify(listing, null, 2) + '\n');
	fs.writeFileSync(path.join(dir, 'README.md'), `# ${id}\n\n${t.summary}\n\n## Who it is for\n\n## What it saves\n\n## Permissions\n\n${t.perms.map((p) => `- \`${p}\``).join('\n')}\n\n## Sample\n\nShow one real input and output.\n`);
	console.log(`created ${dir} (${type}, tier ${t.tier})\nnext: edit it, then  ./bolt-apps lint ${dir}  and  ./bolt-apps pack ${dir}`);
}

// ---------- keys, tar, pack, verify ----------
function cmdKeygen(args) {
	const out = flag(args, '--out', DEFAULT_KEY);
	if (fs.existsSync(out)) die(`${out} already exists; refusing to overwrite a signing key`);
	if (path.resolve(out).startsWith(process.cwd() + path.sep)) console.error('warning: that key file is inside the current folder; keep signing keys out of any git repo.');
	const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
	fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
	fs.writeFileSync(out, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
	console.log(`key written to ${out} (private, mode 600)\npublic key: ${rawPub(publicKey)}\nKeep the file private. Anyone with it can sign as you.`);
}
const rawPub = (pub) => pub.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
export function tarFile(name, data) {
	const nb = Buffer.from(name); if (nb.length > 100) die(`path too long for a pack: ${name}`);
	const h = Buffer.alloc(512); nb.copy(h, 0);
	h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
	h.write(data.length.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136);
	h.write('        ', 148); h.write('0', 156); h.write('ustar  \0', 257);
	h.write(h.reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148);
	return Buffer.concat([h, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}
const PACK_LIMITS = { entries: 1024, unpacked: 64 * 1024 * 1024, inflated: 64 * 1024 * 1024 + 4 * 1024 * 1024 };
// Only these names exist in a pack: bundle.json, signature.bin and files under manifests/. Segments are plain: no empty, ., .., backslash or leading slash.
const canonicalName = (n) => (n === 'bundle.json' || n === 'signature.bin' || n.startsWith('manifests/') || n === 'manifests') && n.length > 0 && !n.includes('\\') && !n.startsWith('/') && n.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
class PackError extends Error { constructor(code, message) { super(message); this.code = code; } }
function untar(buf) {
	const files = new Map(); let off = 0, headers = 0, bytes = 0;
	while (off + 512 <= buf.length) {
		const h = buf.subarray(off, off + 512); if (h.every((b) => b === 0)) break;
		if (++headers > PACK_LIMITS.entries) throw new PackError('too_many_files', `more than ${PACK_LIMITS.entries} entries`);
		const s = (a, b) => h.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
		const name = (s(345, 500) ? s(345, 500) + '/' : '') + s(0, 100), raw = s(124, 136).trim() || '0';
		const want = s(148, 156).trim(); let sum = 0; for (let k = 0; k < 512; k++) sum += k >= 148 && k < 156 ? 32 : h[k];
		if (!/^[0-7]+$/.test(want) || parseInt(want, 8) !== sum) throw new PackError('pack_malformed', 'a tar header checksum does not match');
		if (!/^[0-7]+$/.test(raw)) throw new PackError('pack_malformed', 'a file size in the archive is not a valid number');
		const size = parseInt(raw, 8), type = String.fromCharCode(h[156] || 48);
		if (type !== '0' && type !== '5') throw new PackError('pack_malformed', `an archive entry of type ${JSON.stringify(type)} (only plain files and folders are allowed)`);
		const bare = type === '5' ? name.replace(/\/$/, '') : name;
		if (!canonicalName(bare)) throw new PackError('pack_malformed', `an archive entry has a name Bolt does not accept: ${JSON.stringify(name.slice(0, 60))}`);
		if (!Number.isSafeInteger(size) || size < 0) throw new PackError('pack_malformed', 'a file size in the archive is invalid');
		bytes += size; if (bytes > PACK_LIMITS.unpacked) throw new PackError('pack_too_large', 'the pack unpacks to more than 64 MB');
		off += 512; if (off + size > buf.length) throw new PackError('pack_malformed', 'the archive ends inside a file');
		if (type === '0') { if (files.has(name)) throw new PackError('pack_duplicate_entry', `the archive holds ${name.slice(0, 80)} twice`); files.set(name, buf.subarray(off, off + size)); }
		off += Math.ceil(size / 512) * 512;
	}
	return files;
}
export function contentHash(manifests) {
	const h = crypto.createHash('sha256');
	for (const [p, c] of [...manifests].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
		const pb = Buffer.from(p), pl = Buffer.alloc(4), cl = Buffer.alloc(8); pl.writeUInt32LE(pb.length); cl.writeBigUInt64LE(BigInt(c.length)); h.update(pl).update(pb).update(cl).update(c);
	}
	return h.digest('hex');
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const KINDS = { snippets: 'snippet', search_engines: 'search_engine', utilities: 'user_utility', scripts: 'script' };
const INTERPRETERS = { '.py': 'python3', '.sh': 'sh' };
function cmdPack(args) {
	const dir = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--key' && args[args.indexOf(a) - 1] !== '--out' && args[args.indexOf(a) - 1] !== '--version' && args[args.indexOf(a) - 1] !== '--notes');
	if (!dir || !fs.existsSync(path.join(dir, 'bolt-app.json'))) die('usage: ./bolt-apps pack <app-folder> [--key file] [--out file.boltpack] [--version 1.0.0] [--notes "text"] [--personal]');
	const personal = args.includes('--personal');
	const r = lintApp(dir, { personal }), errs = r.out.filter((x) => x.level === 'error');
	const HINT = 'The gallery takes tier 1 and 2 only. Use `pack --personal` to build a pack for your own use.';
	if (!personal && errs.some((e) => e.code === 'tier3_not_accepted' || e.code === 'unknown_file') && (() => { const pl = lintApp(dir, { personal: true }); return pl.tier >= 3 && pl.out.every((x) => x.level !== 'error'); })()) {
		die('this app runs programs or reaches the network (tier 3), so it cannot go to the gallery. To build a pack for your own use, add --personal:\n  ./bolt-apps pack ' + dir + ' --personal\n' + HINT, 1);
	}
	if (errs.length) {
		errs.forEach((e) => console.error(`  ${e.code}: ${e.message} (${e.path})`));
		const tier3 = !personal && (errs.some((e) => e.code === 'tier3_not_accepted') || fs.existsSync(path.join(dir, 'scripts')));
		die(`fix the findings above first (./bolt-apps lint ${personal ? '--personal ' : ''}shows them)` + (tier3 ? '\n' + HINT : ''), 1);
	}
	let packWarnings = [];
	if (personal) { // never write a pack that verify would refuse
		const vf = []; for (const [folder, names] of Object.entries(r.files)) for (const n of names) if (KINDS[folder]) vf.push({ path: `${folder}/${n}`, kind: KINDS[folder], content: fs.readFileSync(path.join(dir, folder, n)) });
		const cm = checkManifests(vf, { platforms: r.app.platforms, appId: r.app.id, minBolt: r.app.min_bolt_version, minBoltKnown: true }); packWarnings = cm.findings.filter((x) => x.level === 'warning' && x.code !== 'script_mentions'); const bad = cm.findings.filter((x) => x.level === 'error');
		if (bad.length) { bad.forEach((e) => console.error(`  ${e.code}: ${e.message} (${e.file}${e.line ? ':' + e.line : ''})\n    fix: ${e.fix}`)); die('fix the findings above first (./bolt-apps verify shows them)', 1); }
	}
	const keyFile = flag(args, '--key', DEFAULT_KEY);
	if (!fs.existsSync(keyFile)) die(`no signing key at ${keyFile}. Make one with: ./bolt-apps keygen`);
	const priv = crypto.createPrivateKey(rd(keyFile)), pub = rawPub(crypto.createPublicKey(priv));
	const manifests = new Map();
	for (const [folder, names] of Object.entries(r.files)) for (const n of names) manifests.set(`${folder}/${n}`, fs.readFileSync(path.join(dir, folder, n)));
	const app = r.app, version = flag(args, '--version', '1.0.0');
	{ const vp = versionProblem(version); if (vp) die(vp + '. Example: --version 1.0.1', 1); }
	const entries = [...manifests].sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, c]) => {
		const kind = KINDS[p.split('/')[0]], e = { path: `manifests/${p}`, kind, id: kind === 'script' ? p.replace(/^scripts\//, '') : path.basename(p).replace(/\.[^.]+$/, ''), sha256: sha(c), requires_min_schema: 1 };
		if (kind === 'script' && INTERPRETERS[path.extname(p)]) e.interpreter = INTERPRETERS[path.extname(p)];
		return e;
	});
	const meta = {
		schema_version: 1, bundle_version: version, signed_by: app.author.name, signed_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
		min_bolt_api_version: '0.1.0', content_sha256: contentHash(manifests), manifest_count: manifests.size, entries, release_notes: flag(args, '--notes', ''),
		bundle_kind: 'util_pack', pack: { pack_id: app.id, name: app.title, description: app.summary || undefined, author: { name: app.author.name, kind: 'user' } },
		risk: { level: r.tier >= 3 ? 'high' : r.tier >= 2 ? 'medium' : 'low', reasons: r.tier >= 3 ? ['Can act outside Bolt'] : r.tier >= 2 ? ['Runs a launcher transform on what you paste'] : [] },
		signer_pubkey: pub, listing: personal ? { ...app, tier: r.tier, permissions: listingPermissions(r.perms) } : app,
	};
	const bundle = Buffer.from(JSON.stringify(meta, null, 2)), sig = crypto.sign(null, bundle, priv);
	const parts = [tarFile('bundle.json', bundle), tarFile('signature.bin', sig), ...[...manifests].sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, c]) => tarFile(`manifests/${p}`, c)), Buffer.alloc(1024)];
	// A pack written inside the app folder would be read as an unknown file by the next pack (unknown_file). With no --out the pack goes
	// to the current folder, unless that is the app folder or inside it, and then to the folder's parent.
	const appAbs = path.resolve(dir), inApp = (f) => path.resolve(f) === appAbs || path.resolve(f).startsWith(appAbs + path.sep);
	const outFlag = flag(args, '--out', null), out = outFlag || path.join(inApp(process.cwd()) ? path.dirname(appAbs) : process.cwd(), `${app.id}.boltpack`), gz = zlib.gzipSync(Buffer.concat(parts), { level: 9 });
	if (gz.length > 50 * 1024 * 1024) die('pack is over the 50 MB limit', 1);
	fs.writeFileSync(out, gz);
	if (outFlag && inApp(outFlag)) console.error(`warning: ${out} is inside the app folder. bolt-apps ignores *.boltpack files there, but keep packs outside the folder (for example --out ../${app.id}-${version}.boltpack).`);
	console.log(`packed ${out} (${manifests.size} file${manifests.size === 1 ? '' : 's'}, tier ${r.tier}, signed with key ${pub.slice(0, 16)}...)`);
	const skipped = [...manifests.keys()].filter((p) => /^(snippets|search_engines)\//.test(p));
	if (skipped.length) console.log(`note: dropping a pack on the launcher installs User Apps and scripts only; Bolt skips ${skipped.join(', ')}.`);
	for (const w of r.out.filter((x) => x.level === 'warning')) console.log(`warning ${w.code}: ${w.message} (${w.path})`);
	for (const w of packWarnings) console.log(`warning ${w.code}: ${w.message} (${w.file})`);
	// The launcher maps "is already installed" to same_or_older_version: Bolt refuses a pack whose bundle_version is not newer than the installed one
	console.log(`\nversion ${version}: Bolt refuses to install a pack whose version is the same as, or older than, the one already installed (same_or_older_version). If you installed an earlier build of ${app.id}, rebuild with a higher number: bump --version (for example --version ${bumpVersion(version)}).`);
	if (personal) {
		console.log(`\nThis app is for your own use. What it can do:`);
		for (const x of r.perms) console.log(`  - ${plainPermission(x)}`);
		for (const a of r.assessed) for (const why of a.reasons) console.log(`  - ${why}`);
		for (const sc of r.files.scripts || []) console.log(`  - it includes a script (${sc}) that runs on your computer`);
		console.log(`\nBolt will show these same facts and ask whoever installs it to confirm, because the pack is signed only by you. Anyone you give it to must trust you.\nTo install: drop ${out} on the Bolt launcher or on Bolt Apps (not Admin settings, which takes only Sparcle-signed bundles).\nOn a device whose company policy allows only approved apps, Bolt refuses it.`);
	} else console.log('to install: drop it on the Bolt launcher. Bolt shows a review card, then asks again because it is self-signed.');
}
const bumpVersion = (v) => { const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v); return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : `${v}.1`; };
export function readPack(file) {
	let e;
	try {
		if (fs.statSync(file).size > 50 * 1024 * 1024) return { ok: false, code: 'pack_too_large', reason: 'the file is larger than 50 MB' };
		e = untar(zlib.gunzipSync(fs.readFileSync(file), { maxOutputLength: PACK_LIMITS.inflated }));
	} catch (x) {
		if (x instanceof PackError) return { ok: false, code: x.code, reason: x.message };
		if (x.code === 'ERR_BUFFER_TOO_LARGE') return { ok: false, code: 'pack_too_large', reason: 'the pack unpacks to more than 64 MB' };
		return { ok: false, code: 'pack_not_gzip_tar', reason: `not a gzip tar: ${x.message}` };
	}
	const bj = e.get('bundle.json'), sig = e.get('signature.bin'); if (!bj) return { ok: false, code: 'bundle_missing', reason: 'bundle.json is missing' };
	let meta; try { meta = JSON.parse(bj.toString()); } catch { return { ok: false, code: 'bundle_not_json', reason: 'bundle.json is not JSON' }; }
	if (!isObj(meta) || (meta.entries !== undefined && (!Array.isArray(meta.entries) || meta.entries.some((x) => !isObj(x) || typeof x.path !== 'string' || typeof x.sha256 !== 'string')))) return { ok: false, code: 'bundle_not_json', reason: 'bundle.json is not the object with an entries list of {path, sha256} that a pack has' };
	const man = new Map([...e].filter(([p]) => p.startsWith('manifests/')).map(([p, c]) => [p.slice(10), c]));
	const bad = (code, reason) => ({ ok: false, code, reason, meta, files: man, count: e.size });
	if (!sig || sig.length !== 64) return bad('signature_missing', 'signature.bin is missing or not 64 bytes');
	if (meta.signer_pubkey !== undefined && !/^[0-9a-f]{64}$/i.test(String(meta.signer_pubkey))) return bad('signature_mismatch', 'signer_pubkey is not 64 hexadecimal characters');
	if (!meta.signer_pubkey) return bad('signed_by_other_key', 'signed by a Sparcle or company key; only Bolt can verify that');
	let good = false; try { good = crypto.verify(null, bj, crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(meta.signer_pubkey, 'hex')]), format: 'der', type: 'spki' }), sig); } catch { /* bad key */ }
	if (!good) return bad('signature_mismatch', 'the signature does not match bundle.json');
	if (contentHash(man) !== meta.content_sha256) return bad('content_hash_mismatch', 'files changed after signing (content hash mismatch)');
	for (const en of meta.entries || []) { if (!String(en.path).startsWith('manifests/')) continue; const c = man.get(String(en.path).replace(/^manifests\//, '')); if (!c || sha(c) !== en.sha256) return bad('entry_hash_mismatch', `entry ${en.path} does not match its hash`); }
	return { ok: true, meta, files: man, count: e.size };
}
// Pack text is untrusted: show control, format and bidi characters as \\uXXXX so a pack cannot move the cursor or forge lines.
export const esc = (v) => String(v).replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
function cmdVerify(args) {
	const json = args.includes('--json'), f = args.find((x) => !x.startsWith('--'));
	if (!f || !fs.existsSync(f)) die('usage: ./bolt-apps verify <app-folder | file.boltpack> [--json]');
	let findings = [], confirm = null, kind;
	if (fs.statSync(f).isDirectory()) {
		kind = 'app';
		const r = lintApp(f, { personal: true });
		findings = r.out.filter((x) => !(x.code === 'field_missing' && /^(id|runtime) is required$/.test(x.message)) && !ASSESS_CODES.has(x.code) && !['script_missing', 'script_unused', 'script_too_large', 'helper_not_hashed', 'yaml_escape', 'yaml_unreadable_here', 'script_not_namespaced', 'description_chip_mismatch', 'chip_not_id'].includes(x.code)).map((x) => ({ level: x.level, code: x.code, message: x.message, file: x.path, fix: FIXES[x.code] || x.message }));
		if (r.app) {
			const files = [];
			for (const [folder, names] of Object.entries(r.files)) for (const n of names) if (KINDS[folder]) files.push({ path: `${folder}/${n}`, kind: KINDS[folder], content: fs.readFileSync(path.join(f, folder, n)) });
			const c = checkManifests(files, { platforms: r.app.platforms, appId: r.app.id, minBolt: r.app.min_bolt_version, minBoltKnown: true }); findings.push(...c.findings);
			confirm = confirmPreview({ apps: c.apps, files, scriptsList: files.filter((x) => x.kind === 'script').map((x) => path.basename(x.path)), signer: 'not signed yet: ./bolt-apps pack signs it with your key', unknownAssess: c.unknownAssess });
		}
	} else {
		kind = 'pack';
		const r = readPack(f);
		if (!r.ok) findings.push({ level: 'error', code: r.code, message: r.reason, file: path.basename(f), fix: FIXES[r.code] });
		else {
			findings.push(...checkPackShape(r.meta, r.files, r.count));
			const files = (r.meta.entries || []).filter((e) => ['user_utility', 'script'].includes(e.kind) && r.files.has(String(e.path).replace(/^manifests\//, ''))).map((e) => ({ path: String(e.path).replace(/^manifests\//, ''), kind: e.kind, content: r.files.get(String(e.path).replace(/^manifests\//, '')) }));
			const c = checkManifests(files, { platformsUnknown: true, minBoltKnown: false, minBolt: r.meta.listing && typeof r.meta.listing === 'object' ? r.meta.listing.min_bolt_version : undefined, appId: r.meta.pack?.pack_id }); findings.push(...c.findings);   // a pack does not record platforms, so a missing OS command is not reported here
			confirm = confirmPreview({ apps: c.apps, files, scriptsList: files.filter((x) => x.kind === 'script').map((x) => path.basename(x.path)), signer: `self-signed by key ${r.meta.signer_pubkey}; identity is not verified`, unknownAssess: c.unknownAssess });
		}
	}
	const ok = !findings.some((x) => x.level === 'error');
	if (json) console.log(JSON.stringify({ ok, kind, findings: findings.map((x) => ({ ...x, path: x.file })), confirm }, null, 2));   // path as lint --json has it; file stays
	else {
		for (const x of findings) console.log(`${x.level.toUpperCase().padEnd(7)} ${esc(x.code)}  ${esc(x.file || '')}${x.line ? ':' + x.line : ''}\n        ${esc(x.message)}\n        fix: ${esc(x.fix)}`);
		if (confirm) {
			console.log(`\nEstimate, Bolt checks again at install (it may rate the app higher):\n  tier ${confirm.tier}, risk ${confirm.risk}\n  signer: ${esc(confirm.signer)}`);
			if (confirm.tier === 'unknown') console.log('  unable to assess: see yaml_unreadable_here above; treat it as high risk until fixed');
			for (const p of confirm.permissions) console.log(`  can: ${esc(p.text)}`);
			for (const x of confirm.reasons) console.log(`  because: ${esc(x)}`);
			console.log(`  files: ${confirm.files.map((x) => esc(x.path)).join(', ')}\n  ${esc(confirm.note)}`);
		}
		console.log(ok ? (kind === 'pack' ? 'valid, self-signed\nThis proves the files were not changed after signing. It does not prove who signed them. Bolt parses every app file again at install.' : 'no known install problems found. Bolt parses every app file again at install.') : `NOT VALID: ${findings.filter((x) => x.level === 'error').length} problem(s) Bolt would refuse, that would stop the app loading, or that this tool cannot assess`);
	}
	process.exit(ok ? 0 : 1);
}

// ---------- main ----------
const HELP = `bolt-apps: author toolkit for Bolt Apps

  new <template> <id> [--dir .]                           copy a template (new --list shows them): renamed, check passes, next steps printed
  new <id> [--type snippet|search|transform|recognizer]   start a gallery app from a small template
  run <app-folder> [view [word]] [--sample|--live] [--json]  run the app as Bolt would and show the rows (the debug loop)
  ship <app-folder>                                       lint, check, pack, verify with the next version picked; prints how to install
  doctor [app-folder]                                     check node, python, your key, folders and what would block an install
  lint [path] [--personal] [--json]                       offline shape checks (--personal: your own tier 3 or script app)
  check <app-folder> [--os macos|linux|windows] [--case text] [--shared] [--update-golden] [--json]
                                                          run a script app's check.json cases against stubbed commands and goldens
  kit vendor [--flat] <app-folder>                        copy the current bolt_app_kit into an app with a check.json
  kit export-shared <empty-folder> [--source-sha <sha>]   write the one read-only kit folder Bolt ships (manifest.json, bolt_app_kit.py, LICENSE)
  keygen [--out file]                                     make your signing key (default ~/.bolt-apps/key.pem); run once before the first pack
  pack <app-folder> [--key file] [--out file] [--version X] [--notes text] [--personal]
                                                          build and self-sign a .boltpack (raise --version on every rebuild)
  verify <app-folder | file.boltpack> [--json]            the checks Bolt runs at install, offline, with the fix for each problem
  help, --help                                            this list
  --version                                               print the toolkit version

Docs: https://sparcle.app/docs/extend/`;
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
	const [cmd, ...rest] = process.argv.slice(2);
	const cmdCheck = async (args) => {
		const target = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--os' && args[i - 1] !== '--case');
		if (target && fs.existsSync(path.join(target, 'check.json'))) {
			const osi = args.indexOf('--os'), osArg = osi >= 0 ? args[osi + 1] : undefined;
			if (osi >= 0 && !OSES.includes(osArg)) die(`--os must be one of ${OSES.join(', ')}`);
			const ci = args.indexOf('--case');
			const r = await checkApp(target, { os: osArg, only: ci >= 0 ? args[ci + 1] : undefined, updateGolden: args.includes('--update-golden'), shared: args.includes('--shared') });
			console.log(args.includes('--json') ? JSON.stringify({ ok: reportOk(r), ...r }, null, 2) : formatReport(r));
			process.exit(reportOk(r) ? 0 : 1);
		}
		if (!target) die('usage: ./bolt-apps check <app-folder>');
		const has = (sub) => fs.existsSync(path.join(target, sub));
		const yamls = (() => { try { return fs.readdirSync(path.join(target, 'utilities')).filter((f) => /\.ya?ml$/.test(f)); } catch { return []; } })();
		if (!fs.existsSync(target) || !(has('snippets') || has('search_engines') || yamls.length)) die(`no app found in ${target}: an app folder holds utilities/<id>.yaml`);
		die('check for snippets, search engines and transforms runs through Bolt\'s own engines and is not published yet. Use lint for offline shape checks; Bolt runs the tests when you add the app. Script apps (a check.json in the folder) run here: see kit/examples/system-glance.');
	};
	const cmdKit = (args) => {
		if (args[0] === 'export-shared' && args.includes('--help')) { console.log('usage: ./bolt-apps kit export-shared <empty-folder> [--source-sha <40 hex>]\nwrites manifest.json, bolt_app_kit.py and LICENSE: the one read-only kit folder Bolt ships'); return; }
		if (args[0] === 'export-shared') {
			const si = args.indexOf('--source-sha'), sha = si >= 0 ? args[si + 1] : undefined;
			const dir = args.slice(1).find((x, i, a) => !x.startsWith('--') && a[i - 1] !== '--source-sha');
			let r; try { r = exportShared(dir, { sourceSha: sha }); } catch (e) { die(e.message); }
			console.log(`exported the shared kit ${r.manifest.kit.version} (api ${r.manifest.kit.api}, sha256 ${r.manifest.kit.sha256.slice(0, 16)}...) to ${r.dir}: ${r.files.join(', ')}`);
			return;
		}
		const target = args.slice(1).find((x) => !x.startsWith('--'));
		if (args[0] !== 'vendor' || !target || !fs.existsSync(path.join(target, 'check.json'))) die('usage: ./bolt-apps kit vendor [--flat] <app-folder with check.json>');
		let dest, lock; try { ({ dest, lock } = vendorKit(target, { flat: args.includes('--flat') })); } catch (e) { die(e.message); }
		console.log(`vendored ${lock.name} ${lock.version} (sha256 ${lock.sha256.slice(0, 16)}...) into ${dest}`);
	};
	const cmds = { check: cmdCheck, kit: cmdKit, new: cmdNew, lint: cmdLint, keygen: cmdKeygen, pack: cmdPack, verify: cmdVerify, run: (a) => runApp(a), ship: (a) => ship(a), doctor: (a) => doctor(a) };
	if (cmds[cmd]) await cmds[cmd](rest);
	else if (cmd === '--version' || cmd === 'version') console.log(JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version);
	else if (!cmd || cmd === 'help' || cmd === '--help') console.log(HELP);
	else die(`unknown command "${cmd}"\n\n${HELP}`);
}
