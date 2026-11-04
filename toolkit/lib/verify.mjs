// bolt-apps verify: the checks Bolt runs when a pack is dropped, run offline before anything is installed.
// Rules come from schema/install-rules.json (a data mirror of bolt-native user_utilities/contract.rs, pack_validate.rs
// and pack_install.rs). The YAML is read with plain text rules, not Bolt's parser, so a pass here means "none of the
// known ways to fail were found", and Bolt still parses the file itself. See docs/verify-rules.md.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assessYaml, plainPermission, plainName, scriptRefs } from './assess.mjs';
import { get, str } from './yamlsubset.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const RULES = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'schema', 'install-rules.json'), 'utf8'));
const R = RULES.contract, P = RULES.pack;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// Every code verify can emit, with the fix in plain words. A test keeps this table and the conformance cases equal.
export const FIXES = {
	pack_not_gzip_tar: 'The file is not a .boltpack. Build it again with: bolt-apps pack <folder> --personal',
	bundle_missing: 'The pack has no bundle.json. Build it again with bolt-apps pack.',
	bundle_not_json: 'bundle.json is damaged. Build the pack again with bolt-apps pack.',
	signature_missing: 'The pack is not signed. Build it with bolt-apps pack (run bolt-apps keygen once first).',
	signed_by_other_key: 'This pack carries no author key, so only Bolt can check it. Nothing to fix if Sparcle or your company signed it.',
	signature_mismatch: 'bundle.json was edited after signing. Build the pack again with bolt-apps pack; never edit a pack by hand.',
	content_hash_mismatch: 'Files inside the pack changed after signing. Change the app folder, then run bolt-apps pack again.',
	entry_hash_mismatch: 'A file in the pack does not match its signed hash. Build the pack again with bolt-apps pack.',
	bundle_schema_version: `bundle.json schema_version must be ${P.bundle_schema_version}. Build the pack with the current bolt-apps.`,
	too_many_files: `A pack may hold at most ${P.max_entries} files. Remove files you do not need.`,
	pack_too_large: 'The pack unpacks to more than 64 MB. Remove large files; an app is small text and scripts.',
	entry_outside_manifests: 'Every file Bolt installs must be listed under manifests/. Build the pack with bolt-apps pack instead of by hand.',
	entry_path_not_plain: 'Use only letters, digits, . _ and - in folder and file names (no spaces, no leading or trailing dot, no Windows device names such as CON or NUL, at most 128 characters per name). Rename the file.',
	entry_kind_skipped: 'Dropping a pack on the launcher installs User Apps and scripts only. Install snippets and search engines from Bolt Apps instead.',
	entry_kind_unknown: 'Bolt does not install this kind of file from a pack. Remove it from the app folder.',
	file_not_listed: 'The pack holds a file bundle.json does not list; Bolt ignores it. Build the pack again with bolt-apps pack.',
	script_case: 'Two script paths differ only in capital letters, so one would replace the other on macOS and Windows. Rename one.',
	script_too_deep: 'Scripts may be at most 8 folders deep.',
	script_conflict: 'A name is used both as a file and as a folder in scripts/. Rename one.',
	script_name: 'Use only letters, digits, . _ and - in script names, with no leading or trailing dot. Rename the script.',
	script_missing: 'The app file runs a script that is not in the pack. Add the file to scripts/ or fix the name after {{scripts_dir}}/.',
	script_unused: 'No app file runs this script. Remove it or reference it as {{scripts_dir}}/<name> in the command.',
	script_no_shebang: 'The command runs the script directly but it does not start with #!. Put the interpreter in the command (python3 {{scripts_dir}}/x.py) or add a #! first line.',
	script_path_relative: 'Bolt runs the command in a fresh empty folder, so a relative path to a script finds nothing. Write the path as {{scripts_dir}}/<name>.',
	yaml_key_unknown: 'Bolt refuses a key it does not know and the app fails to load. Remove it or fix the spelling.',
	yaml_key_missing: 'Add this required key.',
	yaml_admin_only_key: 'This key is for company-managed apps only and Bolt refuses it in a user app. Remove it.',
	schema_version_unsupported: `Set schema_version to ${R.schema_versions.join(' or ')}.`,
	runtime_not_allowed: `Set runtime to one of: ${R.runtimes.join(', ')}.`,
	id_invalid: 'Use lowercase letters, digits and hyphens, starting with a letter or digit, at most 64 characters.',
	chip_invalid: 'The chip is the key typed after =. Use lowercase letters, digits and hyphens, at most 64 characters.',
	title_empty: 'Give the app a title.',
	emits_not_allowed: `Set emits to one of: ${R.emits.join(', ')} (Generic is the safe choice).`,
	widget_not_allowed: `Set presentation.widget to one of: ${R.widgets.join(', ')}.`,
	block_missing: 'The runtime needs its own block: bridge needs a bridge: block, http_local an http: block, transform a transform: block. Add it.',
	block_not_allowed: 'This runtime must not carry the other runtime\'s block. Remove it.',
	command_missing: 'bridge.command must give a command for at least one of macos, linux, windows.',
	command_not_argv: 'The command has an unbalanced quote or a trailing backslash. Balance the quotes.',
	command_shell_operator: 'Bolt runs the command as one program with arguments, not through a shell. Remove ; && || | ` and $( , and put multi-step logic in a script file the command calls.',
	command_placeholder_malformed: 'A {{variable}} is not closed or its name is wrong. Write it as {{name}} with two closing braces.',
	command_variable_in_quotes: 'Remove the quotes around the {{variable}}. Bolt quotes variables itself; your quotes become literal characters and break the path on macOS. Write: python3 {{scripts_dir}}/x.py',
	parse_not_allowed: `Set bridge.parse to one of: ${R.parse.join(', ')}.`,
	timeout_out_of_range: `Set bridge.timeout_seconds between ${R.timeout_seconds[0]} and ${R.timeout_seconds[1]}.`,
	env_inline_value: 'A bridge.env value must be exactly ${env:NAME} (the name of a variable you pass through). Inline values are not allowed.',
	args_from_unsupported: 'args[].from must be query.word(N), for example query.word(0).',
	http_host_not_loopback: `http.host must be one of: ${R.http_hosts.join(', ')}.`,
	http_method_not_allowed: `http.request.method must be one of: ${R.http_methods.join(', ')}.`,
	http_path_invalid: 'http.request.path must start with /.',
	action_not_allowed: `Set the action kind to one of: ${R.action_kinds.join(', ')}.`,
	app_file_name: 'Use only letters, digits, . _ and - in the file name. Rename the file.',
	unknown_file: 'Only bolt-app.json, README.md, snippets/, search_engines/, utilities/ and scripts/ are packed. Move or delete this.',
	listing_unreadable: 'Fix bolt-app.json so it is a JSON object.',
	field_missing: 'Add the missing field.',
	empty_app: 'Add at least one User App file in utilities/.',
	bad_json: 'Fix the JSON in this file.',
	permission_unknown: 'Remove or rename this permission.',
	yaml_unreadable_here: 'Write the file in plain YAML that this tool can read: unquoted top-level keys, one value per line, no anchors, aliases, tags or block scalars (| >), no escapes other than \\" and \\\\ in double quotes, no duplicate keys. Until then the tier and permissions below are unknown, not low.',
	pack_malformed: 'The archive is damaged or hand-made badly (bad file size or header). Build the pack again with bolt-apps pack.',
	pack_duplicate_entry: 'The archive lists the same file name twice. Build the pack again with bolt-apps pack.',
};
const fixFor = (code) => FIXES[code] || 'See the message.';
const mk = (level, code, message, file, line) => ({ level, code, message, file, ...(line ? { line } : {}), fix: fixFor(code) });

const stripPlaceholders = (cmd) => { let out = '', rest = cmd; for (;;) { const i = rest.indexOf('{{'); if (i < 0) return out + rest; out += rest.slice(0, i); const j = rest.indexOf('}}', i + 2); if (j < 0) return out; rest = rest.slice(j + 2); } };
// Port of contract.rs validate_command_placeholders and validate_argv_template. Returns [code, message] or null.
export function commandProblem(os, cmd) {
	const f = `bridge.command.${os}`;
	if (!cmd.trim()) return ['command_missing', `${f} must be non-empty`];
	let q = null, bs = false;
	for (let i = 0; i < cmd.length; i++) { const c = cmd[i]; if (bs) { bs = false; continue; } if (c === '\\' && q !== "'") bs = true; else if (q) { if (c === q) q = null; } else if (c === '"' || c === "'") q = c; }
	if (q || bs) return ['command_not_argv', `${f} is not argv-splittable (unbalanced quote or trailing backslash)`];
	const audited = stripPlaceholders(cmd);
	for (const n of R.forbidden_shell) if (audited.includes(n)) return ['command_shell_operator', `${f} contains the shell character ${n}; Bolt runs one program, not a shell`];
	let inS = false, inD = false;
	for (let i = 0; i < cmd.length; i++) {
		const c = cmd[i];
		if (c === '{' && cmd[i + 1] === '{') {
			const close = cmd.indexOf('}}', i + 2);
			if (close < 0) return ['command_placeholder_malformed', `${f} has an unterminated {{ (missing }})`];
			const inner = cmd.slice(i + 2, close).trim(), name = inner.split('|')[0].trim();
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return ['command_placeholder_malformed', `${f} has a malformed variable {{${inner}}} (check for a missing brace, such as {{scripts_dir} instead of {{scripts_dir}})`];
			if (inS || inD) return ['command_variable_in_quotes', `${f} puts {{${name}}} inside ${inS ? 'single' : 'double'} quotes; Bolt quotes variables itself`];
			i = close + 1; continue;
		}
		if (c === "'" && !inD) inS = !inS; else if (c === '"' && !inS) inD = !inD;
		else if (c === '\\' && !inS && /["'\\]/.test(cmd[i + 1] || '')) i++;
	}
	return null;
}

// files: [{ path: 'utilities/x.yaml' | 'scripts/x.py', kind, content: Buffer }]
export function checkManifests(files) {
	const findings = [], apps = [], add = (...a) => findings.push(mk(...a));
	const scripts = new Map(files.filter((f) => f.kind === 'script').map((f) => [f.path.replace(/^scripts\//, ''), f.content]));
	const used = new Set();
	let unknownAssess = false;
	const seenPaths = new Map(), allScripts = files.filter((x) => x.kind === 'script').map((f) => f.path.replace(/^scripts\//, ''));
	for (const f of files.filter((x) => x.kind === 'script')) {
		const rel = f.path.replace(/^scripts\//, ''), parts = rel.split('/');
		if (parts.length > 9) add('error', 'script_too_deep', `${f.path} is more than 8 folders deep`, f.path);
		else if (!parts.every((s) => plainName(s))) add('error', 'script_name', `script path "${rel}" has characters or a shape Bolt refuses`, f.path);
		if (seenPaths.has(rel.toLowerCase()) && seenPaths.get(rel.toLowerCase()) !== rel) add('error', 'script_case', `${f.path} and scripts/${seenPaths.get(rel.toLowerCase())} differ only in capital letters`, f.path);
		seenPaths.set(rel.toLowerCase(), rel);
		if (allScripts.some((o) => o.toLowerCase().startsWith(rel.toLowerCase() + '/'))) add('error', 'script_conflict', `${f.path} is both a file and a folder`, f.path);
	}
	for (const f of files.filter((x) => x.kind === 'user_utility')) {
		const y = f.content.toString('utf8'), file = f.path;
		const a = assessYaml(y, path.basename(file).replace(/\.[^.]+$/, '')); apps.push({ ...a, file });
		for (const r of a.refs) used.add(r);
		if (a.unknown) { add('error', 'yaml_unreadable_here', `this tool cannot interpret ${a.why}; Bolt may read it differently`, file, 1); unknownAssess = true; continue; }
		const root = a.tree, E = (code, msg, line) => add('error', code, msg, file, line || 1);
		const val = (m, k) => get(m, k)?.value, S = (m, k) => str(val(m, k)), ln = (m, k, d) => get(m, k)?.line ?? d;
		for (const e of root.entries) {
			if (!R.top_level_keys.includes(e.key)) E('yaml_key_unknown', `unknown key "${e.key}"; Bolt refuses the whole file`, e.line);
			else if (R.admin_only_keys.includes(e.key)) E('yaml_admin_only_key', `"${e.key}" is for company-managed apps and is not allowed in a user app`, e.line);
		}
		for (const k of R.required_keys) if (!get(root, k)) E('yaml_key_missing', `missing required key "${k}"`, 1);
		if (get(root, 'schema_version') && !R.schema_versions.includes(Number(S(root, 'schema_version')))) E('schema_version_unsupported', `schema_version ${S(root, 'schema_version')} is not supported`, ln(root, 'schema_version'));
		const rt = S(root, 'runtime'); if (get(root, 'runtime') && !R.runtimes.includes(rt)) E('runtime_not_allowed', `runtime "${rt}" is not accepted`, ln(root, 'runtime'));
		const idRe = new RegExp(R.id_pattern);
		if (get(root, 'id') && !idRe.test(S(root, 'id') ?? '')) E('id_invalid', `id "${S(root, 'id')}" is not lowercase-kebab`, ln(root, 'id'));
		if (get(root, 'chip') && !idRe.test(S(root, 'chip') ?? '')) E('chip_invalid', `chip "${S(root, 'chip')}" is not lowercase-kebab`, ln(root, 'chip'));
		if (get(root, 'title') && !(S(root, 'title') ?? '').trim()) E('title_empty', 'title is empty', ln(root, 'title'));
		if (get(root, 'emits') && !R.emits.includes(S(root, 'emits'))) E('emits_not_allowed', `emits "${S(root, 'emits')}" is not one of the kinds Bolt knows`, ln(root, 'emits'));
		const pres = val(root, 'presentation'), wg = S(pres, 'widget'); if (wg !== undefined && !R.widgets.includes(wg)) E('widget_not_allowed', `presentation.widget "${wg}" is not accepted`, ln(pres, 'widget', ln(root, 'presentation')));
		const bridge = val(root, 'bridge'), http = val(root, 'http');
		if (rt === 'bridge') {
			if (!bridge) E('block_missing', 'runtime: bridge needs a bridge: block', ln(root, 'runtime'));
			if (http) E('block_not_allowed', 'runtime: bridge must not have an http: block', ln(root, 'http'));
		} else if (rt === 'http_local') {
			if (!http) E('block_missing', 'runtime: http_local needs an http: block', ln(root, 'runtime'));
			if (bridge) E('block_not_allowed', 'runtime: http_local must not have a bridge: block', ln(root, 'bridge'));
			const hl = ln(root, 'http'), host = S(http, 'host'); if (host !== undefined && !R.http_hosts.includes(host)) E('http_host_not_loopback', `http.host "${host}" is not a loopback address`, ln(http, 'host', hl));
			const req = val(http, 'request'), m = S(req, 'method'); if (m !== undefined && !R.http_methods.includes(m.toUpperCase())) E('http_method_not_allowed', `http.request.method "${m}" is not accepted`, ln(req, 'method', hl));
			const pa = S(req, 'path'); if (pa !== undefined && !pa.startsWith('/')) E('http_path_invalid', 'http.request.path must start with /', ln(req, 'path', hl));
		} else if (rt === 'transform') {
			if (!get(root, 'transform')) E('block_missing', 'runtime: transform needs a transform: block', ln(root, 'runtime'));
			if (bridge || http) E('block_not_allowed', 'runtime: transform must not have a bridge: or http: block', ln(root, bridge ? 'bridge' : 'http'));
		}
		if (bridge) {
			const bl = ln(root, 'bridge'), cm = val(bridge, 'command'), cmds = ['macos', 'linux', 'windows'].filter((o) => S(cm, o) !== undefined);
			if (rt === 'bridge' && !cmds.length) E('command_missing', 'bridge.command defines none of macos, linux, windows', ln(bridge, 'command', bl));
			for (const o of cmds) {
				const cmd = S(cm, o), cl = ln(cm, o, ln(bridge, 'command', bl)), prob = commandProblem(o, cmd);
				if (prob) E(prob[0], prob[1], cl);
				for (const r of scriptRefs(cmd)) used.add(r);
				for (const t of cmd.split(/\s+/).filter(Boolean).slice(0, 2).filter((x) => !x.includes('{{'))) if (/\.(py|sh|js|mjs|rb|ps1)$/.test(t) && !/^([/~]|[A-Za-z]:\\)/.test(t)) E('script_path_relative', `${o} command names ${t} without {{scripts_dir}}; Bolt runs it in a fresh empty folder`, cl);
				const direct = /^\s*\{\{\s*scripts_dir\s*\}\}[/\\]([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)/.exec(cmd);
				if (o !== 'windows' && direct && scripts.has(direct[1]) && !scripts.get(direct[1]).subarray(0, 2).equals(Buffer.from('#!'))) E('script_no_shebang', `${o} command runs scripts/${direct[1]} directly but the file has no #! line`, cl);
			}
			const pr = S(bridge, 'parse'); if (pr !== undefined && !R.parse.includes(pr)) E('parse_not_allowed', `bridge.parse "${pr}" is not accepted`, ln(bridge, 'parse', bl));
			const to = S(bridge, 'timeout_seconds'); if (to !== undefined && !(Number.isInteger(Number(to)) && Number(to) >= R.timeout_seconds[0] && Number(to) <= R.timeout_seconds[1])) E('timeout_out_of_range', `bridge.timeout_seconds ${to} is outside ${R.timeout_seconds.join(' to ')}`, ln(bridge, 'timeout_seconds', bl));
			const env = val(bridge, 'env'); if (env && env.t === 'm') for (const e of env.entries) if (e.value.t !== 's' || !/^\$\{env:[A-Z][A-Z0-9_]{0,63}\}$/.test(e.value.v)) E('env_inline_value', `bridge.env.${e.key} value must be exactly \${env:NAME}`, e.line ?? ln(bridge, 'env', bl));
		}
		const args = val(root, 'args'); for (const it of args?.items || []) { const fr = S(it, 'from'); if (fr !== undefined && !/^query\.word\(\s*\d+\s*\)$/.test(fr.trim())) E('args_from_unsupported', `args[].from "${fr}" is not supported`, ln(root, 'args')); }
		for (const pr of a.problems.filter((x) => x.code !== 'runtime_not_allowed')) E(pr.code, pr.message, pr.code === 'runtime_not_allowed' ? ln(root, 'runtime') : ln(root, 'actions'));
	}
	for (const r of used) if (!scripts.has(r)) add('error', 'script_missing', `an app runs {{scripts_dir}}/${r} but the pack has no scripts/${r}`, `scripts/${r}`);
	for (const n of scripts.keys()) if (!used.has(n)) add('warning', 'script_unused', `scripts/${n} is not run by any app file`, `scripts/${n}`);
	return { findings: dedupe(findings), apps, unknownAssess };
}
const dedupe = (fs_) => { const seen = new Set(); return fs_.filter((f) => { const k = `${f.code}|${f.file}|${f.message}`; if (seen.has(k)) return false; seen.add(k); return true; }); };

// What Bolt shows in its confirm, recomputed from the files.
export function confirmPreview({ apps, files, scriptsList, signer, unknownAssess = false }) {
	const tier = Math.max(1, ...apps.map((a) => a.tier), scriptsList.length ? 3 : 1);
	const perms = new Set(apps.flatMap((a) => a.permissions)); if (scriptsList.length) perms.add('runs_commands');
	const reasons = [...apps.flatMap((a) => a.reasons), ...scriptsList.map((s) => `the pack includes a script (${s})`)];
	return {
		tier: unknownAssess ? 'unknown' : tier, risk: unknownAssess ? 'unknown' : tier >= 3 ? 'high' : tier === 2 ? 'medium' : 'low', estimate: true,
		permissions: [...perms].sort().map((id) => ({ id, text: plainPermission(id) })), reasons,
		apps: apps.map((a) => ({ id: a.id, tier: a.tier })), files: files.map((f) => ({ path: f.path, kind: f.kind, sha256: sha(f.content) })),
		signer, note: 'This is an estimate. Bolt reads the files itself at install and may rate them higher. Bolt asks the installer to confirm. A device whose company policy allows only approved apps refuses a pack signed only by its author.',
	};
}

// Checks on a pack's own listing, mirroring pack_validate.rs and the verifier.
export function checkPackShape(meta, man, count) {
	const out = [], add = (...a) => out.push(mk(...a)), P_ = P;
	if (meta.schema_version !== P_.bundle_schema_version) add('error', 'bundle_schema_version', `bundle.json schema_version is ${meta.schema_version}`, 'bundle.json');
	if (count > P_.max_entries) add('error', 'too_many_files', `the pack holds ${count} entries`, 'bundle.json');
	if ([...man.values()].reduce((n, c) => n + c.length, 0) > P_.max_unpacked_bytes) add('error', 'pack_too_large', 'the pack unpacks to more than 64 MB', 'bundle.json');
	const listed = new Set();
	for (const e of meta.entries || []) {
		const p = String(e.path); listed.add(p);
		const rel = p.startsWith('manifests/') ? p.slice(10) : null;
		if (rel === null) { add('error', 'entry_outside_manifests', `${p} is not under manifests/`, p); continue; }
		if (rel.length > P_.max_entry_path_chars || !rel.split('/').every((s) => plainName(s))) add('error', 'entry_path_not_plain', `${p} has a name Bolt refuses`, p);
		if (P_.installed_kinds.includes(e.kind)) continue;
		add('warning', P_.skipped_kinds.includes(e.kind) ? 'entry_kind_skipped' : 'entry_kind_unknown', `${p} is a ${e.kind}; the launcher drop does not install it`, p);
	}
	for (const k of man.keys()) if (!listed.has(`manifests/${k}`)) add('warning', 'file_not_listed', `manifests/${k} is in the pack but bundle.json does not list it`, `manifests/${k}`);
	return out;
}
