// The one-command-per-job workflow: new <template> <id>, run, ship, doctor. Each command writes only inside the app folder or ~/.bolt-apps,
// never prints a secret, and ends every problem with the exact fix. They call the other commands as child processes so there is one
// implementation of lint, check, pack and verify.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseYaml, get, str, notYamlHint } from './yamlsubset.mjs';
import { vendorKit } from './check.mjs';
import { formatBoltSays } from './boltsays.mjs';
import { versionProblem } from './boltrules.mjs';
import { pythonCmd, spawnPython, PYTHON_MISSING } from './python.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '../bin/bolt-apps.mjs');
const EXAMPLES = path.resolve(HERE, '../../kit/examples');
const STATE = path.join(os.homedir(), '.bolt-apps');
const DOCS = 'https://sparcle.app/docs/extend/agent-guide.md';
const q = (p) => (/^[A-Za-z0-9_./:@%+=,~-]+$/.test(p) ? p : `'${String(p).replace(/'/g, `'\\''`)}'`);   // a path with spaces is printed in quotes so it can be pasted
// Exit codes as in CHECKER.md: 1 when the app fails or is refused, 2 for a usage error (wrong arguments, no app folder), as the other commands do
const die = (m, code = 1) => { console.error(`bolt-apps: ${m}`); process.exit(code); };
const bolt = (args, opts = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', ...opts });

// A value that looks like a real secret in any file of the app. Only high-confidence shapes: an app may legitimately hold made-up sample keys.
const SECRET_SHAPES = [/\b(sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{20,})/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /Authorization['":\s]+Bearer\s+[A-Za-z0-9._~+\/-]{24,}/i];
export function keyLooking(dir) {
	const hits = [];
	const walk = (d) => {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			if (e.name === '__pycache__' || e.name === '.git' || e.name.endsWith('.boltpack')) continue;
			const f = path.join(d, e.name);
			if (e.isDirectory()) walk(f); else if (e.isFile() && fs.statSync(f).size < 2e6) {
				const b = fs.readFileSync(f); if (b.includes(0)) continue;
				const t = b.toString('utf8'); for (const re of SECRET_SHAPES) if (re.test(t)) { hits.push(path.relative(dir, f)); break; }
			}
		}
	};
	walk(dir);
	return hits;
}
const refuseSecrets = (dir) => { const h = keyLooking(dir); if (h.length) die(`${h.join(', ')} holds something shaped like a real key or token. Remove it from the app folder: keys go in the system keychain or ~/.config/<id>/.env (mode 600), never in a file you pack or share. See ${DOCS}#secrets`); };

// ---------------------------------------------------------------- new <template> <id>  and  new --list
export const listTemplates = () => { try { return JSON.parse(fs.readFileSync(path.join(EXAMPLES, 'index.json'), 'utf8')).apps.filter((a) => fs.existsSync(path.join(EXAMPLES, a.id, 'bolt-app.json'))); } catch { return []; } };   // an entry whose folder is not here yet is not offered
export const hasTemplate = (name) => /^[a-z0-9][a-z0-9-]*$/.test(name) && fs.existsSync(path.join(EXAMPLES, name, 'bolt-app.json'));
// ---------------------------------------------------------------- stale clone
// Is the clone of bolt-apps this toolkit runs from behind origin/main? Local facts only: the remote-tracking ref `git fetch` last updated and the age of
// .git/FETCH_HEAD. No network, each git call has a 2 second limit, and any problem means "say nothing".
const git = (cwd, args) => { try { const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 2000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } }); return r.status === 0 ? r.stdout.trim() : null; } catch { return null; } };
export function staleClone(root = path.resolve(HERE, '../..'), now = Date.now()) {
	try {
		if (!fs.existsSync(path.join(root, '.git'))) return null;   // not a clone of its own (a copy, a download, or a folder inside another repo)
		const top = git(root, ['rev-parse', '--show-toplevel']); if (!top || fs.realpathSync(top) !== fs.realpathSync(root)) return null;
		if (!git(root, ['remote', 'get-url', 'origin'])) return null;
		if (!git(root, ['rev-parse', '--verify', '-q', 'refs/remotes/origin/main'])) return null;
		const behind = Number(git(root, ['rev-list', '--count', 'HEAD..refs/remotes/origin/main']));
		if (!Number.isInteger(behind)) return null;
		let age = '', old = false;
		// FETCH_HEAD is written by every fetch or pull; a clone that was never fetched since has only the clone's own reflog, which dates the clone
		for (const name of ['FETCH_HEAD', 'logs/HEAD']) {
			try {
				const h = Math.max(0, Math.floor((now - fs.statSync(path.resolve(root, git(root, ['rev-parse', '--git-path', name]))).mtimeMs) / 3600000));
				old = h >= 24; age = h < 1 ? 'less than an hour ago' : h < 48 ? `${h} hours ago` : `${Math.floor(h / 24)} days ago`; break;
			} catch { /* try the next */ }
		}
		if (behind > 0) return `your copy of bolt-apps is ${behind} commit${behind === 1 ? '' : 's'} behind (last fetch: ${age || 'unknown'}): run git pull --ff-only`;
		if (old) return `your copy of bolt-apps last checked GitHub ${age} and may be behind: run git pull --ff-only`;
		return null;
	} catch { return null; }
}
let staleShown = false;
export const staleCloneNote = () => { if (staleShown) return; staleShown = true; const m = staleClone(); if (m) console.error(`note: ${m}`); };

// ---------------------------------------------------------------- Bolt user-utils folder (doctor, read only)
export function userUtilsDir(env = process.env, platform = process.platform, home = os.homedir()) {
	if (env.BOLT_USER_UTILS_DIR) return env.BOLT_USER_UTILS_DIR;
	const sub = 'app.sparcle.bolt.enterprise';
	const base = platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : platform === 'win32' ? (env.APPDATA || path.join(home, 'AppData', 'Roaming')) : (env.XDG_CONFIG_HOME || path.join(home, '.config'));
	return path.join(base, sub, 'user-utils');
}
// Names only, never contents and never a write. Lists the files in Bolt's user apps folder that would stop a pack of this app installing (file_exists).
// Old flat names are the app's own script names without the `<id>__` prefix (a hand copy from before apps were namespaced): never from a pack.
// An `<id>.yaml` or `scripts/<id>__*` file is what a pack of this app leaves, so names alone cannot say whether it is a problem: kind says which.
export function userUtilsClashes(dir, id, appDir) {
	const out = [];
	try { if (!fs.statSync(dir).isDirectory()) return out; } catch { return out; }
	const ls = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
	const top = ls(dir), scripts = ls(path.join(dir, 'scripts'));
	for (const f of top) if (f === `${id}.yaml` || f === `${id}.yml`) out.push({ file: path.join(dir, f), kind: 'app file' });
	for (const f of scripts) if (f.startsWith(`${id}__`)) out.push({ file: path.join(dir, 'scripts', f), kind: 'script' });
	const own = ls(path.join(appDir || '', 'scripts')).filter((f) => f.startsWith(`${id}__`)).map((f) => f.slice(id.length + 2));
	for (const f of scripts) if (own.includes(f)) out.push({ file: path.join(dir, 'scripts', f), kind: 'old flat name' });
	return out;
}

export function newList() {
	const apps = listTemplates();
	console.log('Templates (./bolt-apps new <template> <id>):\n');
	for (const a of apps) console.log(`  ${a.id.padEnd(24)} ${a.need || a.layout}\n  ${''.padEnd(24)} edit: ${(a.edit || []).join(', ')}`);
	console.log(`\nStart with the one whose "need" matches. Not sure: ${DOCS}`);
}
export function newFromTemplate(template, id, root) {
	staleCloneNote();
	const src = path.join(EXAMPLES, template);
	if (!fs.existsSync(path.join(src, 'bolt-app.json'))) die(`no template "${template}". Run: ./bolt-apps new --list`, 2);
	if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) die('the id is lowercase letters, digits and hyphens, at most 64 characters, for example my-tool', 2);
	const dir = path.join(root, id);
	if (fs.existsSync(dir) || (() => { try { fs.lstatSync(dir); return true; } catch { return false; } })()) die(`${q(dir)} already exists (or is a link). Choose another id, or delete it first`, 2);
	const fail = (m) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* nothing more to do */ } die(m); };   // never leave a half-made folder behind
	try { fs.cpSync(src, dir, { recursive: true, filter: (f) => !/__pycache__|\.boltpack$|[\\/]golden([\\/]|$)/.test(f) }); } catch (e) { fail(`could not copy the template: ${e.message}`); }
	// The chip is what the person types after =. Bolt's chip rule is the id rule (^[a-z0-9][a-z0-9-]{0,63}$), so the id itself is always a valid chip, hyphens included: a new
	// version of the same app keeps the chip people already type. (Nothing is truncated: an id is at most 64 characters, the chip limit.)
	const chip = id;
	fs.rmSync(path.join(dir, 'golden'), { recursive: true, force: true });   // the template's goldens belong to the template; check --update-golden writes new ones
	const title = id.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
	const edit = (f, fn) => { const p = path.join(dir, f); if (fs.existsSync(p)) fs.writeFileSync(p, fn(fs.readFileSync(p, 'utf8'))); };
	// What the template called itself, read before anything is rewritten: its id (the folder name), its chip and its title.
	const tud = path.join(dir, 'utilities');
	let oldChip, oldTitle;
	try { const y = fs.readdirSync(tud).find((f) => /\.ya?ml$/.test(f)); const root = parseYaml(fs.readFileSync(path.join(tud, y), 'utf8')); oldChip = str(get(root, 'chip')?.value); oldTitle = str(get(root, 'title')?.value); } catch { /* no readable app file: only the id is rewritten */ }
	// Bolt keeps every installed app's scripts in ONE shared folder, so each script file is named <app id>__<name>. A copy renames them all.
	const sd0 = path.join(dir, 'scripts');
	if (template !== id && fs.existsSync(sd0)) for (const f of fs.readdirSync(sd0)) if (f.startsWith(`${template}__`)) fs.renameSync(path.join(sd0, f), path.join(sd0, `${id}__${f.slice(template.length + 2)}`));
	const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	// Words the template used for itself, in every text file of the copy: its file prefix, "=chip" (what the person types), its id and its title as a whole word. A bare chip is not replaced
	// (it can be an ordinary word, such as branch); only the =chip form is.
	// ONE pass over each text, longest meaning first, so a new text is never rewritten again (an id such as <template>-2 contains the template's own name).
	const parts = [`(?<![A-Za-z0-9_-])${esc(template)}__`, `(?<![A-Za-z0-9_-])${esc(template)}(?![A-Za-z0-9_]|-(?!\\d+\\.\\d+\\.\\d+\\.boltpack)[A-Za-z0-9])`];
	if (oldChip && oldChip !== chip) parts.push(`=${esc(oldChip)}(?![A-Za-z0-9_-])`);
	if (oldTitle && oldTitle !== title) parts.push(`(?<![A-Za-z0-9_-])${esc(oldTitle)}(?![A-Za-z0-9_-])`);
	const oneRe = new RegExp(parts.map((x) => `(${x})`).join('|'), 'g');
	const reword = (s) => (template === id ? s : s.replace(oneRe, (m, g1, g2, g3, g4) => (g1 ? `${id}__` : g2 ? id : g3 ? `=${chip}` : title)));
	const walkText = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walkText(f); else if (/\.(md|json|ya?ml|py)$/.test(e.name) && !/__bolt_app_kit\.py$|fixtures\.json$/.test(e.name)) { const s = fs.readFileSync(f, 'utf8'), r = reword(s); if (r !== s) fs.writeFileSync(f, r); } } };
	// the template's README runs its commands from the repo root; the copy lives elsewhere, so they run from inside the folder
	edit('README.md', (s) => s.split('node toolkit/bin/bolt-apps.mjs').join('bolt-apps').split(`kit/examples/${template}`).join('.'));
	walkText(dir);
	if (fs.existsSync(sd0)) { const longest = fs.readdirSync(sd0).map((f) => `manifests/scripts/${f}`).filter((n) => n.length > 100)[0]; if (longest) fail(`the id "${id}" is too long: ${longest.slice(10)} would not fit: Bolt allows 128 characters per name (every file starts with <app id>__, ids are up to 64), and this toolkit packs at most 82 for a script name. Choose a shorter id.`); }
	// The listing text (summary, role, saves) and the app description described the TEMPLATE. Say so plainly instead of leaving another app's words on yours: lint warns (listing_todo) until they are rewritten.
	edit('bolt-app.json', (t) => { const j = JSON.parse(t); j.id = id; j.title = title; j.summary = `TODO describe your app: what =${chip} shows, in one line.`; j.role = 'TODO describe who this app is for.'; j.saves = 'TODO describe what it saves them.'; return JSON.stringify(j, null, 2) + '\n'; });
	edit('README.md', (s) => `> Template text below: replace it with what your app does. The files \`new\` leaves for you to rewrite are listed in ENGINE.md, "Make it yours".\n\n${s}`);
	const cfgName = `scripts/${id}__config.json`;
	edit(cfgName, (t) => { const j = JSON.parse(t); if (j.app) { j.app.id = id; j.app.chip = chip; j.app.title = title; j.app.description = `TODO describe your app: one line on what =${chip} shows.`; } return JSON.stringify(j, null, 2) + '\n'; });
	// regenerate the app file from the config when the template has an emitter, else rewrite id, chip and title in place
	const sd = path.join(dir, 'scripts');
	const emitter = fs.existsSync(sd) ? fs.readdirSync(sd).filter((f) => f.endsWith('.py') && !f.endsWith('__bolt_app_kit.py')).find((f) => fs.readFileSync(path.join(sd, f), 'utf8').includes('--emit-yaml')) : null;
	const ud = path.join(dir, 'utilities');
	if (emitter) {
		const r = spawnPython([`scripts/${emitter}`, '--emit-yaml'], { cwd: dir, encoding: 'utf8' });
		if (r.status !== 0) fail(`could not generate the app file: ${String(r.stderr || (r.error && r.error.message) || PYTHON_MISSING).slice(-300)}`);
		for (const y of fs.readdirSync(ud)) fs.rmSync(path.join(ud, y));
		fs.writeFileSync(path.join(ud, `${id}.yaml`), r.stdout);
	} else if (fs.existsSync(ud)) for (const y of fs.readdirSync(ud)) { const p = path.join(ud, y); fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/^id: .*$/m, `id: ${id}`).replace(/^chip: .*$/m, `chip: ${chip}`).replace(/^title: .*$/m, `title: "${title}"`)); }
	// the vendored kit is named for its app: re-vendor it under the new name (the template's lock and file name carry the old id)
	if (fs.existsSync(path.join(dir, 'check.json')) && fs.existsSync(path.join(dir, 'scripts', `${id}__bolt_app_kit.py`))) { try { vendorKit(dir, { flat: true }); } catch (e) { fail(`could not vendor the kit: ${e.message}`); } }
	let note = '', minimal = false;
	if (fs.existsSync(path.join(dir, 'check.json'))) {   // goldens were not copied: record them for the new app and show that it passes
		minimal = minimalCheck(dir, id);
		const pruned = minimal ? 0 : pruneSampleExpectations(dir, id);
		const r = bolt(['check', dir, '--update-golden']);
		const r2 = r.status === 0 ? bolt(['check', dir]) : r;   // a second plain run proves the recorded goldens agree with a fresh run
		note = r2.status === 0 ? `check passes on the sample data${minimal ? ' (check.json was rewritten with one case per view and none of the template words: it checks that every row is well formed)' : ''}${pruned ? ` (${pruned} expected-text line${pruned === 1 ? '' : 's'} about the template's own sample words were dropped from check.json; add your own once your data is in)` : ''}` : `CHECK DOES NOT PASS YET (it did not pass straight after the copy, which is a toolkit fault, not yours):\n${(r2.stdout + r2.stderr).slice(-900)}`;
	}
	console.log(`created ${q(dir)} from ${template} (id ${id}, chip =${chip}). ${note}\n\nNext:\n${[`edit: ${(listTemplates().find((a) => a.id === template)?.edit || ['the files its README names']).map((f) => f.split(`${template}__`).join(`${id}__`)).join(', ')}${(() => { const fe = listTemplates().find((a) => a.id === template)?.first_edit; return fe ? `\n     change first: ${String(fe).split(`${template}__`).join(`${id}__`)}` : ''; })()}`, connectStep(dir, id), `./bolt-apps run ${q(dir)} --sample      (see the rows) and  ./bolt-apps check ${q(dir)}`, `./bolt-apps ship ${q(dir)}              (lint, check, pack, verify, then drop the .boltpack on Bolt)`].filter(Boolean).map((t, i) => `  ${i + 1}. ${t}`).join('\n')}\n\nMake it yours (full list: ENGINE.md, "Make it yours"):\n  - the listing in bolt-app.json and the config description say TODO\n  - README.md starts with a note: replace it\n  - check.json ${minimal ? 'has one case per view' : 'still expects the template words'}\n  - once your data is final, run ./bolt-apps check ${q(dir)} --update-golden and read what changed.`);
}

// For an engine app in views or lookup mode, replace the template's check.json cases by one case per view, taken from the app's own config (view ids, the first example query).
// Nothing is copied from the template's words, so the first edit of the data does not break check. A form-mode app, or a copy where the rewritten check does not pass, keeps the template cases.
// Returns true when the rewrite was kept.
function minimalCheck(dir, id) {
	const p = path.join(dir, 'check.json'), cf = path.join(dir, 'scripts', `${id}__config.json`);
	if (!fs.existsSync(path.join(dir, 'scripts', `${id}__engine.py`))) return false;   // only the shared engine: a script app with its own config.json keeps its template cases
	let cfg, ec; try { cfg = JSON.parse(fs.readFileSync(p, 'utf8')); ec = JSON.parse(fs.readFileSync(cf, 'utf8')); } catch { return false; }
	const mode = ec.mode || 'views';
	let cases;
	if (mode === 'lookup') {
		const ex = (ec.lookup && Array.isArray(ec.lookup.examples) && typeof ec.lookup.examples[0] === 'string' ? ec.lookup.examples[0] : 'example').split(/\s+/).filter(Boolean).slice(0, 3);
		cases = [{ name: 'a typed word draws its rows', args: ex }, { name: 'no word asks for one', args: [] }, { name: 'offline preview', args: [...ex, 'demo-offline'] }];
	} else if (mode === 'views' && Array.isArray(ec.views)) {
		const ids = ['overview', ...ec.views.map((v) => v && v.id).filter((x) => typeof x === 'string')];
		cases = [...ids.map((v) => ({ name: `${v}: every row is well formed`, args: [v] })), { name: 'offline preview', args: [ids[1] || 'overview', 'demo-offline'] }];
	} else return false;
	const keep = fs.readFileSync(p, 'utf8');
	const osName = cfg.cases && cfg.cases[0] && cfg.cases[0].os ? cfg.cases[0].os : 'macos';
	cfg.cases = cases.map((c) => ({ ...c, os: osName, expect: { min_rows: 1 } }));   // no template word, but not empty: check itself also refuses a run with no rows, a blank title or subtitle, a missing sample label and a view the config lacks
	delete cfg.known_empty_tiles;
	fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
	const r = bolt(['check', dir]);
	if (r.status === 0) return true;
	fs.writeFileSync(p, keep);   // the rewrite did not pass: keep the template cases rather than hand over a failing check
	return false;
}

// check.json lists expected texts. Some are the engine's own words (kept); others are the template's sample words ("Example Co", "Example Service"), which go stale the moment the
// author puts their own data in. A copy keeps the first kind and drops the second, so a fresh app stays checkable after the first edit. Returns how many lines were dropped.
function pruneSampleExpectations(dir, id) {
	const p = path.join(dir, 'check.json'); let cfg; try { cfg = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return 0; }
	if (!fs.existsSync(path.join(dir, 'scripts', `${id}__config.json`))) return 0;   // only engine apps: their sample words live in config.json and fixtures.json
	let engine = ''; try { const sd = path.join(dir, 'scripts'); for (const f of fs.readdirSync(sd)) if (f.endsWith('.py')) engine += fs.readFileSync(path.join(sd, f), 'utf8'); } catch { return 0; }
	let dropped = 0;
	for (const c of Array.isArray(cfg.cases) ? cfg.cases : []) {
		const ex = c && c.expect; if (!ex || !Array.isArray(ex.text_present)) continue;
		const keep = ex.text_present.filter((t) => typeof t !== 'string' || engine.includes(t) || t.includes(id));
		dropped += ex.text_present.length - keep.length;
		if (keep.length) ex.text_present = keep; else delete ex.text_present;
	}
	if (dropped) fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
	return dropped;
}

// ---------------------------------------------------------------- run
// When the app has an engine, ask it for the app file: if the config is what is wrong, its message (and the valid icons) is the real cause of an unreadable app file.
function emitterProblem(dir) {
	try {
		const sd = path.join(dir, 'scripts'), em = fs.readdirSync(sd).filter((f) => f.endsWith('__engine.py')).find((f) => fs.readFileSync(path.join(sd, f), 'utf8').includes('--emit-yaml')); if (!em) return '';
		const r = spawnPython([path.join(sd, em), '--emit-yaml'], { cwd: sd, encoding: 'utf8', timeout: 20000 });
		return r.status !== 0 && r.stderr ? `\nThe real cause, from the engine:\n${r.stderr.trim().split('\n').slice(0, 6).join('\n').slice(0, 900)}` : '';
	} catch { return ''; }
}
function bridgeCommand(dir0, words) {
	const dir = path.resolve(dir0);
	const ud = path.join(dir, 'utilities');
	let y; try { y = fs.readdirSync(ud).find((f) => /\.ya?ml$/.test(f)); } catch { die(`${q(ud)} is missing. An app folder has utilities/<id>.yaml`); } if (!y) die(`${q(ud)} has no app file`);
	let root; try { root = parseYaml(fs.readFileSync(path.join(ud, y), 'utf8')); } catch (e) { die(`${q(path.join(ud, y))} cannot be read as an app file (${String(e.message).slice(0, 120)}). ${notYamlHint(fs.readFileSync(path.join(ud, y), 'utf8')) || 'Fix the YAML, or regenerate it from config.json.'}${emitterProblem(dir)}`); }
	const osKey = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux';
	const tpl = str(get(get(get(root, 'bridge')?.value, 'command')?.value, osKey)?.value);
	if (!tpl) return { root, error: `the app file has no bridge command for ${osKey}` };
	const vars = {};
	for (const a of get(root, 'args')?.value?.items || []) {
		const m = /^query\.word\(\s*(\d+)\s*\)$/.exec((str(get(a, 'from')?.value) ?? '').trim());
		if (m) vars[str(get(a, 'name')?.value)] = words[Number(m[1])] ?? String(str(get(a, 'default')?.value) ?? '-');
	}
	// split the command into words first, then fill each word: a folder with spaces in its path stays one word, and a query word can never add words
	const argv = tpl.split(/\s+/).filter(Boolean).map((w) => w.replace(/\{\{scripts_dir\}\}/g, path.join(dir, 'scripts')).replace(/\{\{\s*(\w+)\s*(?:\|\s*default:\s*([^}]*?)\s*)?\}\}/g, (_, n, d) => vars[n] ?? d ?? '-'));
	return { root, argv };
}
function paneOf(root, view) {
	const pres = get(root, 'presentation')?.value, v = get(get(pres, 'views')?.value, view)?.value;
	const rw = get(v, 'right_widget')?.value || get(pres, 'right_widget')?.value;
	return rw ? `${str(get(rw, 'kind')?.value)} (${str(get(rw, 'mode')?.value) || 'default mode'})` : 'none';
}
export function runApp(args) {
	const flags = args.filter((a) => a.startsWith('--')), rest = args.filter((a) => !a.startsWith('--'));
	const dir = rest[0]; if (!dir || !fs.existsSync(path.join(dir, 'bolt-app.json'))) die('usage: ./bolt-apps run <app-folder> [view [word]] [--sample | --live] [--json]\n  Runs the app about as Bolt would (an approximation: the launcher is the final judge) and shows the rows. Note: it executes the app\'s own command on your computer with your real HOME and PATH; --live reads your real keychain and ~/.config/<id>/.env. Run only code you have read.', 2);
	refuseSecrets(dir);
	const words = rest.slice(1);
	const b = bridgeCommand(dir, words); if (b.error) die(b.error);
	const env = { PATH: process.env.PATH, HOME: os.homedir(), USER: os.userInfo().username, LOGNAME: os.userInfo().username, LANG: process.env.LANG || 'en_US.UTF-8', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1', BOLT_APP_DEBUG: '1' };   // an approximation of the launcher's runner environment: the launcher is the final judge
	if (flags.includes('--sample')) env.BOLT_APP_FIXTURE = '1'; else if (flags.includes('--live')) env.BOLT_APP_FIXTURE = '0';
	const r = spawnSync(b.argv[0], b.argv.slice(1), { env, cwd: path.join(dir, 'scripts'), encoding: 'utf8', input: '', timeout: 30000 });
	if (r.error || r.status !== 0) die(`the script failed (exit ${r.status}). ${r.stderr ? 'Its error output:\n' + r.stderr.trim().split('\n').slice(-12).join('\n') : (r.error ? String(r.error.message) : '')}\n  Command: ${b.argv.map(q).join(' ')}`);
	let rows; try { rows = JSON.parse(r.stdout); } catch { die(`the script did not print JSON rows. It printed: ${r.stdout.slice(0, 300)}${r.stderr ? '\nstderr: ' + r.stderr.trim().slice(-300) : ''}`); }
	if (flags.includes('--json')) { console.log(JSON.stringify(rows, null, 2)); return; }
	const view = words[0] || 'overview';
	console.log(`${path.basename(path.resolve(dir))} · view ${view} · ${env.BOLT_APP_FIXTURE === '1' ? 'sample data' : env.BOLT_APP_FIXTURE === '0' ? 'live' : "the app's default mode"} · right pane: ${paneOf(b.root, view)}`);
	const sm = startMode(dir), sampleNow = env.BOLT_APP_FIXTURE === '1' || (env.BOLT_APP_FIXTURE !== '0' && /^Start mode: sample data/.test(sm || ''));
	console.log(sampleNow ? `author note (not shown to the person using the app): these rows come from fixtures.json. ${sm && /^Start mode: sample/.test(sm) ? sm : 'To ship live, api.fixture_default must be false in config.json.'}\n` : '');
	rows.forEach((x, i) => {
		const badges = [x.kpi_badge, ...((x.badges || []).map((q) => q.label))].filter(Boolean);
		console.log(`${String(i + 1).padStart(2)}. ${x.title}${badges.length ? '  [' + badges.join(', ') + ']' : ''}${x.nav ? (x.nav.back ? '   <- Back' : `   -> ${x.nav.view}${x.nav.arg ? ' ' + x.nav.arg : ''}`) : ''}`);
		if (x.subtitle) console.log(`      ${x.subtitle}`);
		if (x.kpi_label) console.log(`      tile: ${x.kpi_label} = ${x.kpi_value}${x.kpi_unit ? ' ' + x.kpi_unit : ''}${x.kpi_max !== '' && x.kpi_max !== undefined ? ' of ' + x.kpi_max : ''}${x.kpi_note ? ' (' + x.kpi_note + ')' : ''}`);
		const extras = Object.keys(x).filter((k) => !['title', 'subtitle', 'icon', 'body', 'nav', 'actions', 'pane', 'copy_text', 'open_url', 'url', 'badges', 'id', 'category', 'data', 'trend', 'multiline'].includes(k) && !k.startsWith('kpi_') && x[k] !== '');
		if (extras.length) console.log(`      fields: ${extras.map((k) => `${k}=${String(x[k]).slice(0, 40)}`).join(', ')}`);
		if (x.open_url || x.url) console.log(`      opens: ${x.open_url || x.url}`);
		if (x.copy_text) console.log(`      copies: ${String(x.copy_text).replace(/\n/g, ' / ').slice(0, 80)}`);
		for (const a of x.actions || []) console.log(`      action: ${a.label} (${a.kind})`);
		if (x.trend) console.log(`      trend: ${x.trend.length} points`);
		if (x.body) console.log(`      body: ${String(x.body).split('\n')[0].slice(0, 80)}`);
	});
	if (rows.some((x) => x.title === 'This app could not run' || x.title === 'This app is not set up correctly')) console.log('\nThe app printed its own error row (above). BOLT_APP_DEBUG=1 is set, so the script wrote the real error to its error output; run with --json to see it as data.');
}

// A template that calls a placeholder API (api.example.com) shows labelled sample data on its first run; say how to connect the real one.
const PLACEHOLDER_HOST = /(^|\.)example\.(com|org|net)$|\.invalid$/;
export function connectStep(dir, id) {
	try {
		const c = JSON.parse(fs.readFileSync(path.join(dir, 'scripts', `${id}__config.json`), 'utf8')), api = c.api || {};
		const host = (() => { try { return new URL(api.base_url).hostname; } catch { return ''; } })();
		if (!(PLACEHOLDER_HOST.test(host) || api.fixture_default === true || api.on_missing_key === 'sample')) return null;
		if (api.fixture_default === true) return 'connect your API: set api.base_url, hosts, key and flip fixture_default to false when your data is real (until then the app shows labelled sample data)';
		if (api.on_missing_key === 'sample') return 'connect your API: set api.base_url, hosts and key. Until your key is found the app shows labelled sample data (api.on_missing_key is sample)';
		return 'connect your API: set api.base_url, hosts and key (the address in the config is a placeholder)';
	} catch { return null; }
}


// What the app shows the first time it runs, read from its config: live with a key, labelled sample data when there is no key, or only a setup row.
export function startMode(dir) {
	try {
		const app = JSON.parse(fs.readFileSync(path.join(dir, 'bolt-app.json'), 'utf8')), c = JSON.parse(fs.readFileSync(path.join(dir, 'scripts', `${app.id}__config.json`), 'utf8')), api = c.api || {};
		if (!Object.keys(api).length) return 'Start mode: sample data (this app has no api section), so it never contacts a service. Fine for an app that is sample-only by design.';
		if (api.fixture_default === true) return `Start mode: sample data (api.fixture_default is true), so it never contacts a service.${api.key_env ? ` The config also names a key (api.key_env ${api.key_env}), but a sample-only app never reads it and never goes live: set api.fixture_default to false to ship it live, or leave key_env out if sample-only is what you want.` : ' Fine for an app that is sample-only by design (offline demo); a live app ships with it false.'}`;
		if (!api.key_env) return 'Start mode: live. This app needs no key.';
		return api.on_missing_key === 'sample'
			? 'Start mode: live when your key is found; with no key it shows labelled SAMPLE DATA with a row that says how to add one (api.on_missing_key is sample).'
			: 'Start mode: live when your key is found; with no key it shows only a row that says how to add one, no sample data (api.on_missing_key is setup). Set it to sample for a demo.';
	} catch { return null; }
}

// ---------------------------------------------------------------- ship
const notLink = (f) => { try { if (fs.lstatSync(f).isSymbolicLink()) die(`${f} is a link, which is not followed. Replace it with a real file or folder you own`); } catch (e) { if (e.code !== 'ENOENT') throw e; } };
const loadShip = () => { try { const j = JSON.parse(fs.readFileSync(path.join(STATE, 'ship.json'), 'utf8')); return j && typeof j === 'object' && !Array.isArray(j) ? Object.assign(Object.create(null), j) : Object.create(null); } catch { return Object.create(null); } };
const bump = (v) => { const p = String(v).split('.').map(Number); if (p.length !== 3 || p.some((n) => !Number.isInteger(n))) return '1.0.1'; p[2] += 1; return p.join('.'); };
// Bolt replaces an installed pack only with a NEWER version, and compares numbers (a missing part counts as 0, "+build" is ignored, a pre-release is older). The patch
// number here is seconds since 2026-01-01, so a build made later is always higher, even when ~/.bolt-apps/ship.json is lost or another computer made the last one.
const EPOCH_MS = Date.UTC(2026, 0, 1);
export const clockVersion = (now = Date.now()) => `1.0.${Math.max(1, Math.floor((now - EPOCH_MS) / 1000))}`;
const core = (v) => String(v).trim().replace(/^[vV]/, '').split('+')[0].split('-')[0].split('.').map((x) => Number(x) || 0);
export const newer = (a, b) => { const x = core(a), y = core(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d > 0; } return false; };
export function ship(args) {
	const dir = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--version'); if (!dir || !fs.existsSync(path.join(dir, 'bolt-app.json'))) die('usage: ./bolt-apps ship <app-folder> [--version X]   (lint, check, pack, verify, with the next version picked for you)', 2);
	staleCloneNote();
	refuseSecrets(dir);
	let app; try { app = JSON.parse(fs.readFileSync(path.join(dir, 'bolt-app.json'), 'utf8')); } catch (e) { die(`${q(path.join(dir, 'bolt-app.json'))} is not valid JSON (${e.message}). Fix it, then run ship again`); }
	if (!app || typeof app !== 'object' || Array.isArray(app)) die(`${q(path.join(dir, 'bolt-app.json'))} must be a JSON object with an id, title and so on, not ${app === null ? 'null' : Array.isArray(app) ? 'a list' : typeof app}. Fix it, then run ship again`);
	if (typeof app.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(app.id)) die(`bolt-app.json needs an "id" of lowercase letters, digits and hyphens (got ${JSON.stringify(app.id ?? null)})`);
	const chipOf = () => { try { const y = fs.readdirSync(path.join(dir, 'utilities')).find((f) => /\.ya?ml$/.test(f)); return str(get(parseYaml(fs.readFileSync(path.join(dir, 'utilities', y), 'utf8')), 'chip')?.value) || null; } catch { return null; } };
	const chipNow = chipOf(), chipsSeen = loadShip()['#chips'], chipBefore = chipsSeen && typeof chipsSeen === 'object' ? chipsSeen[app.id] : null;
	if (chipNow && chipBefore && chipNow !== chipBefore) console.log(`WARNING the chip changed: your last build of ${app.id} used =${chipBefore}, this one uses =${chipNow}. Anyone typing =${chipBefore} will find nothing after they install it. Keep the chip unless you mean to change it (set it back in the app file, or in config.json and regenerate the app file).`);
	const seenWarn = new Set();   // lint and pack print the same warnings: each distinct one is shown once
	const step = (name, r) => { if (r.status === 0 && /^(lint|pack)/.test(name)) { const ws = `${r.stdout}`.split('\n').filter((l) => /^\s*warning /.test(l)); const fresh = ws.filter((l) => !seenWarn.has(l.trim())); console.log(`ok ${name}${ws.length && !fresh.length ? ' (same warnings as above)' : ''}`); for (const l of fresh) { seenWarn.add(l.trim()); console.log(`   ${l.trim()}`); } if (fresh.some((l) => /description_todo/.test(l))) console.log('   WARNING your app description still says TODO: it is shipped in the pack and shown in the launcher. Fix it before you share the pack.'); return; } if (r.status !== 0) { console.error(`${r.stdout}${r.stderr}`.trim().split('\n').slice(-25).join('\n')); die(`${name} failed. Fix the lines above (each says what to change), then run ship again`); } console.log(`ok ${name}`); };
	step('lint --personal', bolt(['lint', dir, '--personal']));
	if (fs.existsSync(path.join(dir, 'check.json'))) step('check', bolt(['check', dir]));
	notLink(STATE); notLink(path.join(STATE, 'key.pem')); notLink(path.join(STATE, 'ship.json')); notLink(path.join(STATE, 'packs'));
	const key = path.join(STATE, 'key.pem');
	if (!fs.existsSync(key)) { const k = bolt(['keygen']); if (k.status !== 0) die(`could not make your signing key: ${k.stderr || k.stdout}`); console.log('ok made your signing key in ~/.bolt-apps/key.pem (keep it private, never share it)'); }
	const state = loadShip(), vflag = args.indexOf('--version'), forced = vflag >= 0 ? args[vflag + 1] : undefined;
	let version, why;
	if (forced !== undefined) { const vp = versionProblem(forced); if (vp) die(`${vp}. Example: --version 1.0.5, or leave --version out and ship picks one`); version = forced; why = 'the version you asked for with --version'; }
	else {
		version = clockVersion(); why = 'taken from the clock, so it is higher than every earlier build, even if your ship notes are lost or another computer built the last one';
		// the packs this computer already made also count (a lost ship.json leaves them), so a wrong clock cannot make a lower number either
		let last = typeof state[app.id] === 'string' ? state[app.id] : null;
		try { for (const f of fs.readdirSync(path.join(STATE, 'packs'))) { const m = new RegExp(`^${app.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+\\.\\d+\\.\\d+)\\.boltpack$`).exec(f); if (m && (!last || newer(m[1], last))) last = m[1]; } } catch { /* no packs folder yet */ }
		if (last && !newer(version, last)) { version = bump(last); why = `one above your last build (${last})`; }
	}
	console.log(`ok version ${version}: ${why}`);
	fs.mkdirSync(path.join(STATE, 'packs'), { recursive: true, mode: 0o700 });
	const out = path.join(STATE, 'packs', `${app.id}-${version}.boltpack`);
	step(`pack ${version}`, bolt(['pack', dir, '--personal', '--version', version, '--out', out]));
	step('verify', bolt(['verify', out]));
	state[app.id] = version; if (chipNow) state['#chips'] = { ...(state['#chips'] && typeof state['#chips'] === 'object' ? state['#chips'] : {}), [app.id]: chipNow }; fs.mkdirSync(STATE, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(STATE, 'ship.json'), JSON.stringify(Object.fromEntries(Object.entries(state)), null, 2) + '\n');
	const chip = (() => { try { const y = fs.readdirSync(path.join(dir, 'utilities')).find((f) => /\.ya?ml$/.test(f)); return str(get(parseYaml(fs.readFileSync(path.join(dir, 'utilities', y), 'utf8')), 'chip')?.value) || app.id; } catch { return app.id; } })();
	console.log(`\nShipped ${app.id} ${version}: ${out}\n\nInstall it:
  1. Drop ${q(out)} on the Bolt launcher (or on Bolt Apps; not Admin settings).
  2. Bolt shows the review card. It says the pack is self-signed: that is expected, install it. Expect it to rate the app HIGH risk: it runs a script on your computer, and that is normal for a personal script app. It lists what the app can do; read it. Click Install.
  3. Bolt's own "Install an unverified Bolt pack?" dialog follows, on every OS, for a pack you signed yourself. Click Install.
  4. Then open Bolt Settings, Desktop, User Apps, expand the app, click Review and accept. Every reship changes the files, so you do this each time. An empty list when you press Enter means the app is not approved yet.
  5. Open the launcher and type =${chip}.
  ${startMode(dir) || 'Start mode: this app has no engine config, so it starts as its script says.'}
To change the app: edit it, run bolt-apps ship again, drop the new file. The version rises by itself and replaces the old one; your other apps are not touched.
This app runs as you: only install code you have read.

If Bolt refuses it, the usual reasons:
${formatBoltSays(['same_or_older_version', 'owned_by_other', 'file_exists', 'org_policy'])}
Every message and fix: bolt-apps doctor --bolt-says`);
}

// ---------------------------------------------------------------- doctor
export function doctor(args) {
	if (args.includes('--bolt-says')) { console.log(`Bolt said X, do Y:\n${formatBoltSays()}`); return; }
	if (args.includes('--help') || args.includes('-h')) { console.log(`usage: ./bolt-apps doctor [app-folder] [--bolt-says]

Checks node, python3, your signing key, ~/.bolt-apps, and with an app folder: its key file, lint and verify, and whether files already in your Bolt
user apps folder would stop its pack installing (Bolt message file_exists). That scan reads file names only and never writes or deletes.

Environment: BOLT_USER_UTILS_DIR=<folder> checks that folder instead of the default (macOS ~/Library/Application Support/app.sparcle.bolt.enterprise/user-utils,
Windows %APPDATA%\\app.sparcle.bolt.enterprise\\user-utils, Linux ~/.config/app.sparcle.bolt.enterprise/user-utils).`); return; }
	const dir = args.find((a) => !a.startsWith('--'));
	// a folder that is not an app is a usage error: checking only the computer and saying "All good" would hide the typo
	if (dir && !fs.existsSync(path.join(dir, 'bolt-app.json'))) die(`no app found in ${q(dir)} (an app folder has a bolt-app.json)\nusage: ./bolt-apps doctor [app-folder] [--bolt-says]`, 2);
	const line = (ok, what, fix) => console.log(`${ok ? 'ok  ' : 'FIX '} ${what}${ok ? '' : `\n       ${fix}`}`);
	let bad = 0; const chk = (ok, what, fix) => { if (!ok) bad++; line(ok, what, fix); };
	const nodeMajor = Number(process.versions.node.split('.')[0]); chk(nodeMajor >= 18, `node ${process.versions.node}`, 'Install Node 18 or newer (https://nodejs.org).');
	const py = pythonCmd();
	chk(!!py, `python ${py ? `(${py.label})` : 'not found'}`, `${PYTHON_MISSING}; script apps run with Python 3.`);
	chk(fs.existsSync(path.join(STATE, 'key.pem')), `signing key (${q(path.join(STATE, 'key.pem'))})`, 'Run: ./bolt-apps keygen   (once; ship also makes it for you)');
	try { fs.mkdirSync(STATE, { recursive: true, mode: 0o700 }); fs.accessSync(STATE, fs.constants.W_OK); chk(true, '~/.bolt-apps is writable'); } catch { chk(false, '~/.bolt-apps is writable', `Run: mkdir -p ${q(STATE)} && chmod 700 ${q(STATE)}`); }
	if (dir && fs.existsSync(path.join(dir, 'bolt-app.json'))) {
		let id; try { const j = JSON.parse(fs.readFileSync(path.join(dir, 'bolt-app.json'), 'utf8')); if (!j || typeof j !== 'object' || Array.isArray(j)) { chk(false, 'bolt-app.json is a JSON object', `Make ${q(path.join(dir, 'bolt-app.json'))} an object like { "id": "my-tool", ... } (it is ${j === null ? 'null' : 'not an object'})`); console.log(`\n${bad} thing(s) to fix.`); process.exit(1); } id = j.id; } catch (e) { chk(false, 'bolt-app.json is valid JSON', `Fix ${path.join(dir, 'bolt-app.json')}: ${e.message}`); console.log(`\n${bad} thing(s) to fix.`); process.exit(1); }
		if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) { chk(false, 'bolt-app.json has an id', 'Add "id": "my-tool" (lowercase letters, digits, hyphens) to bolt-app.json.'); console.log(`\n${bad} thing(s) to fix.`); process.exit(1); }
		const env = path.join(os.homedir(), '.config', id, '.env');
		if (fs.existsSync(env)) chk((fs.statSync(env).mode & 0o077) === 0, `~/.config/${id}/.env is private`, `Run: chmod 600 ${q(env)}`);
		if (startMode(dir)) console.log(`     ${startMode(dir)}`);
		const hits = keyLooking(dir); chk(!hits.length, 'no real-looking key in the app folder', `Remove the key from ${hits.map(q).join(', ')}; keys go in the keychain or ~/.config/${id}/.env.`);
		const l = bolt(['lint', dir, '--personal']); chk(l.status === 0, 'lint --personal (what blocks a dropped pack)', `Run: ./bolt-apps lint ${q(dir)} --personal   and fix each line it prints.`);
		if (l.status === 0) { const v = bolt(['verify', dir]); chk(v.status === 0, 'verify (what Bolt checks at install)', `Run: ./bolt-apps verify ${q(dir)}   and fix each line it prints.`); }
		const uu = userUtilsDir(), shippedHere = typeof loadShip()[id] === 'string';
		for (const c of userUtilsClashes(uu, id, dir)) {
			const how = process.platform === 'win32' ? `del ${q(c.file)}` : `rm ${q(c.file)}`;
			if (c.kind !== 'old flat name' && shippedHere) { console.log(`     ${c.kind} ${q(c.file)} is in your Bolt user apps folder: expected if you installed a pack of ${id} (a newer version replaces it).`); continue; }
			chk(false, `${c.kind} in your Bolt user apps folder: ${q(c.file)}`, `${c.kind === 'old flat name' ? 'A hand copy from before scripts were named <app id>__<name>' : `You have not shipped ${id} from here, so this is likely a hand copy`}: Bolt refuses the pack with file_exists. Remove it: ${how}   (or Settings, Desktop, User Apps, Open folder, then delete it). If a pack of ${id} put it there, leave it.`);
		}
	} else console.log('\n(give an app folder to also check its key file, lint and verify: ./bolt-apps doctor <app-folder>)');
	console.log(bad ? `\n${bad} thing(s) to fix.` : '\nAll good.');
	process.exit(bad ? 1 : 0);
}
