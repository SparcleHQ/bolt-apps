// What a User App can do, recomputed from its YAML the way Bolt does at install
// (the launcher: assess_utility, assess_pack).
// The YAML is read by a strict subset reader (yamlsubset.mjs, no dependencies): a file outside that subset is
// "unknown" (tier 3), never a lower tier. This mirrors Bolt's tier and permission rules but is not Bolt's parser;
// Bolt parses the file again at install.
export const ALLOWED_RUNTIME = ['bridge', 'http_local', 'transform'];
export const ALLOWED_ACTION_KIND = ['url', 'composer', 'utility', 'run'];

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYaml, Unreadable, get, str } from './yamlsubset.mjs';
import { RULES, gateProblem, structureProblems, bindProblems, envProblems, timeoutProblems, httpProblems, actionProblems, paneNavProblems } from './boltrules.mjs';
export function httpsLiteralHost(t) {
	const rest = String(t).trim();
	if (!rest.startsWith('https://')) return null;
	const r = rest.slice(8); let end = r.length; for (let i = 0; i < r.length; i++) if ('/?#'.includes(r[i])) { end = i; break; }
	const host = r.slice(0, end);
	return !host || !/^[A-Za-z0-9.:-]+$/.test(host) ? null : host.toLowerCase();
}
export function scriptRefs(text) {
	return new Set([...text.matchAll(/\{\{\s*scripts_dir\s*\}\}[/\\]([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)/g)].map((m) => m[1]));
}
// Script names named by scalar VALUES of the parsed tree (comments are not values).
function treeRefs(n, out = new Set()) {
	if (!n) return out;
	if (n.t === 's') for (const r of scriptRefs(n.v)) out.add(r);
	else if (n.t === 'm') for (const e of n.entries) treeRefs(e.value, out);
	else if (n.t === 'l') for (const i of n.items) treeRefs(i, out);
	return out;
}
// The launcher's rule for the scripts folder (the launcher, plain_script_refs and
// script_names_in_template): EVERY mention of "scripts_dir" in the file text, any case, comments included, must sit
// inside a YAML key or value and be exactly the placeholder {{scripts_dir}} followed by /<plain file name> as its own
// shell word (no quotes around it, no spaces inside the braces, no `..`, no name starting with a dot). Otherwise Bolt
// cannot say which files the app runs and never runs it. This mirrors that rule from its source; Bolt parses again at install.
const SEG = '[A-Za-z0-9_][A-Za-z0-9._-]*(?<!\\.)';
function treeStrings(n, out = []) {
	if (!n) return out;
	if (n.t === 's') out.push(n.v);
	else if (n.t === 'm') for (const e of n.entries) { out.push(String(e.key)); treeStrings(e.value, out); }
	else if (n.t === 'l') for (const i of n.items) treeStrings(i, out);
	return out;
}
export function scriptsDirProblem(yaml, root) {
	const mentions = (yaml.toLowerCase().match(/scripts_dir/g) || []).length;
	if (!mentions) return null;
	let seen = 0, bad = false;
	for (const s of treeStrings(root)) {
		const n = (s.toLowerCase().match(/scripts_dir/g) || []).length;
		if (!n) continue;
		seen += n;
		if (/['"]\{\{scripts_dir|\{\{scripts_dir\}(?!\})/.test(s)) continue;   // a quote round it or a lone brace: command_variable_in_quotes / command_placeholder_malformed already say so
		const exact = (s.match(/\{\{scripts_dir\}\}/g) || []).length;
		const words = (s.match(new RegExp(`(?:^|\\s)\\{\\{scripts_dir\\}\\}/${SEG}(?:/${SEG})*(?=\\s|$)`, 'g')) || []).length;
		if (exact !== n || words !== n) bad = true;
	}
	if (!bad && seen === mentions) return null;
	return { code: 'scripts_dir_form', message: 'Bolt cannot resolve every mention of the scripts folder to one file each, so it would not run this app. Every mention of scripts_dir in the file, comments included, must be a value holding {{scripts_dir}}/<file name> as its own word, with no quotes, no spaces inside the braces and no sub-folder tricks. Remove it from comments and write nothing else with scripts_dir.' };
}
// Why this reader cannot interpret the file ([] when it can). Anything listed here is reported as unknown, never low.
export function unreadable(yaml) { try { parseYaml(yaml); return []; } catch (e) { if (e instanceof Unreadable) return [e.message]; throw e; } }
// Returns { tier, permissions, reasons, runtime, id, problems, refs, unknown, tree } for one utilities/*.yaml.
// When the file is outside the readable subset, unknown is true and tier is 3 (the highest), so nothing reads low.
export function assessYaml(yaml, name = 'the app', opts = {}) {
	const problems = [], reasons = [], perms = new Set();
	let root; try { root = parseYaml(yaml); } catch (e) {
		if (!(e instanceof Unreadable)) throw e;
		return { id: name, runtime: undefined, tier: 3, permissions: ['runs_commands'], reasons: [`${name} could not be read by this tool (${e.message}), so what it can do is unknown`], problems: [], refs: scriptRefs(yaml), unknown: true, why: e.message, tree: null };
	}
	const runtime = str(get(root, 'runtime')?.value), id = str(get(root, 'id')?.value) || name;
	let tier = 1;
	if (runtime === 'transform') { tier = 2; perms.add('reads_launcher_input'); perms.add('copies_to_clipboard'); }
	else if (runtime === 'bridge') { tier = 3; perms.add('runs_commands'); reasons.push(`${id} runs a program on your computer`); }
	else if (runtime === 'http_local') {
		tier = 3; const port = str(get(get(root, 'http')?.value, 'port')?.value) || '0';
		perms.add(`network:localhost:${port}`); reasons.push(`${id} connects to a service on this computer (port ${port})`);
	} else { tier = 3; if (runtime !== undefined) problems.push({ code: 'runtime_not_allowed', message: `runtime "${runtime}" is not one Bolt accepts (${ALLOWED_RUNTIME.join(', ')}). Bolt would refuse the whole pack.` }); }
	const detect = get(root, 'detect');
	if (detect) { tier = 3; perms.add('runs_commands'); reasons.push(`${id} checks for a program on your computer (${str(get(detect.value, 'binary')?.value) || '?'})`); }
	if (get(root, 'recognize')) perms.add('reads_launcher_input');
	const actions = get(root, 'actions')?.value;
	if (actions && !(actions.t === 'l' || (actions.t === 's' && actions.v === ''))) { return { id, runtime, tier: 3, permissions: ['runs_commands'], reasons: [`${id} has actions this tool could not read, so what it can do is unknown`], problems, refs: treeRefs(root), unknown: true, why: 'actions that are not a list', tree: root }; }
	for (const it of actions?.items || []) {
		if (it.t !== 'm') return { id, runtime, tier: 3, permissions: ['runs_commands'], reasons: [`${id} has an action this tool could not read, so what it can do is unknown`], problems, refs: treeRefs(root), unknown: true, why: 'an action that is not a mapping', tree: root };
		const kind = str(get(it, 'kind')?.value) ?? '';
		if (kind === 'url') {
			const host = httpsLiteralHost(str(get(it, 'url_template')?.value) || '');
			if (host) perms.add(`opens_links:${host}`); else { tier = 3; perms.add('opens_any_link'); reasons.push(`${id} opens links that are not fixed https addresses`); }
		} else if (kind === 'composer') perms.add('inserts_text');
		else if (kind === 'run') perms.add('runs_own_command_on_press');
		else if (kind === 'utility') perms.add(`routes_to_app:${str(get(it, 'target_chip')?.value) || ''}`);
		else { tier = 3; perms.add(`action:${kind}`); problems.push({ code: 'action_not_allowed', message: `action kind "${kind}" is not one Bolt accepts (${ALLOWED_ACTION_KIND.join(', ')}). Bolt would refuse the whole pack.` }); }
	}
	const sd = scriptsDirProblem(yaml, root); if (sd) problems.push(sd);
	problems.push(...pipeNotSupportedProblems(root));
	problems.push(...launcherRules(root, opts));
	return { id, runtime, tier, permissions: [...perms].sort(), reasons, problems, refs: treeRefs(root), unknown: false, tree: root };
}

// Transform steps the runtime knows by name but does not run yet: it throws "recognized but not yet supported" when the step runs.
// The app still loads, so this is a warning, like an icon the launcher cannot draw.
export const PIPE_NOT_SUPPORTED = ['yaml', 'toml', 'env', 'properties', 'camel', 'snake', 'kebab', 'slug', 'flatten', 'rename_cols', 'redact_secrets'];
export function pipeNotSupportedProblems(root) {
	const out = [];
	(get(get(root, 'transform')?.value, 'pipe')?.value?.items || []).forEach((it, i) => {
		const name = it.t === 's' ? it.v : it.t === 'm' && it.entries.length ? it.entries[0].key : undefined;
		if (PIPE_NOT_SUPPORTED.includes(name)) out.push({ level: 'warning', code: 'pipe_step_not_supported', message: `transform step ${i + 1} ('${name}') is recognized but not yet supported by this build of Bolt, so the app fails with that message when it runs. Remove the step or use a supported one` });
	});
	return out;
}

// ---- more launcher rules, each mirrored from the launcher source (read, not guessed) ----
// The launcher draws a plain plug for an icon name that is not in its list, so an unknown name is a silent defect: refuse it with the fix.
let ICONS = null;
export function iconProblem(name) {
	try { ICONS ??= new Set(JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../kit/schema/icons.json'), 'utf8')).icons); } catch { return null; }
	return ICONS.has(name) ? null : `icon "${name}" is not in the launcher icon list (kit/schema/icons.json), so the launcher draws a plain plug. Use a listed name such as activity, list, globe, file, line-chart or map-pin`;
}
export const MAX_VIEWS = 8;                                   // the launcher MAX_VIEWS, checked by the launcher
const VIEW_NAME = /^[a-z][a-z0-9_-]{0,23}$/;                  // the launcher name_re
export const NAV_ARG_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/; // the launcher NAV_ARG_RE
export const isNavToken = (s) => typeof s === 'string' && NAV_ARG_RE.test(s) && !s.includes('..'); // the launcher isNavArg
export const RIGHT_WIDGET_KINDS = ['card', 'map', 'image', 'calc', 'color', 'weather', 'date', 'markdown', 'entity_preview', 'chart', 'table', 'cards', 'detail', 'json_tree', 'diff', 'image_grid', 'heatmap', 'gauge']; // the launcher (heatmap and gauge from Bolt 182)
const RIGHT_WIDGET_MODES = ['selected_row', 'list_data'];     // the launcher
export const NO_APP_DATA_KINDS = ['image', 'color', 'weather', 'date', 'calc']; // the launcher NO_APP_DATA
const BIND_NONE = ['map', 'image', 'calc', 'color', 'weather', 'date']; // the launcher BIND_NONE: these panes read nothing from bind
const OS3 = ['macos', 'linux', 'windows'];
// The launcher: a double-quoted YAML string can spell the placeholder with escapes the text check cannot see, so Bolt
// refuses to pin the app down at all. The regex is the launcher's own, applied to the whole file text (comments too).
const ESCAPE_RE = /\\(x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|[\r\n\u0085\u2028\u2029])/;
export function escapeProblem(text) {
	return ESCAPE_RE.test(text) ? { level: 'error', code: 'yaml_escape', message: 'the file uses character escapes (such as \\x or \\u, or a backslash before a line break). Bolt says "it uses character escapes that can hide what it runs" and will not run the app. Write the character itself, or rephrase the text' } : null;
}
// The rules on a parsed app file. Each entry is { level, code, message }.
export function launcherRules(root, opts = {}) {
	const out = [], E = (code, message) => out.push({ level: 'error', code, message }), W = (code, message) => out.push({ level: 'warning', code, message });
	const pres = get(root, 'presentation')?.value, views = get(pres, 'views')?.value, viewArg = str(get(pres, 'view_arg')?.value);
	const strict = Number(str(get(root, 'schema_version')?.value)) >= 2;   // the launcher doc: bind problems are errors from schema_version 2
	const hasViews = views && views.t === 'm';
	// the launcher validate_views
	if (!hasViews) { if (viewArg !== undefined && viewArg !== '') E('view_arg_without_views', 'presentation.view_arg is set but presentation.views is missing. Add the views, or remove view_arg'); }
	else {
		if (viewArg === undefined || viewArg === '') E('view_arg_missing', 'presentation.view_arg is required when presentation.views is present. Name the arg whose value selects the view');
		else {
			const arg = (get(root, 'args')?.value?.items || []).find((a) => str(get(a, 'name')?.value) === viewArg);
			if (!arg) E('view_arg_unknown', `presentation.view_arg "${viewArg}" is not a declared arg`);
			else if (!/^query\.word\(\s*\d+\s*\)$/.test((str(get(arg, 'from')?.value) ?? '').trim())) E('view_arg_not_query_word', `presentation.view_arg "${viewArg}" must name an arg bound with from: "query.word(N)", but its from is ${JSON.stringify(str(get(arg, 'from')?.value) ?? null)}. Bolt puts the view name into that query word; any other binding gives it nowhere to go and the views never show`);
			else {
				// A nav row runs "<lead words> <view> [arg]". Every word before the view word needs a default that is a plain nav token
				// (a letter, digit or _ first, then letters, digits, _ . -, at most 64, no ".."): a default such as "-" there kills every drill
				// and Back row. Words after the view word are never rebuilt, so "-" is fine for them.
				const idx = Number(/^query\.word\(\s*(\d+)\s*\)$/.exec((str(get(arg, 'from')?.value) ?? '').trim())?.[1]);
				const all = get(root, 'args')?.value?.items || [];
				for (let i = 0; i < idx; i++) {
					const holder = all.find((a) => a !== arg && new RegExp(`^query\\.word\\(\\s*${i}\\s*\\)$`).test((str(get(a, 'from')?.value) ?? '').trim()));
					const d = holder ? str(get(holder, 'default')?.value) : undefined;
					if (d === undefined || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(d) || d.includes('..')) {
						E('view_arg_lead_default', `the view is read from query.word(${idx}), so query.word(${i}) needs an arg with a default that is a plain word (letters, digits, _ . -, not starting with - or .)${holder ? `, but "${d ?? ''}" is not one` : ''}. Without it every drill and Back row in this app does nothing`);
						break;
					}
				}
			}
		}
		if (views.entries.length > MAX_VIEWS) E('views_too_many', `presentation.views has ${views.entries.length} entries (the overview counts as one), at most ${MAX_VIEWS} are allowed. Bolt refuses the whole app file`);
		for (const v of views.entries) if (!VIEW_NAME.test(v.key) || v.key === 'constructor' || v.key === 'prototype') E('view_name_invalid', `presentation.views name "${v.key}" must match ^[a-z][a-z0-9_-]{0,23}$ and not be constructor or prototype`);
	}
	// the launcher validate_right_widget, on presentation.right_widget and each view's right_widget
	const rws = [['presentation.right_widget', get(pres, 'right_widget')?.value], ...(hasViews ? views.entries.map((v) => [`presentation.views.${v.key}.right_widget`, get(v.value, 'right_widget')?.value]) : [])];
	for (const [p, rw] of rws) {
		if (!rw || rw.t !== 'm') continue;
		const kind = str(get(rw, 'kind')?.value), mode = str(get(rw, 'mode')?.value), bind = get(rw, 'bind')?.value;
		if (kind !== undefined && !RIGHT_WIDGET_KINDS.includes(kind)) E('right_widget_kind_invalid', `${p}.kind "${kind}" is not one of ${RIGHT_WIDGET_KINDS.join(', ')}`);
		if (mode !== undefined && !RIGHT_WIDGET_MODES.includes(mode)) E('right_widget_kind_invalid', `${p}.mode "${mode}" is not one of ${RIGHT_WIDGET_MODES.join(', ')}`);
		// a pane only a newer Bolt knows (heatmap, gauge: Bolt 182): a 181 refuses the whole pack, so the app must declare min_bolt_version
		if (kind !== undefined && RULES.kind_since && RULES.kind_since[kind]) { const g = gateProblem(p, 'kind', RULES.kind_since[kind], { minBolt: opts.minBolt, minBoltKnown: opts.minBoltKnown }); if (g) (g.level === 'warning' ? W : E)(g.code, g.message.replace(`${p}.kind:`, `${p}.kind "${kind}":`)); }
		if (NO_APP_DATA_KINDS.includes(kind)) W('right_widget_no_data', `${p}.kind "${kind}" passes validation but Bolt shows "This app asks for a ${kind} pane, which cannot show app data" instead of your rows. Use table, detail, cards or chart${kind === 'image' ? ' (image_grid for pictures)' : ''}`);
		const bad = (code, m) => (strict ? E : W)(code, strict ? m : `${m} (a warning for schema_version 1, an error from schema_version 2)`);
		if (BIND_NONE.includes(kind) && bind && bind.t === 'm' && bind.entries.length) bad('right_widget_bind_unread', `${p}.bind.${bind.entries[0].key}: a ${kind} pane reads nothing from bind; remove the key${kind === 'map' ? ' (the map takes the launcher\'s own state; use an "Open in Maps" url action for a place)' : ''}`);
		// bind.from (a named row set, Bolt 0.1.184) feeds a pane that draws the whole list: the launcher refuses it on a selected_row pane
		if (bind && bind.t === 'm' && get(bind, 'from') && mode !== 'list_data') bad('right_widget_bind_unread', `${p}.bind.from: needs mode: list_data (a selected_row pane reads one list row, never a row set)`);
		// Every other kind: keys, types, enums and caps from the launcher's table (schema/bolt-rules.json). Strict for schema_version 2 and for every pack.
		if (!BIND_NONE.includes(kind) && bind && bind.t === 'm') for (const bp of bindProblems(kind, bind, `${p}.bind`, { minBolt: opts.minBolt, minBoltKnown: opts.minBoltKnown })) {
			if (bp.gate || bp.level === 'warning' || bp.code === 'bind_too_many_refs') (bp.level === 'warning' ? W : E)(bp.code, bp.message);   // a gate on a newer Bolt, or a plain warning, is never softened or hardened by schema_version
			else (strict || opts.pack ? E : W)('right_widget_bind_unread', bp.message + (strict || opts.pack ? '' : ' (a warning for schema_version 1, an error from schema_version 2 and in every pack)'));
		}
	}
	// no command for a platform: the app has nothing to run there. A warning, since an app may be single-platform on purpose.
	if (str(get(root, 'runtime')?.value) === 'bridge') {
		const cm = get(get(root, 'bridge')?.value, 'command')?.value;
		if (cm && cm.t === 'm' && cm.entries.length) for (const o of OS3) if (!cm.entries.some((e) => e.key === o) && !opts.platformsUnknown && (!Array.isArray(opts.platforms) || opts.platforms.includes(o))) W('command_os_missing', `bridge.command has no ${o} entry, so the app has nothing to run on ${o}${Array.isArray(opts.platforms) ? '' : '. Add one, or list only the systems it supports in "platforms" in bolt-app.json'}`);
	}
	// The launcher's structure, env, timeout, loopback, action and nav rules (schema/bolt-rules.json). Each is an error because the launcher refuses the file.
	for (const f of [structureProblems, envProblems, timeoutProblems, httpProblems, actionProblems, paneNavProblems]) for (const pr of f(root)) (pr.level === 'warning' ? W : E)(pr.code, pr.message);
	out.push(...transformProblems(root));   // these carry the line of the step or pattern they are about
	return out;
}
// Two parts of transform and recognize, with the step names and the limits read from schema/user-app.schema.json (not copied here): each transform.pipe step
// is a listed step name, or a mapping with exactly one listed key, and the pipe has a number of steps the schema allows; recognize.patterns has a number of
// entries the schema allows and no regex longer than its limit. Step values (such as head: -1) and what a regex matches are not checked: Bolt checks them.
let USER_APP = null;
export function transformProblems(root) {
	const out = [], E = (code, message, line) => out.push({ level: 'error', code, message, ...(line ? { line } : {}) });
	USER_APP ??= JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../schema/user-app.schema.json'), 'utf8')).properties;
	const pipeSpec = USER_APP.transform.properties.pipe, patSpec = USER_APP.recognize.properties.patterns;
	const names = pipeSpec.items.oneOf.flatMap((o) => o.enum || []), valued = pipeSpec.items.oneOf.filter((o) => o.type === 'object').map((o) => o.required[0]);
	const list = (n) => (n && n.t === 'l' ? n.items : null);
	const trE = get(root, 'transform'), tr = trE?.value;
	if (tr && tr.t === 'm') {
		const pipeE = get(tr, 'pipe'), steps = list(pipeE?.value), here = pipeE?.line ?? trE.line, stepLine = (i) => pipeE?.value?.lines?.[i] ?? here;
		if (!steps || steps.length < pipeSpec.minItems || steps.length > pipeSpec.maxItems) E('transform_pipe_count', `transform.pipe has ${steps ? steps.length : 'no'} steps; it takes ${pipeSpec.minItems} to ${pipeSpec.maxItems}, and Bolt refuses the app file otherwise`, here);
		for (const [i, s] of (steps || []).entries()) {
			const keys = s.t === 'm' ? s.entries.map((e) => e.key) : [];
			if (s.t === 's' ? !names.includes(s.v) : s.t !== 'm' || keys.length !== 1 || !valued.includes(keys[0])) E('transform_step_unknown', `transform.pipe[${i}] ${s.t === 's' ? `"${s.v}"` : s.t === 'm' ? `{ ${keys.join(', ')} }` : '(a list)'} is not a step name Bolt knows. A step is one of ${names.join(', ')}, or a mapping with exactly one of ${valued.join(', ')}`, stepLine(i));
		}
	}
	const rcE = get(root, 'recognize'), rc = rcE?.value;
	if (rc && rc.t === 'm') {
		const patE = get(rc, 'patterns'), pats = list(patE?.value), here = patE?.line ?? rcE.line, max = patSpec.items.properties.regex.maxLength;
		if (!pats || pats.length < patSpec.minItems || pats.length > patSpec.maxItems) E('recognize_patterns_count', `recognize.patterns has ${pats ? pats.length : 'no'} entries; it takes ${patSpec.minItems} to ${patSpec.maxItems}, and Bolt refuses the app file otherwise`, here);
		for (const [i, p] of (pats || []).entries()) { const reE = get(p, 'regex'), re = str(reE?.value); if (re !== undefined && [...re].length > max) E('recognize_regex_too_long', `recognize.patterns[${i}].regex is ${[...re].length} characters; at most ${max} are allowed`, reE.line ?? patE.value.lines?.[i] ?? here); }
	}
	return out;
}
// Codes assessYaml can return as problems: verify takes these from checkManifests, so the folder view drops lint's copy.
export const ASSESS_CODES = new Set(['transform_pipe_count', 'transform_step_unknown', 'recognize_patterns_count', 'recognize_regex_too_long', 'unknown_field', 'missing_field', 'bind_invalid', 'env_passthrough_max', 'env_name', 'env_secret_name', 'env_not_allowed', 'env_inline_value', 'timeout_default', 'timeout_out_of_range', 'http_port', 'http_port_reserved', 'http_host_not_loopback', 'http_method_not_allowed', 'http_parse', 'action_id', 'action_kind', 'action_field', 'run_action_template', 'action_primary', 'action_icon', 'action_label_reserved', 'action_url', 'action_url_internal', 'action_url_port', 'action_admin_only', 'input_type', 'bridge_cwd', 'env_passthrough_duplicate', 'http_header', 'view_arg_index', 'scripts_dir_form', 'runtime_not_allowed', 'action_not_allowed', 'views_too_many', 'view_name_invalid', 'view_arg_missing', 'view_arg_unknown', 'view_arg_not_query_word', 'view_arg_lead_default', 'view_arg_without_views', 'command_os_missing', 'right_widget_no_data', 'right_widget_kind_invalid', 'right_widget_bind_unread', 'run_action_template', 'bind_needs_newer_bolt', 'bind_too_many_refs', 'hero_src_not_picture']);
export const MAX_HASHED_FILE_BYTES = 2 * 1024 * 1024;         // the launcher MAX_HASHED_FILE_BYTES
const WORDS = [
	[/^runs_commands$/, 'run programs on your computer'], [/^network:localhost:(\d+)$/, 'talk to a service on this computer (port $1)'],
	[/^opens_links:(.+)$/, 'open links to $1'], [/^opens_any_link$/, 'open links to addresses it does not fix in advance'],
	[/^reads_launcher_input$/, 'read what you type or paste in the launcher'], [/^copies_to_clipboard$/, 'copy results to your clipboard'],
	[/^inserts_text$/, 'insert text where you are typing'], [/^runs_own_command_on_press$/, 'run its own command when you press a button'],
	[/^routes_to_app:(.*)$/, 'hand your input to another app ($1)'], [/^reads_clipboard$/, 'read your clipboard'],
];
export const plainPermission = (p) => { for (const [re, t] of WORDS) if (re.test(p)) return p.replace(re, t); return p; };
// The permission ids a gallery listing may carry (the launcher KNOWN_PERMISSIONS).
export function listingPermissions(perms) {
	const out = new Set();
	for (const p of perms) {
		if (p.startsWith('opens_links:') || p === 'opens_links') out.add(p);
		else if (p === 'opens_any_link') out.add('opens_links');
		else if (p.startsWith('network:')) out.add('network');
		else if (['reads_clipboard', 'reads_launcher_input', 'copies_to_clipboard', 'runs_commands', 'files', 'agent_tools'].includes(p)) out.add(p);
	}
	return [...out].sort();
}
// A script or app file name Bolt accepts inside a pack (the launcher is_plain_entry_path).
export function plainName(n) {
	return n.length > 0 && n.length <= 128 && /^[A-Za-z0-9._-]+$/.test(n) && !n.startsWith('.') && !n.endsWith('.') && !/^(con|prn|aux|nul|conin\$|conout\$|(com|lpt)[1-9])$/i.test(n.split('.')[0].trimEnd());
}

// A file in scripts/ that no app file runs still counts as used when a used script names it: a .py module imported by a used .py script, or a .json data file named in a quoted string by a used .py or .json file
// for example config.json holding "fixture_file": "fixtures.json". Only named files count: a data file nothing names
// is still reported as unused. `read(name)` returns the file's text.
export function dataFilesUsed(used, names, read) {
	const out = new Set(used);
	// A script imports and reads its neighbours: only a file in the SAME folder counts, and names are matched by the file's own name, so two apps' helpers never count for each other.
	const dir = (n) => (n.includes('/') ? n.slice(0, n.lastIndexOf('/')) : ''), base = (n) => n.slice(n.lastIndexOf('/') + 1);
	// An app's files are named <app id>__<name>; the script's own code says bolt_app_kit and config.json, so a file counts under the name after the prefix too.
	const bare = (n) => { const b = base(n), i = b.indexOf('__'); return i > 0 ? b.slice(i + 2) : b; };
	for (let again = true; again;) {
		again = false;
		// a .py module counts as used when a used .py script in the same folder imports it (import bolt_app_kit, from bolt_app_kit import ...)
		for (const holder of [...out].filter((n) => n.endsWith('.py'))) {
			let text = ''; try { text = String(read(holder)); } catch { continue; }
			for (const n of names) {
				const m = /^(.+)\.py$/.exec(bare(n));
				if (m && dir(n) === dir(holder) && !out.has(n) && new RegExp(`^\\s*(import|from)\\s+${m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|\\.|,|$)`, 'm').test(text)) { out.add(n); again = true; }
			}
		}
		for (const holder of [...out].filter((n) => n.endsWith('.json') || n.endsWith('.py'))) {
			let text = ''; try { text = String(read(holder)); } catch { continue; }
			for (const n of names) if (n.endsWith('.json') && dir(n) === dir(holder) && !out.has(n) && [base(n), bare(n)].some((b) => text.includes(JSON.stringify(b)) || text.includes(`'${b}'`))) { out.add(n); again = true; }
		}
	}
	return out;
}

// The install prompt's "Mentions" list: a quick text search Bolt runs over the manifest and every script it names
// (the launcher scan_scripts). Mirrored here so an author sees the same findings
// before the person installing does. A courtesy, never a boundary. `files` is [{ name, text }].
const OPEN_RULE = 'open (starts other programs or documents)';
const SCAN_RULES = [
	["Bolt's app data folder", /app\.sparcle\.bolt|bolt-startup\.log|local-api\.key|user-utils[/\\]/i],
	['the .ssh folder', /(^|[^A-Za-z0-9])\.ssh([/\\\s"']|$)/],
	['credential folders or files (.aws, .gnupg, .kube, .npmrc, .git-credentials, private keys)', /(^|[^A-Za-z0-9])\.(aws|gnupg|kube|npmrc|git-credentials|netrc)\b|\bid_(rsa|ed25519|ecdsa)\b/i],
	['the system keychain or the security command', /(^|[\s;&|(`"'\[,])security\s+(find|add|delete|dump|import|export|unlock)[a-z-]*|\bkeychain\b|\bsecret-tool\b|\bcmdkey\b/i],
	['osascript', /\bosascript\b/],
	[OPEN_RULE, /(^|[;&|`(\s'"\[,])open\s+(-[A-Za-z]+\b|["'/~$])|["']open["']\s*,/],
	['recursive forced delete', /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|-r\s+-f|-f\s+-r)\b/],
	['a browser profile folder', /Google[/\\]Chrome|BraveSoftware|Firefox[/\\]Profiles|\.mozilla|Microsoft Edge[/\\]|\.config[/\\](google-chrome|chromium|microsoft-edge)|Login Data\b/i],
	['the clipboard', /\b(pbpaste|pbcopy|xclip|xsel|wl-paste|Get-Clipboard)\b/i],
	['system account files', /\/etc\/(passwd|shadow|sudoers)\b/],
	['the Windows registry', /\breg(\.exe)?\s+(add|query|delete|export)\b|HKEY_/i],
];
// The network hosts an app file declares under permissions.network (a list of { host }), as Bolt reads them for this scan.
export function declaredHostsOf(tree) {
	const items = get(get(tree, 'permissions')?.value, 'network')?.value?.items || [];
	return items.map((it) => str(get(it, 'host')?.value)).filter((h) => typeof h === 'string' && h.trim());
}
// Bolt's authority_host: after the last @, no port, no brackets or trailing dot, lower case.
const authorityHost = (auth) => {
	const at = auth.slice(auth.lastIndexOf('@') + 1), m = /^(.*):(\d+)$/.exec(at);
	return (m ? m[1] : at).replace(/^[[\]]+|[[\]]+$/g, '').replace(/\.+$/, '').toLowerCase();
};
// For the `open` and `curl or wget` rules only. The one thing skipped: in an app file (the caller passes app: true; the
// default is no skip, and a file under scripts/ is never an app file even if it is named .yaml), a column-0
// `description:` or `placeholder_examples:` key whose value is one complete line of text, so prose such as
// `description: Wraps curl so you can fetch pages` does not warn.
// NOT skipped, on purpose: comment lines in scripts (# or //) and YAML # comments. A line filter cannot tell a comment
// from a path, a string, a heredoc or a continued line, so a script comment that mentions open or curl is a known
// remaining false positive. A prose false positive costs a courtesy warning; a hidden command costs the whole scan.
// Also not skipped: an indented line, a block scalar (| or >), and a quoted value that runs onto more lines.
// Lines end at \r\n, a lone \r, U+2028 or U+2029 (Python and JS treat those as line ends).
const LINE_END = /\r\n|[\r\n\u2028\u2029]/;
const closesQuote = (t, q) => { for (let k = 0; k < t.length; k++) { if (q === '"' && t[k] === '\\') k++; else if (t[k] === q) { if (q === "'" && t[k + 1] === "'") k++; else return true; } } return false; };
function runnableText(app, text) {
	if (app !== true) return text;
	const keep = []; let inQuote = null;
	for (const l of text.split(LINE_END)) {
		if (inQuote) { keep.push(l); if (closesQuote(l, inQuote)) inQuote = null; continue; }
		const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(l), v = m ? m[2].trim() : '';
		if (m && (v[0] === '"' || v[0] === "'") && !(v.length > 1 && closesQuote(v.slice(1), v[0]))) inQuote = v[0];
		const prose = m && /^(description|placeholder_examples)$/.test(m[1]) && v && !/^[|>]/.test(v) && !inQuote
			&& (v[0] === '[' ? v.endsWith(']') : v[0] === '"' || v[0] === "'" ? v.length > 1 && v.endsWith(v[0]) : true);
		if (!prose) keep.push(l);
	}
	return keep.join('\n');
}
export function scanMentions(files, declaredHosts = []) {
	const declared = (h) => declaredHosts.some((d) => { d = String(d).trim().toLowerCase(); return h === d || h.endsWith(`.${d}`); });
	const out = new Set();
	for (const { name, text, app } of files) {
		const live = runnableText(app, text);
		for (const [what, re] of SCAN_RULES) if (re.test(what === OPEN_RULE ? live : text)) out.add(`${what} (in ${name})`);
		for (const m of text.matchAll(/https?:\/\/[^\s"']+/g)) if (/[@\\]/.test(m[0])) out.add(`a web address with a user name or a backslash in it (in ${name})`);
		for (const line of live.split('\n').filter((l) => /\b(curl|wget)\b/.test(l))) {
			const auths = [...line.matchAll(/https?:\/\/([^/\\\s"'?#]+)/g)].map((m) => m[1]);
			if (!auths.length) out.add(`curl or wget with an address not written out here (in ${name})`);
			for (const a of auths) {
				if (/[$`{%<*]/.test(a)) out.add(`curl or wget with an address not written out here (in ${name})`);
				else if (a.includes('@')) { /* listed above whatever the host */ }
				else if (!declared(authorityHost(a))) out.add(`curl or wget to ${authorityHost(a)}, which it does not declare (in ${name})`);
			}
		}
	}
	return [...out].sort();
}

// A description or placeholder that tells the person to type =something other than this app's chip (a copied template keeps its old words).
export function chipMismatch(tree) {
	if (!tree) return null;
	const chip = str(get(tree, 'chip')?.value);
	if (!chip) return null;
	const texts = [str(get(tree, 'description')?.value), ...((get(tree, 'placeholder_examples')?.value?.items) || []).map((i) => str(i))].filter((x) => typeof x === 'string');
	const wrong = new Set();
	for (const tx of texts) for (const m of tx.matchAll(/(?:^|[\s"'(,;:])=([A-Za-z0-9][A-Za-z0-9-]*)/g)) if (m[1].toLowerCase() !== chip.toLowerCase()) wrong.add(`=${m[1]}`);
	return wrong.size ? { chip, wrong: [...wrong] } : null;
}
