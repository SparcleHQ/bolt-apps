// What a User App can do, recomputed from its YAML the way Bolt does at install
// (bolt-native src-tauri/src/user_utilities/pack_validate.rs: assess_utility, assess_pack).
// The YAML is read by a strict subset reader (yamlsubset.mjs, no dependencies): a file outside that subset is
// "unknown" (tier 3), never a lower tier. This mirrors Bolt's tier and permission rules but is not Bolt's parser;
// Bolt parses the file again at install.
export const ALLOWED_RUNTIME = ['bridge', 'http_local', 'transform'];
export const ALLOWED_ACTION_KIND = ['url', 'composer', 'utility', 'run'];

import { parseYaml, Unreadable, get, str } from './yamlsubset.mjs';
export function httpsLiteralHost(t) {
	const rest = String(t).trim();
	if (!rest.startsWith('https://')) return null;
	const r = rest.slice(8); let end = r.length; for (let i = 0; i < r.length; i++) if ('/?#'.includes(r[i])) { end = i; break; }
	const host = r.slice(0, end);
	return !host || /[{}@]/.test(host) ? null : host.toLowerCase();
}
export function scriptRefs(text) {
	return new Set([...text.matchAll(/\{\{\s*scripts_dir\s*\}\}[/\\]([A-Za-z0-9._-]+)/g)].map((m) => m[1]));
}
// Script names named by scalar VALUES of the parsed tree (comments are not values).
function treeRefs(n, out = new Set()) {
	if (!n) return out;
	if (n.t === 's') for (const r of scriptRefs(n.v)) out.add(r);
	else if (n.t === 'm') for (const e of n.entries) treeRefs(e.value, out);
	else if (n.t === 'l') for (const i of n.items) treeRefs(i, out);
	return out;
}
// Why this reader cannot interpret the file ([] when it can). Anything listed here is reported as unknown, never low.
export function unreadable(yaml) { try { parseYaml(yaml); return []; } catch (e) { if (e instanceof Unreadable) return [e.message]; throw e; } }
// Returns { tier, permissions, reasons, runtime, id, problems, refs, unknown, tree } for one utilities/*.yaml.
// When the file is outside the readable subset, unknown is true and tier is 3 (the highest), so nothing reads low.
export function assessYaml(yaml, name = 'the app') {
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
	return { id, runtime, tier, permissions: [...perms].sort(), reasons, problems, refs: treeRefs(root), unknown: false, tree: root };
}
const WORDS = [
	[/^runs_commands$/, 'run programs on your computer'], [/^network:localhost:(\d+)$/, 'talk to a service on this computer (port $1)'],
	[/^opens_links:(.+)$/, 'open links to $1'], [/^opens_any_link$/, 'open links to addresses it does not fix in advance'],
	[/^reads_launcher_input$/, 'read what you type or paste in the launcher'], [/^copies_to_clipboard$/, 'copy results to your clipboard'],
	[/^inserts_text$/, 'insert text where you are typing'], [/^runs_own_command_on_press$/, 'run its own command when you press a button'],
	[/^routes_to_app:(.*)$/, 'hand your input to another app ($1)'], [/^reads_clipboard$/, 'read your clipboard'],
];
export const plainPermission = (p) => { for (const [re, t] of WORDS) if (re.test(p)) return p.replace(re, t); return p; };
// The permission ids a gallery listing may carry (bolt-common app_listing.rs KNOWN_PERMISSIONS).
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
// A script or app file name Bolt accepts inside a pack (pack_validate.rs is_plain_entry_path).
export function plainName(n) {
	return n.length > 0 && n.length <= 128 && /^[A-Za-z0-9._-]+$/.test(n) && !n.startsWith('.') && !n.endsWith('.') && !/^(con|prn|aux|nul|conin\$|conout\$|(com|lpt)[1-9])$/i.test(n.split('.')[0].trimEnd());
}
