// What a User App can do, recomputed from its YAML the way Bolt does at install
// (bolt-native src-tauri/src/user_utilities/pack_validate.rs: assess_utility, assess_pack).
// The YAML is read with plain text rules (no YAML parser, zero dependencies), so this mirrors Bolt's
// tier and permission rules but is not Bolt's parser. Bolt parses the file again at install.
export const ALLOWED_RUNTIME = ['bridge', 'http_local', 'transform'];
export const ALLOWED_ACTION_KIND = ['url', 'composer', 'utility', 'run'];
const unq = (s) => (s === undefined ? s : s.replace(/^["']|["']$/g, ''));

// Top-level keys and their text (a key starts in column 0).
export function topLevel(yaml) {
	const out = {}; let key = null;
	for (const line of yaml.split(/\r?\n/)) {
		const m = /^([A-Za-z_][A-Za-z0-9_]*):(.*)$/.exec(line);
		if (m) { key = m[1]; out[key] = m[2] + '\n'; } else if (key) out[key] += line + '\n';
	}
	return out;
}
export function httpsLiteralHost(t) {
	const rest = String(t).trim().replace(/^["']|["']$/g, '');
	if (!rest.startsWith('https://')) return null;
	const r = rest.slice(8), host = r.slice(0, r.search(/[/?#]|$/));
	return !host || /[{}@]/.test(host) ? null : host.toLowerCase();
}
export function scriptRefs(text) {
	return new Set([...text.matchAll(/\{\{\s*scripts_dir\s*\}\}[/\\]([A-Za-z0-9._-]+)/g)].map((m) => m[1]));
}
// Returns { tier, permissions, reasons, runtime, id, problems } for one utilities/*.yaml.
export function assessYaml(yaml, name = 'the app') {
	const top = topLevel(yaml), problems = [], reasons = [], perms = new Set();
	const runtime = unq(/^\s*(\S*)/.exec(top.runtime || '')?.[1]), id = unq(/^\s*(\S*)/.exec(top.id || '')?.[1]) || name;
	let tier = 1;
	if (runtime === 'transform') { tier = 2; perms.add('reads_launcher_input'); perms.add('copies_to_clipboard'); }
	else if (runtime === 'bridge') { tier = 3; perms.add('runs_commands'); reasons.push(`${id} runs a program on your computer`); }
	else if (runtime === 'http_local') {
		tier = 3; const port = /\bport:\s*(\d+)/.exec(top.http || '')?.[1] || '0';
		perms.add(`network:localhost:${port}`); reasons.push(`${id} connects to a service on this computer (port ${port})`);
	} else { tier = 3; problems.push({ code: 'runtime_not_allowed', message: `runtime "${runtime}" is not one Bolt accepts (${ALLOWED_RUNTIME.join(', ')}). Bolt would refuse the whole pack.` }); }
	if ('detect' in top) { tier = 3; perms.add('runs_commands'); reasons.push(`${id} checks for a program on your computer (${unq(/\bbinary:\s*(\S+?)[,}\s]/.exec(top.detect + ' ')?.[1]) || '?'})`); }
	if ('recognize' in top) perms.add('reads_launcher_input');
	if (top.actions) {
		const items = top.actions.split(/\n(?=\s*-\s)/).filter((s) => /kind:/.test(s));
		for (const it of items) {
			const kind = unq(/kind:\s*([A-Za-z_"']+)/.exec(it)[1]);
			if (kind === 'url') {
				const host = httpsLiteralHost(/url_template:\s*("[^"]*"|'[^']*'|[^,}\s]+)/.exec(it)?.[1] || '');
				if (host) perms.add(`opens_links:${host}`);
				else { tier = 3; perms.add('opens_any_link'); reasons.push(`${id} opens links that are not fixed https addresses`); }
			} else if (kind === 'composer') perms.add('inserts_text');
			else if (kind === 'run') perms.add('runs_own_command_on_press');
			else if (kind === 'utility') perms.add(`routes_to_app:${unq(/target_chip:\s*(\S+?)[,}\s]/.exec(it + ' ')?.[1]) || ''}`);
			else { tier = 3; perms.add(`action:${kind}`); problems.push({ code: 'action_not_allowed', message: `action kind "${kind}" is not one Bolt accepts (${ALLOWED_ACTION_KIND.join(', ')}). Bolt would refuse the whole pack.` }); }
		}
	}
	return { id, runtime, tier, permissions: [...perms].sort(), reasons, problems, refs: scriptRefs(yaml) };
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
