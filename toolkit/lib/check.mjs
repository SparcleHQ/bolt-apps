// bolt-apps check (script apps): run an app's script the way the launcher does, against recorded command output.
// Built in v0.1: clean subprocess with an empty environment and a temp HOME; stub commands on a controlled PATH;
// per-OS fixture sets (--os); hung-command mode with a total-time assertion; hostile-data fuzz; golden snapshots;
// schema validation of every output; footer button and label limits; the numeric tile rule; text safety scan;
// vendored-kit divergence guard. Not built: see docs/kit-design.md, section "What check does not do".
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const KIT_ROOT = path.resolve(here, '..', '..', 'kit');
export const KIT_PY = path.join(KIT_ROOT, 'python', 'bolt_app_kit');
const SCHEMA = JSON.parse(fs.readFileSync(path.join(KIT_ROOT, 'schema', 'row.schema.json'), 'utf8'));
export const OSES = ['macos', 'linux', 'windows'];
const PY_PLATFORM = { macos: 'darwin', linux: 'linux', windows: 'win32' };
export const hostOs = () => ({ darwin: 'macos', linux: 'linux', win32: 'windows' })[process.platform] || 'other';
const BRIDGE_LIMIT_S = 20, DEFAULT_MAX_S = 18;

// ---- the JSON Schema subset row.schema.json uses ----
const resolve = (root, ref) => ref.replace(/^#\//, '').split('/').reduce((n, k) => n[k], root);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const typeOk = (v, t) => t === 'string' ? typeof v === 'string' : t === 'number' ? isNum(v) : t === 'boolean' ? typeof v === 'boolean' : t === 'object' ? v !== null && typeof v === 'object' && !Array.isArray(v) : t === 'array' ? Array.isArray(v) : true;
export function schemaCheck(v, s, root = SCHEMA, p = '$') {
	if (s.$ref) return schemaCheck(v, resolve(root, s.$ref), root, p);
	if ('const' in s && v !== s.const) return [`${p}: must be ${JSON.stringify(s.const)}`];
	if (s.enum && !s.enum.includes(v)) return [`${p}: ${JSON.stringify(String(v).slice(0, 40))} is not one of the allowed values`];
	if (s.oneOf) return s.oneOf.filter((o) => !schemaCheck(v, o, root, p).length).length === 1 ? [] : [`${p}: does not match exactly one allowed shape`];
	if (s.type && !typeOk(v, s.type)) return [`${p}: must be ${s.type}`];
	const e = [];
	if (typeof v === 'string') {
		const n = [...v].length;
		if (s.minLength != null && n < s.minLength) e.push(`${p}: shorter than ${s.minLength}`);
		if (s.maxLength != null && n > s.maxLength) e.push(`${p}: longer than ${s.maxLength} characters`);
		if (s.pattern && !new RegExp(s.pattern).test(v)) e.push(`${p}: does not match ${s.pattern}`);
	}
	if (Array.isArray(v)) {
		if (s.maxItems != null && v.length > s.maxItems) e.push(`${p}: more than ${s.maxItems} items`);
		if (s.minItems != null && v.length < s.minItems) e.push(`${p}: fewer than ${s.minItems} items`);
		if (s.uniqueItems && new Set(v.map((x) => JSON.stringify(x))).size !== v.length) e.push(`${p}: items must be unique`);
		if (s.items) v.forEach((x, i) => e.push(...schemaCheck(x, s.items, root, `${p}[${i}]`)));
	} else if (v !== null && typeof v === 'object') {
		for (const r of s.required || []) if (!(r in v)) e.push(`${p}: missing ${r}`);
		for (const [k, x] of Object.entries(v)) {
			if (s.properties && k in s.properties) e.push(...schemaCheck(x, s.properties[k], root, `${p}.${k}`));
			else if (s.additionalProperties === false) e.push(`${p}: unknown field ${k}`);
			else if (s.additionalProperties && typeof s.additionalProperties === 'object') e.push(...schemaCheck(x, s.additionalProperties, root, `${p}.${k}`));
		}
	}
	return e;
}

// ---- platforms / requires in bolt-app.json ----
const REQ_INTERP = ['python', 'node', 'sh', 'powershell'];
export function platformFindings(app) {
	const out = [], E = (code, message) => out.push({ level: 'error', code, message, path: 'bolt-app.json' });
	if ('platforms' in app) {
		const p = app.platforms;
		if (!Array.isArray(p) || !p.length || p.some((x) => !OSES.includes(x)) || new Set(p).size !== p.length) E('platforms_invalid', `platforms must be a non-empty list of unique values from ${OSES.join(', ')}`);
	}
	if ('requires' in app) {
		const r = app.requires;
		if (!Array.isArray(r) || r.length > 8 || r.some((x) => !x || typeof x !== 'object' || !REQ_INTERP.includes(x.interpreter) || (x.min_version !== undefined && !/^\d+(\.\d+){0,2}$/.test(String(x.min_version))) || Object.keys(x).some((k) => !['interpreter', 'min_version', 'platforms'].includes(k)) || (x.platforms !== undefined && (!Array.isArray(x.platforms) || x.platforms.some((q) => !OSES.includes(q))))))
			E('requires_invalid', `requires must be a list of { interpreter: ${REQ_INTERP.join('|')}, min_version: "3.9", platforms?: [...] }`);
	}
	return out;
}

// ---- kit vendoring and the divergence guard ----
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
export function treeHash(dir) {
	const files = [];
	const walk = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) { if (e.name === '__pycache__' || e.name.endsWith('.pyc') || e.isSymbolicLink()) continue; const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) walk(path.join(d, e.name), r); else files.push(r); } };
	walk(dir, '');
	return sha(files.map((f) => `${f}\0${sha(fs.readFileSync(path.join(dir, f)))}\n`).join(''));
}
export const kitVersion = () => /__version__\s*=\s*"([^"]+)"/.exec(fs.readFileSync(path.join(KIT_PY, '__init__.py'), 'utf8'))[1];
export function vendorKit(appDir) {
	const cfg = JSON.parse(fs.readFileSync(path.join(appDir, 'check.json'), 'utf8'));
	const dest = path.join(appDir, cfg.kit || 'scripts/bolt_app_kit');
	fs.rmSync(dest, { recursive: true, force: true });
	fs.mkdirSync(dest, { recursive: true });
	for (const f of fs.readdirSync(KIT_PY)) if (f.endsWith('.py') || f.endsWith('.json')) fs.copyFileSync(path.join(KIT_PY, f), path.join(dest, f));
	const lock = { name: 'bolt_app_kit', version: kitVersion(), sha256: treeHash(dest) };
	fs.writeFileSync(`${dest}.lock.json`, JSON.stringify(lock, null, 2) + '\n');
	return { dest, lock };
}
export function kitGuard(appDir, cfg) {
	const out = [], E = (code, message) => out.push({ level: 'error', code, message, path: cfg.kit || 'scripts/bolt_app_kit' });
	const dest = path.join(appDir, cfg.kit || 'scripts/bolt_app_kit');
	if (!fs.existsSync(dest) || !fs.existsSync(`${dest}.lock.json`)) { E('kit_not_vendored', 'the kit is not vendored: run bolt-apps kit vendor <app>'); return out; }
	let lock; try { lock = JSON.parse(fs.readFileSync(`${dest}.lock.json`, 'utf8')); } catch { E('kit_lock_unreadable', 'bolt_app_kit.lock.json is not JSON'); return out; }
	if (treeHash(dest) !== lock.sha256) E('kit_modified', 'the vendored kit differs from its lock (someone edited it). Re-vendor, do not edit');
	else if (lock.version === kitVersion() && lock.sha256 !== treeHash(KIT_PY)) E('kit_diverged', `the vendored kit says ${lock.version} but differs from this repo's ${lock.version}`);
	else if (lock.version !== kitVersion()) out.push({ level: 'warning', code: 'kit_outdated', message: `app is pinned to kit ${lock.version}; this toolkit has ${kitVersion()}`, path: cfg.kit });
	return out;
}

// ---- stubs and the process ----
const SH_QUOTE = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const HOSTILE = 'a\u202eb\u200bc{{x}}\u{E0041}d\u2028e\u0007f';
function makeStubs(dir, appDir, osName, kase, files) {
	const stubs = {};
	const base = path.join(appDir, 'fixtures', osName);
	if (fs.existsSync(base)) for (const f of fs.readdirSync(base)) { const m = /^(.+)\.out$/.exec(f); if (m) stubs[m[1]] = { file: path.join(base, f), rc: fs.existsSync(path.join(base, `${m[1]}.rc`)) ? Number(fs.readFileSync(path.join(base, `${m[1]}.rc`), 'utf8').trim()) : 0 }; }
	for (const [n, o] of Object.entries(kase.stubs || {})) stubs[n] = o.file ? { ...o, file: path.join(appDir, o.file) } : { ...o };
	for (const n of kase.hang || []) stubs[n] = { hang: true };
	fs.mkdirSync(dir, { recursive: true });
	for (const [name, s] of Object.entries(stubs)) {
		if (!/^[A-Za-z0-9._+-]+$/.test(name)) throw new Error(`bad stub name ${name}`);
		if (s.missing) continue;
		let body = '#!/bin/sh\n';
		if (s.hang) body += '/bin/sleep 60\n';
		else {
			let data = s.file ? fs.readFileSync(s.file, 'utf8') : (s.stdout ?? '');
			data = data.split('@@HOSTILE@@').join(kase.hostile ? HOSTILE : 'plainname');
			const df = path.join(dir, `.data-${name}`);
			fs.writeFileSync(df, data);
			files.push(df);
			body += `/bin/cat ${SH_QUOTE(df)}\nexit ${Number.isInteger(s.rc) ? s.rc : 0}\n`;
		}
		fs.writeFileSync(path.join(dir, name), body, { mode: 0o755 });
	}
}
const WRAPPER = `import sys, os, runpy
script, plat = sys.argv[1], sys.argv[2]
sys.path.insert(0, os.path.dirname(script))
sys.argv = [script] + sys.argv[3:]
import subprocess, shutil, tempfile, threading, json, unicodedata, hashlib, stat, signal, re, math, time
sys.platform = plat
runpy.run_path(script, run_name="__main__")
`;
function runScript(py, script, osName, args, env, cwd) {
	return new Promise((resolve) => {
		const t0 = Date.now();
		const ch = spawn(py, ['-c', WRAPPER, script, PY_PLATFORM[osName], ...args], { env, cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
		let out = '', err = '', killed = false;
		ch.stdout.on('data', (d) => { out += d; }); ch.stderr.on('data', (d) => { err += d; });
		const timer = setTimeout(() => { killed = true; try { process.kill(-ch.pid, 'SIGKILL'); } catch {} }, BRIDGE_LIMIT_S * 1000 + 3000);
		ch.on('close', (rc) => { clearTimeout(timer); try { process.kill(-ch.pid, 'SIGKILL'); } catch {} resolve({ rc, out, err, killed, seconds: (Date.now() - t0) / 1000 }); });
		ch.on('error', (e) => { clearTimeout(timer); resolve({ rc: null, out, err: String(e), killed, seconds: (Date.now() - t0) / 1000 }); });
	});
}

const BAD_TEXT = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\u2028\u2029]/u;
function strings(v, p, out) { if (typeof v === 'string') out.push([p, v]); else if (Array.isArray(v)) v.forEach((x, i) => strings(x, `${p}[${i}]`, out)); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) strings(x, `${p}.${k}`, out); return out; }
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function checkRows(rows, manifestActions = 1) {
	const f = [], E = (code, message) => f.push({ level: 'error', code, message });
	for (const m of schemaCheck(rows, SCHEMA)) E('schema_invalid', m);
	if (!Array.isArray(rows)) return f;
	rows.forEach((r, i) => {
		if (!r || typeof r !== 'object') return;
		const acts = Array.isArray(r.actions) ? r.actions : [];
		if (acts.length > 3 - manifestActions) E('footer_too_many', `row ${i}: ${acts.length} footer buttons; the footer shows 3 including the ${manifestActions} from the manifest`);
		for (const a of acts) if (a && typeof a.label === 'string' && [...a.label].length > 14) E('label_too_long', `row ${i}: action label "${a.label.slice(0, 20)}" is over 14 characters and vanishes from the footer`);
		if (r.nav && acts.length) E('nav_with_actions', `row ${i}: a row with nav must not carry actions`);
		const tileText = ['kpi_label', 'kpi_unit', 'kpi_max', 'kpi_note', 'kpi_foot'].some((k) => r[k] !== undefined && r[k] !== '');
		if (tileText && !isNum(r.kpi_value)) E('tile_without_number', `row ${i}: a tile needs a numeric kpi_value (got ${JSON.stringify(r.kpi_value)}); the launcher shows "-" and "no value"`);
		if (r.kpi_value !== undefined && r.kpi_value !== '' && !isNum(r.kpi_value)) E('tile_not_numeric', `row ${i}: kpi_value must be a number`);
	});
	for (const [p, s] of strings(rows, '$', [])) {
		const allowNl = /\.(body|copy_text|copy_value|insert)$/.test(p);
		const bad = allowNl ? s.replace(/\n/g, '') : s;
		if (BAD_TEXT.test(bad)) E('text_unsafe', `${p}: control, format, bidi, zero-width, tag or separator character in output`);
		if (/\{\{|\}\}/.test(s) && !/\.(insert|url_template|query_template)$/.test(p)) E('text_braces', `${p}: "{{" or "}}" in row text can be expanded by the launcher`);
	}
	return f;
}

export async function checkApp(appDir, opts = {}) {
	const cfgFile = path.join(appDir, 'check.json');
	const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
	const host = hostOs();
	const report = { app: path.basename(path.resolve(appDir)), host_os: host, findings: [], cases: [] };
	const top = (level, code, message, p) => report.findings.push({ level, code, message, path: p });
	let listing = null;
	try { listing = JSON.parse(fs.readFileSync(path.join(appDir, 'bolt-app.json'), 'utf8')); } catch {}
	if (listing) for (const x of platformFindings(listing)) report.findings.push(x);
	report.findings.push(...kitGuard(appDir, cfg));
	if (host === 'windows') { top('error', 'host_unsupported', 'check v0.1 needs a POSIX host (sh stubs); run it on macOS or Linux', '.'); return report; }
	const py = cfg.interpreter ? whichSync(cfg.interpreter) : null;
	if (!py) { top('error', 'interpreter_missing', `${cfg.interpreter || 'interpreter'} was not found on this machine`, 'check.json'); return report; }
	const script = path.resolve(appDir, cfg.script);
	if (!fs.existsSync(script)) { top('error', 'script_missing', `${cfg.script} does not exist`, 'check.json'); return report; }
	let cases = cfg.cases || [];
	if (opts.os) { cases = cases.filter((c) => (c.os || host) === opts.os); if (!cases.length) { top('error', 'no_cases_for_os', `check.json has no case for ${opts.os}`, 'check.json'); return report; } }
	if (opts.only) cases = cases.filter((c) => c.name.includes(opts.only));
	if (!cases.length) top('error', 'no_cases', 'check.json lists no cases', 'check.json');
	for (const kase of cases) {
		const osName = kase.os || host, f = [], E = (code, message) => f.push({ level: 'error', code, message });
		let secs = 0;
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bolt-apps-check-'));
		const files = [];
		try {
			const stubDir = path.join(tmp, 'bin'), home = path.join(tmp, 'home');
			fs.mkdirSync(home);
			makeStubs(stubDir, appDir, osName, kase, files);
			const r = await runScript(py, script, osName, kase.args || [], { PATH: stubDir, HOME: home }, home);
			const ex = kase.expect || {};
			secs = r.seconds;
			const maxS = ex.max_seconds ?? DEFAULT_MAX_S;
			if (r.killed) E('deadline_exceeded', `the script was still running after ${BRIDGE_LIMIT_S} s (the bridge limit); a global deadline of 14 s must bound every command`);
			else if (r.seconds > maxS) E('deadline_exceeded', `took ${r.seconds.toFixed(1)} s; this case allows ${maxS} s`);
			if (r.rc !== (ex.exit ?? 0)) E('exit_code', `exit ${r.rc}, expected ${ex.exit ?? 0}${r.err ? `; stderr: ${r.err.trim().split('\n').pop().slice(0, 160)}` : ''}`);
			let rows = null;
			try { rows = JSON.parse(r.out); } catch { E('non_json_output', `stdout is not JSON (${r.out.length} bytes)`); }
			if (rows !== null) {
				for (const x of checkRows(rows, cfg.manifest_actions ?? 1)) f.push(x);
				if (/[^\x00-\x7f]/.test(r.out)) f.push({ level: 'warning', code: 'non_ascii_output', message: 'stdout has non-ASCII bytes; ensure_ascii JSON is safe on any console code page' });
				const flat = strings(rows, '$', []).map(([, s]) => s).join('\n');
				for (const t of ex.text_present || []) if (!flat.includes(t)) E('expected_text_missing', `output does not contain "${t}"`);
				for (const t of ex.text_absent || []) if (flat.includes(t)) E('forbidden_text_present', `output contains "${t}"`);
				if (kase.golden) {
					const gp = path.join(appDir, kase.golden);
					if (opts.updateGolden) { fs.mkdirSync(path.dirname(gp), { recursive: true }); fs.writeFileSync(gp, JSON.stringify(rows, null, 2) + '\n'); }
					else if (!fs.existsSync(gp)) E('golden_missing', `${kase.golden} does not exist (run with --update-golden once, then review it)`);
					else if (!deepEq(JSON.parse(fs.readFileSync(gp, 'utf8')), rows)) E('golden_mismatch', `output differs from ${kase.golden}`);
				}
			}
		} catch (e) { E('check_error', String(e.message || e)); }
		finally { fs.rmSync(tmp, { recursive: true, force: true }); }
		const tested = osName === host ? 'stubbed commands on this OS, not the real launcher' : `fixtures only: ${osName} behaviour was not run on a ${osName} machine`;
		report.cases.push({ name: kase.name, os: osName, seconds: Number(secs.toFixed(2)), ok: !f.some((x) => x.level === 'error'), tested, findings: f });
	}
	return report;
}

function whichSync(name) {
	if (path.isAbsolute(name)) return fs.existsSync(name) ? name : null;
	for (const d of (process.env.PATH || '').split(path.delimiter)) { const p = path.join(d, name); try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch {} }
	return null;
}
export const reportOk = (r) => !r.findings.some((x) => x.level === 'error') && r.cases.every((c) => c.ok);
export function formatReport(r) {
	const L = [`${reportOk(r) ? 'PASS' : 'FAIL'}  ${r.app}  (host ${r.host_os})`];
	for (const f of r.findings) L.push(`  ${f.level} ${f.code}: ${f.message}`);
	for (const c of r.cases) { L.push(`  ${c.ok ? 'ok  ' : 'FAIL'} [${c.os}] ${c.name}`); for (const f of c.findings) L.push(`       ${f.level} ${f.code}: ${f.message}`); }
	const fx = [...new Set(r.cases.filter((c) => c.os !== r.host_os).map((c) => c.os))];
	L.push('', fx.length ? `Fixture-tested only: ${fx.join(', ')}. That logic was not run on those systems.` : 'All cases ran with stubbed commands on this OS. Not run: the real launcher, Windows, other OS tools.');
	return L.join('\n');
}
