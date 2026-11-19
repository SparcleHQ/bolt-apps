// ./bolt-apps verify: the checks Bolt runs when a pack is dropped, run offline before anything is installed.
// Rules come from schema/install-rules.json (a data mirror of the launcher's install rules). The YAML is read with plain text rules, not Bolt's parser, so a pass here means "none of the
// known ways to fail were found", and Bolt still parses the file itself. See docs/verify-rules.md.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chipMismatch, assessYaml, plainPermission, plainName, scriptRefs, dataFilesUsed, scanMentions, declaredHostsOf, escapeProblem, MAX_HASHED_FILE_BYTES } from './assess.mjs';
import { get, str, notYamlHint } from './yamlsubset.mjs';
import { layoutProblems, namespaceProblems, RULES as BOLT_RULES } from './boltrules.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const RULES = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'schema', 'install-rules.json'), 'utf8'));
const R = RULES.contract, P = RULES.pack;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// Every code verify can emit, with the fix in plain words. A test keeps this table and the conformance cases equal.
export const FIXES = {
	pack_not_gzip_tar: 'The file is not a .boltpack. Build it again with: ./bolt-apps pack <folder> --personal',
	bundle_missing: 'The pack has no bundle.json. Build it again with ./bolt-apps pack.',
	bundle_not_json: 'bundle.json is damaged. Build the pack again with ./bolt-apps pack.',
	signature_missing: 'The pack is not signed. Build it with ./bolt-apps pack (run ./bolt-apps keygen once first).',
	signed_by_other_key: 'This pack carries no author key, so only Bolt can check it. Nothing to fix if Sparcle or your company signed it.',
	signature_mismatch: 'bundle.json was edited after signing. Build the pack again with ./bolt-apps pack; never edit a pack by hand.',
	content_hash_mismatch: 'Files inside the pack changed after signing. Change the app folder, then run ./bolt-apps pack again.',
	entry_hash_mismatch: 'A file in the pack does not match its signed hash. Build the pack again with ./bolt-apps pack.',
	bundle_schema_version: `bundle.json schema_version must be ${P.bundle_schema_version}. Build the pack with the current bolt-apps.`,
	too_many_files: `A pack may hold at most ${P.max_entries} files. Remove files you do not need.`,
	pack_too_large: 'The pack unpacks to more than 64 MB. Remove large files; an app is small text and scripts.',
	entry_outside_manifests: 'Every file Bolt installs must be listed under manifests/. Build the pack with ./bolt-apps pack instead of by hand.',
	entry_path_not_plain: 'Use only letters, digits, . _ and - in folder and file names (no spaces, no leading or trailing dot, no Windows device names such as CON or NUL, at most 128 characters per name). Rename the file.',
	entry_kind_skipped: 'Dropping a pack on the launcher installs User Apps and scripts only. Install snippets and search engines from Bolt Apps instead.',
	entry_kind_unknown: 'Bolt does not install this kind of file from a pack. Remove it from the app folder.',
	file_not_listed: 'The pack holds a file bundle.json does not list; Bolt ignores it. Build the pack again with ./bolt-apps pack.',
	script_not_namespaced: 'Rename the file to <app id>__<name> (for example pulse-feed__engine.py), and write the same name after {{scripts_dir}}/ in the app file. Every app shares one scripts folder, so a bare name like bolt_app_kit.py or config.json stops a second app installing. ./bolt-apps new does it for new apps. Apps built before this change: remove the old app in Bolt (Settings, User Apps, Remove), run ./bolt-apps new <template> <id>, then copy your own config.json and fixtures.json over the new ones and re-run ./bolt-apps check.',
	chip_not_id: 'Bolt only runs an app whose chip equals its id: the launcher looks apps up by id, so a different chip is offered in the launcher but never runs (an empty list, no error). Set chip to the id, in the app file (and in config.json if the app file is generated from it).',
	description_chip_mismatch: 'Change the description (or placeholder_examples) so the =word it tells the person to type is this app\'s chip, or remove the =word.',
	script_depth: 'Use at most 8 folder levels under scripts/.',
	script_path: 'Remove the . or .. part from the script path.',
	script_case_clash: 'Rename one of the two files so they differ by more than letter case.',
	script_file_folder: 'Rename the file or the folder so one name is not both.',
	unknown_field: 'Remove the field, or fix its spelling: the launcher refuses an app file with a field it does not know (it names the allowed fields).',
	missing_field: 'Add the required field named in the message.',
	bind_invalid: 'Fix the bind value as the message says (type, list or enum).',
	env_passthrough_max: 'List at most 16 names in env_passthrough.',
	env_name: 'Use an uppercase name of letters, digits and _.',
	env_secret_name: 'Remove it: keys belong in the keychain or ~/.config/<id>/.env, read inside the script.',
	env_not_allowed: 'Use only a variable on the launcher\'s benign list, or read the value another way.',
	timeout_default: 'Set bridge.timeout_seconds (1 to 60) so a slow app is not stopped at 10 seconds.',
	http_port: 'Use a port from 1 to 65535.',
	http_port_reserved: 'Pick a port outside 13017-13027 and 15432-15441.',
	http_parse: 'Use json, lines or raw.',
	action_id: 'Use a plain id of letters, digits, _ and -, not repeated.',
	action_kind: 'Use url, composer, utility or run.',
	action_field: 'Add the field this action kind needs.',
	action_primary: 'Mark at most one action primary.',
	action_icon: 'Use one of the 37 footer icon names the message lists.',
	action_label_reserved: 'Use a label that is not one of the launcher\'s reserved words.',
	action_url: 'Write a literal host after https://.',
	action_url_port: 'Use the https default port, or declare the site in bolt-app.json permissions as opens_links:host:port.',
	action_admin_only: 'Remove flow and confirm: they are for admin-provisioned apps.',
	input_type: 'Use text, number, date, select, toggle or secret.',
	bridge_cwd: 'Use home, or leave cwd out.',
	env_passthrough_duplicate: 'List each name once.',
	http_header: 'Use a letters, digits and - header name, and ${env:NAME} only for a benign-list name.',
	action_url_internal: 'Link to a public address, not a local or private one.',
	view_arg_index: 'Bind the view to an earlier query word (0 to 8).',
	script_name: 'Use only letters, digits, . _ and - in script names, with no leading or trailing dot. Rename the script.',
	script_missing: 'The app file runs a script that is not in the pack. Add the file to scripts/ or fix the name after {{scripts_dir}}/.',
	script_unused: 'No app file runs this script. Remove it or reference it as {{scripts_dir}}/<name> in the command.',
	script_no_shebang: 'The command runs the script directly but it does not start with #!. Put the interpreter in the command (python3 {{scripts_dir}}/x.py) or add a #! first line.',
	script_path_relative: 'Bolt runs the command in a fresh empty folder, so a relative path to a script finds nothing. Write the path as {{scripts_dir}}/<name>.',
	yaml_key_unknown: 'Bolt refuses a key it does not know and the app fails to load. Remove it or fix the spelling.',
	yaml_key_missing: 'Add this required key.',
	yaml_admin_only_key: 'This key is for company-managed apps only and Bolt refuses it in a user app. Remove it.',
	transform_step_unknown: 'Use a step name listed for transform.pipe in schema/user-app.schema.json: a plain name such as trim or lines, or a mapping with exactly one listed key such as { split: "," }. Only the name is checked here; Bolt checks the value.',
	transform_pipe_count: 'Give transform.pipe at least 1 step and no more than schema/user-app.schema.json allows; split a longer job into two apps.',
	recognize_patterns_count: 'Give recognize.patterns at least 1 entry and no more than schema/user-app.schema.json allows; merge patterns with | inside one regex.',
	recognize_regex_too_long: 'Shorten the regex to the length schema/user-app.schema.json allows, for example by splitting it into two patterns.',
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
	pack_malformed: 'The archive is damaged or hand-made badly (bad file size or header). Build the pack again with ./bolt-apps pack.',
	views_too_many: 'Bolt allows at most 8 views including the overview, and refuses the whole file otherwise. Merge or drop views.',
	view_name_invalid: 'A view name is lowercase, starts with a letter, uses letters, digits, _ and -, at most 24 characters, and is not constructor or prototype. Rename it.',
	view_arg_missing: 'Add presentation.view_arg naming the arg whose value selects the view (for example view_arg: view).',
	view_arg_unknown: 'presentation.view_arg must name an entry in args. Fix the name or add the arg.',
	view_arg_not_query_word: 'Bind the view arg with from: "query.word(N)" (for example { name: view, from: "query.word(0)", default: overview }).',
	view_arg_lead_default: 'Give the arg bound to each query word before the view word a default that is a plain word such as overview or all (letters, digits, _ . -). A default like - makes every drill and Back row do nothing. Or bind the view to query.word(0).',
	view_arg_without_views: 'Add presentation.views, or remove presentation.view_arg.',
	yaml_escape: 'Bolt will not run a file with \\x, \\u or \\U escapes or a backslash before a line break. Write the character itself, or rephrase.',
	command_os_missing: 'Add a command for that system, or list only the systems the app supports under platforms in bolt-app.json. This is a warning: the app simply cannot run there.',
	right_widget_no_data: 'Use table, detail, cards or chart (image_grid for pictures). Bolt shows a plain "cannot show app data" message for image, color, weather, date and calc panes.',
	right_widget_kind_invalid: 'Use a right_widget kind and mode Bolt accepts: kinds card, map, markdown, entity_preview, chart, table, cards, detail, json_tree, diff, image_grid (and the data-less image, color, weather, date, calc); modes selected_row or list_data.',
	right_widget_bind_unread: 'Remove the bind key: the map, image, calc, color, weather and date panes read nothing from bind. For a chart, type is line, bar or sparkline.',
	bind_needs_newer_bolt: 'Set "min_bolt_version": "0.1.182" in bolt-app.json to confirm you give the pack only to people on Bolt 182 or newer, or remove the bind key. Bolt does not read that field and cannot hold the pack back; a Bolt 181 refuses the whole pack when one app uses a key it does not know.',
	bind_too_many_refs: 'hero.src may join at most 16 {{ }} references; Bolt draws no picture past that. Use a smaller picture so it fits in 16 parts or fewer (kit.hero_fields refuses a bigger one).',
	hero_src_not_picture: 'Set hero.src to {{row.<field>}} joined from the row fields that hold the picture, or to a data:image URI. A pane never loads a web address.',
	run_action_template: 'Give the run action a fixed query_template with no {{ }} (for example refresh), or remove the action.',
	script_too_large: 'Bolt hashes a script only up to 2 MB and will not run an app that names a larger file. Keep scripts small; put big data outside the app.',
	helper_not_hashed: 'Name the file in the command (for example python3 {{scripts_dir}}/my-app__engine.py {{scripts_dir}}/my-app__config.json). Bolt\'s approval hash covers only the manifest and the scripts named as {{scripts_dir}}/<file>, so an unnamed helper can change without asking again.',
	pack_duplicate_entry: 'The archive lists the same file name twice. Build the pack again with ./bolt-apps pack.',
};
const fixFor = (code) => FIXES[code] || 'See the message.';
const mk = (level, code, message, file, line) => ({ level, code, message, file, ...(line ? { line } : {}), fix: fixFor(code) });

const stripPlaceholders = (cmd) => { let out = '', rest = cmd; for (;;) { const i = rest.indexOf('{{'); if (i < 0) return out + rest; out += rest.slice(0, i); const j = rest.indexOf('}}', i + 2); if (j < 0) return out; rest = rest.slice(j + 2); } };
// Port of the launcher validate_command_placeholders and validate_argv_template. Returns [code, message] or null.
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
export function checkManifests(files, opts = {}) {
	const findings = [], apps = [], add = (...a) => findings.push(mk(...a));
	const scripts = new Map(files.filter((f) => f.kind === 'script').map((f) => [f.path.replace(/^scripts\//, ''), f.content]));   // keyed by the path under scripts/, so two files with one name cannot shadow each other
	const used = new Set();
	let unknownAssess = false;
	for (const lp of layoutProblems([...files.filter((x) => x.kind === 'script').map((x) => x.path.replace(/^scripts\//, ''))])) add('error', lp.code, lp.message, 'scripts');
	for (const np of namespaceProblems(files.filter((x) => x.kind === 'script').map((x) => x.path.replace(/^scripts\//, '')), opts.appId)) add('error', np.code, np.message, `scripts/${np.file}`);
	for (const f of files.filter((x) => x.kind === 'script')) {
		const rel = f.path.replace(/^scripts\//, '');
		if (!rel.split('/').every(plainName)) add('error', 'script_name', `script name "${rel.slice(0, 60)}" ${rel.split('/').some((s) => s.length > 128) ? 'is longer than 128 characters (Bolt allows 128 per name, and every file starts with <app id>__, which counts)' : 'has characters or a shape Bolt refuses'}`, f.path);
	}
	for (const f of files.filter((x) => x.kind === 'user_utility')) {
		const y = f.content.toString('utf8'), file = f.path;
		const esc_ = escapeProblem(y); if (esc_) add('error', esc_.code, esc_.message, file, 1);
		const a = assessYaml(y, path.basename(file).replace(/\.[^.]+$/, ''), { platforms: opts.platforms, platformsUnknown: opts.platformsUnknown, pack: true, minBolt: opts.minBolt, minBoltKnown: opts.minBoltKnown }); apps.push({ ...a, file });
		for (const r of a.refs) used.add(r);
		if (a.unknown) { add('error', 'yaml_unreadable_here', `this tool cannot interpret ${a.why}; Bolt may read it differently. ${notYamlHint(y)}`.trim(), file, 1); unknownAssess = true; continue; }
		const root = a.tree, E = (code, msg, line) => add('error', code, msg, file, line || 1);
		{ const cm = chipMismatch(root); if (cm) add('warning', 'description_chip_mismatch', `the description or placeholder says to type ${cm.wrong.join(', ')}, but this app's chip is =${cm.chip}. A copied template keeps its old words`, file, 1); }
		const val = (m, k) => get(m, k)?.value, S = (m, k) => str(val(m, k)), ln = (m, k, d) => get(m, k)?.line ?? d;
		{ const cid = S(root, 'id'), cch = S(root, 'chip'); if (cid && cch && /^[a-z0-9][a-z0-9-]{0,63}$/.test(cch) && /^[a-z0-9][a-z0-9-]{0,63}$/.test(cid.trim()) && cid.trim() !== cch.trim()) E('chip_not_id', `chip "${cch}" is not the id "${cid}". Bolt only runs an app whose chip equals its id: set chip to ${cid}`, ln(root, 'chip')); }
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
			const env = val(bridge, 'env'); if (env && env.t === 'm') for (const e of env.entries) {
				// the value must be exactly one ${env:NAME}, NAME the same as the key, and the variable named inside must itself be allowed (a secret-looking name is refused under any key)
				const m = e.value.t === 's' ? /^\$\{env:([A-Z][A-Z0-9_]{0,63})\}$/.exec(e.value.v) : null;
				if (!m || m[1] !== e.key) E('env_inline_value', `bridge.env.${e.key} value must be exactly \${env:${e.key}}`, e.line ?? ln(bridge, 'env', bl));
				if (m) { const nm = m[1]; if (BOLT_RULES.env.secret_name_parts.some((x) => nm.includes(x))) E('env_secret_name', `bridge.env.${e.key} passes on ${nm}, which Bolt treats as secret-bearing: it is forwarded only to apps shipped inside Bolt. Keep keys in the keychain or ~/.config/<id>/.env`, e.line ?? ln(bridge, 'env', bl)); else if (!BOLT_RULES.env.benign_passthrough.includes(nm)) E('env_not_allowed', `bridge.env.${e.key} passes on ${nm}, which is not on the launcher's list of variables an app may read`, e.line ?? ln(bridge, 'env', bl)); }
			}
		}
		const args = val(root, 'args'); for (const it of args?.items || []) { const fr = S(it, 'from'); if (fr !== undefined && !/^query\.word\(\s*\d+\s*\)$/.test(fr.trim())) E('args_from_unsupported', `args[].from "${fr}" is not supported`, ln(root, 'args')); }
		// checks verify already makes with its own codes (top-level keys, timeout range, inline env, loopback host, method) are not reported twice
		const DUP = new Set(['env_inline_value', 'timeout_out_of_range', 'http_host_not_loopback', 'http_method_not_allowed', 'action_kind', 'http_parse']);
		for (const pr of a.problems.filter((x) => x.code !== 'runtime_not_allowed' && !DUP.has(x.code) && !(/^(unknown_field|missing_field)$/.test(x.code) && /^the app file/.test(x.message)) && !(x.code === 'missing_field' && /"(bridge|http)" is required/.test(x.message)))) add(pr.level || 'error', pr.code, pr.message, file, pr.line || ln(root, 'actions') || 1);   // a problem that knows its line (transform, recognize) points there
	}
	for (const r of used) if (!scripts.has(r)) add('error', 'script_missing', `an app runs {{scripts_dir}}/${r} but the pack has no scripts/${r}`, `scripts/${r}`);
	const usedAll = dataFilesUsed(used, [...scripts.keys()], (n) => scripts.get(n));
	// The launcher: a named script over 2 MB is "too large to check" and the app is not run
	for (const [n, c] of scripts) if (c.length > MAX_HASHED_FILE_BYTES) { const named = used.has(n); add(named ? 'error' : 'warning', 'script_too_large', `scripts/${n} is ${(c.length / 1048576).toFixed(1)} MB; Bolt hashes a script only up to 2 MB and will not run an app that names a larger one${named ? '' : ' (this one is not named, so it is only dead weight)'}`, `scripts/${n}`); }
	// The launcher hashes only the manifest and scripts named as {{scripts_dir}}/<file>. A helper that a script reads (config.json) but no command names is outside the approval hash.
	for (const n of usedAll) if (scripts.has(n) && !used.has(n)) add('warning', 'helper_not_hashed', `scripts/${n} is read by a script but no command names it as {{scripts_dir}}/${n}, so Bolt's approval hash does not cover it: it can change after the person approved the app without asking again`, `scripts/${n}`);
	for (const n of scripts.keys()) if (!usedAll.has(n)) add('warning', 'script_unused', `scripts/${n} is not run by any app file`, `scripts/${n}`);
	// what the install prompt's text search will list for the person installing: the manifests and the scripts they run
	// Bolt reads every file the app file names as {{scripts_dir}}/<file> (a .json helper as well as a script) and the app file itself; a file only imported or read by a script is not scanned
	const scanned = [...used].filter((n) => scripts.has(n)).map((n) => ({ name: n, text: scripts.get(n).toString('utf8') }));
	// Declared hosts are unioned across every app in the pack; Bolt scans per app, so a multi-app pack may show fewer of these warnings than Bolt (never more).
	const declaredHosts = []; for (const a of apps) declaredHosts.push(...declaredHostsOf(a.tree));
	for (const f of files.filter((x) => x.kind === 'user_utility')) scanned.push({ name: path.basename(f.path), text: f.content.toString('utf8') });
	for (const m of scanMentions(scanned, declaredHosts)) add('warning', 'script_mentions', `the install prompt will list: ${m}. A courtesy search, not a verdict: change the text if it is not what the app does${/keychain/.test(m) && /bolt_app_kit\.py/.test(m) ? '. The vendored kit contains the keychain reader; it runs only if your script calls kit.get_secret. The prompt lists it either way, and that is true of what the file can do' : ''}`, 'scripts');
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

// Checks on a pack's own listing, mirroring the launcher and the verifier.
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
