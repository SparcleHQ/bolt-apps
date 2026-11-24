// The launcher's install-time rules as code over schema/bolt-rules.json (the one rules file). Every check here mirrors a check the launcher
// makes when it loads an app file or installs a pack; each problem names the key and says the fix. Returns [{ code, message }].
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { get, str } from './yamlsubset.mjs';

export const RULES = JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../schema/bolt-rules.json'), 'utf8'));
const entries = (n) => (n && n.t === 'm' ? n.entries : []);
const items = (n) => (n && n.t === 'l' ? n.items : []);
const scalar = (n) => (n && n.t === 's' ? n.v : undefined);
const num = (n) => (n && n.t === 's' && !n.q && /^-?\d+(\.\d+)?$/.test(n.v) ? Number(n.v) : undefined);
const kindWord = (t) => (t === 'm' ? 'a mapping' : t === 'l' ? 'a list' : 'text or a number');

// ---- 1, 2, 18: unknown keys and missing required keys at every level (the launcher refuses both)
function keys(node, spec, where, out) {
	if (!node || node.t !== 'm') return;
	const known = new Set(spec.all);
	for (const e of node.entries) if (!known.has(e.key)) out.push({ code: 'unknown_field', message: `${where}: "${e.key}" is not a field the launcher accepts here (it refuses the whole app file). Allowed: ${spec.all.join(', ')}` });
	for (const r of spec.required) if (!get(node, r)) out.push({ code: 'missing_field', message: `${where}: "${r}" is required` });
}
export function structureProblems(root) {
	const out = [], K = RULES.keys;
	// top-level keys and required fields are checked by verify (yaml_key_unknown, yaml_key_missing); this covers every nested level
	const rt = scalar(get(root, 'runtime')?.value);
	const bridge = get(root, 'bridge')?.value;
	if (rt === 'bridge') { if (!bridge) out.push({ code: 'missing_field', message: 'the app file: "bridge" is required for runtime bridge' }); else { keys(bridge, K.bridge, 'bridge', out); keys(get(bridge, 'command')?.value, K['bridge.command'], 'bridge.command', out); } }
	const http = get(root, 'http')?.value;
	if (rt === 'http_local') { if (!http) out.push({ code: 'missing_field', message: 'the app file: "http" is required for runtime http_local' }); else { keys(http, K.http, 'http', out); keys(get(http, 'request')?.value, K['http.request'], 'http.request', out); } }
	for (const [i, a] of items(get(root, 'args')?.value).entries()) keys(a, K['args[]'], `args[${i}]`, out);
	const pres = get(root, 'presentation')?.value;
	keys(pres, K.presentation, 'presentation', out);
	if (get(pres, 'right_widget')) keys(get(pres, 'right_widget').value, K.right_widget, 'presentation.right_widget', out);
	for (const v of entries(get(pres, 'views')?.value)) { keys(v.value, K['presentation.views.*'], `presentation.views.${v.key}`, out); if (get(v.value, 'right_widget')) keys(get(v.value, 'right_widget').value, K.right_widget, `presentation.views.${v.key}.right_widget`, out); }
	for (const [i, a] of items(get(root, 'actions')?.value).entries()) keys(a, K['actions[]'], `actions[${i}]`, out);
	if (get(root, 'dispatch')) { keys(get(root, 'dispatch').value, K.dispatch, 'dispatch', out); for (const [i, c] of items(get(get(root, 'dispatch').value, 'choices')?.value).entries()) keys(c, K['dispatch.choices[]'], `dispatch.choices[${i}]`, out); }
	for (const [i, a] of items(get(root, 'inputs')?.value).entries()) { keys(a, K['inputs[]'], `inputs[${i}]`, out); const t = scalar(get(a, 'type')?.value); if (t !== undefined && !RULES.inputs.types.includes(t)) out.push({ code: 'input_type', message: `inputs[${i}].type must be one of ${RULES.inputs.types.join(', ')}, got "${t}"` }); }
	const cwd = scalar(get(bridge, 'cwd')?.value); if (cwd !== undefined && !RULES.bridge.cwd.includes(cwd)) out.push({ code: 'bridge_cwd', message: `bridge.cwd must be ${RULES.bridge.cwd.join(' or ')} (the launcher refuses any other value)` });
	if (get(root, 'submit')) keys(get(root, 'submit').value, K.submit, 'submit', out);
	return out;
}

// ---- 4: right_widget.bind per kind, as the launcher checks it (strict for schema_version 2 and for every pack)
function bindVal(node, spec, where, out, ctx = {}) {
	const bad = (m) => out.push({ code: 'bind_invalid', message: `${where}: ${m}` });
	const t = spec.t;
	if (t === 'text') { if (!node || node.t !== 's') return bad(`must be text, got ${kindWord(node?.t)}`); if ([...node.v].length > spec.max) bad(`is longer than ${spec.max} characters`); }
	else if (t === 'textOrNumber') { if (!node || node.t !== 's') bad(`must be text or a number, got ${kindWord(node?.t)}`); else if ([...node.v].length > spec.max) bad(`is longer than ${spec.max} characters`); }
	else if (t === 'enum') { const v = scalar(node); if (v === undefined || !spec.values.includes(v)) bad(`must be one of ${spec.values.join(', ')}, got ${JSON.stringify(v ?? null)}`);
		else if (spec.since_values && Object.hasOwn(spec.since_values, v)) { const g = gateProblem(where.replace(/\.[^.]+$/, ''), `${where.split('.').pop()} "${v}"`, spec.since_values[v], ctx); if (g) out.push(g); } }
	else if (t === 'bool') { const v = scalar(node); if (!(v === 'true' || v === 'false') || node.q) bad('must be true or false'); }
	else if (t === 'int') { const v = num(node); if (!Number.isInteger(v) || v < spec.lo || v > spec.hi) bad(`must be a whole number from ${spec.lo} to ${spec.hi}`); }
	else if (t === 'textList') { if (!node || node.t !== 'l') bad(`must be a list, got ${kindWord(node?.t)}`); else { if (node.items.length > spec.items) bad(`has more than ${spec.items} entries`); node.items.forEach((x, i) => { if (!x || x.t !== 's' || [...x.v].length > spec.max) bad(`entry ${i} must be text of at most ${spec.max} characters`); }); } }
	else if (t === 'list') { if (!node || node.t !== 'l') bad(`must be a list, got ${kindWord(node?.t)}`); else { if (node.items.length > spec.items) bad(`has more than ${spec.items} entries`); node.items.forEach((x, i) => bindMap(x, spec.keys, `${where}[${i}]`, out, ctx)); } }
	else if (t === 'map') bindMap(node, spec.keys, where, out, ctx);
	else if (t === 'rowSet') rowSetProblems(node, where, out);
	else if (t === 'stackChildren') stackChildrenProblems(node, where, out, ctx, spec);
}
// stack.children (Bolt 0.1.184): 1 to 6 parts {kind, mode?, bind?}, depth 1; each bind is checked as that kind's own bind. Same caps as the launcher.
function stackChildrenProblems(node, where, out, ctx, spec) {
	const bad = (m) => out.push({ code: 'bind_invalid', message: `${where}: ${m}` });
	const S = RULES.stack, kinds = Object.keys(S.child_kinds);
	if (!node || node.t !== 'l') return bad(`must be a list, got ${kindWord(node?.t)}`);
	if (node.items.length === 0) return bad('needs at least one part');
	if (node.items.length > S.max_children) return bad(`has ${node.items.length} entries; the limit is ${S.max_children}`);
	node.items.forEach((it, i) => {
		const at = `${where}[${i}]`, b = (m) => out.push({ code: 'bind_invalid', message: `${at}${m}` });
		if (!it || it.t !== 'm') return b(` must be a mapping, got ${kindWord(it?.t)}`);
		for (const e of it.entries) if (!['kind', 'mode', 'bind'].includes(e.key)) return out.push({ code: 'bind_unknown_key', message: `${at}.${e.key}: not a key a stack part reads. Allowed: kind, mode, bind` });
		const kv = get(it, 'kind')?.value;
		if (!kv) return b('.kind is required');
		if (kv.t !== 's') return b(`.kind must be one of ${kinds.join(', ')}, got ${kindWord(kv.t)}`);
		if (!Object.hasOwn(S.child_kinds, kv.v)) return b(kv.v === 'stack' ? '.kind "stack" is not allowed: a stack cannot hold a stack' : `.kind "${kv.v.slice(0, 40)}" is not one of ${kinds.join(', ')}`);
		let mode = S.child_kinds[kv.v];
		const mv = get(it, 'mode')?.value;
		if (mv) { if (mv.t !== 's' || !['selected_row', 'list_data'].includes(mv.v)) return b('.mode must be one of selected_row, list_data'); mode = mv.v; }
		const bind = get(it, 'bind')?.value;
		if (bind) {
			out.push(...bindProblems(kv.v, bind, `${at}.bind`, ctx));
			if (get(bind, 'from') && mode !== 'list_data') out.push({ code: 'bind_invalid', message: `${at}.bind.from: needs mode: list_data` });
		}
	});
}
// bind.from (Bolt 0.1.184): {set, where?}. The same closed rules the launcher applies when it loads the app file.
const SET_NAME = /^[a-z][a-z0-9_-]{0,23}$/, RESERVED_NAMES = new Set(['constructor', 'prototype', '__proto__', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__']);
function rowSetProblems(node, where, out) {
	const bad = (m) => out.push({ code: 'bind_invalid', message: `${where}: ${m}` });
	if (!node || node.t !== 'm') return bad(`must be a mapping, got ${kindWord(node?.t)}`);
	for (const e of node.entries) if (e.key !== 'set' && e.key !== 'where') return out.push({ code: 'bind_unknown_key', message: `${where}.${e.key}: not a key a row set reads. Allowed: set, where` });
	const set = get(node, 'set')?.value;
	if (!set) return bad('set is required');
	if (set.t !== 's') return bad(`set must be text, got ${kindWord(set.t)}`);
	if (!SET_NAME.test(set.v)) return bad(`set "${set.v}" must match ^[a-z][a-z0-9_-]{0,23}$`);
	if (RESERVED_NAMES.has(set.v)) return bad(`set "${set.v}" is a reserved name`);
	const w = get(node, 'where')?.value;
	if (!w) return;
	if (w.t !== 'm') return bad(`where must be a mapping, got ${kindWord(w.t)}`);
	if (w.entries.length > 3) return bad(`where has ${w.entries.length} entries; at most 3 are allowed`);
	for (const e of w.entries) {
		if (e.key === '' || [...e.key].length > 200 || RESERVED_NAMES.has(e.key)) return bad(`where has a field name that is not allowed: "${e.key.slice(0, 40)}"`);
		if (!e.value || e.value.t !== 's') return bad(`where.${e.key} must be text, a number or true/false, got ${kindWord(e.value?.t)}`);
		// an unquoted null or a non-finite number is not a value Bolt compares against (it refuses it)
		if (!e.value.q && /^(null|~|[-+]?\.(nan|inf)|[-+]?\.(NaN|Inf|NAN|INF))$/.test(e.value.v)) return bad(`where.${e.key} must be text, a number or true/false, got ${e.value.v === 'null' || e.value.v === '~' ? 'nothing' : 'a number that is not finite'}`);
		if ([...e.value.v].length > 200) return bad(`where.${e.key} is longer than 200 characters`);
	}
}
// A dotted version "0.1.182" as numbers; undefined when it is not one.
export const parseBoltVersion = (v) => { const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v ?? '')); return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined; };
const boltAtLeast = (have, need) => { for (let i = 0; i < 3; i++) if (have[i] !== need[i]) return have[i] > need[i]; return true; };
// A key that only a newer Bolt reads ("since" in the rules file). A Bolt that does not know the key REFUSES THE WHOLE PACK, so an app that uses it must declare
// min_bolt_version in bolt-app.json at or above the version. ctx.minBolt is that declaration; ctx.minBoltKnown says a bolt-app.json was read (a packed bundle carries none).
export function gateProblem(where, key, since, ctx) {
	const have = parseBoltVersion(ctx.minBolt), need = parseBoltVersion(since);
	if (have && need && boltAtLeast(have, need)) return null;
	const ver = since.replace(/^0\.1\./, ''), packed = ctx.minBoltKnown === false;   // packed: a built pack is being read, only a warning (the author may still hand it only to Bolt 182 users)
	const where2 = packed ? "the pack's listing" : 'bolt-app.json';
	const why = ctx.minBolt === undefined ? `${where2} declares no min_bolt_version` : `${where2} says min_bolt_version "${ctx.minBolt}"`;
	return { code: 'bind_needs_newer_bolt', gate: true, level: packed ? 'warning' : 'error', message: `${where}.${key}: needs Bolt ${ver}. A Bolt 0.1.181 REFUSES THE WHOLE PACK when one app uses it ("unknown key for a entity_preview pane"), so no app in the pack would install there. ${why}. Set "min_bolt_version": "${since}" in bolt-app.json to confirm you will give the pack only to people on Bolt ${ver} or newer (Bolt 181 does not read the field and cannot stop the install, it just refuses the pack), or remove ${key}` };
}
const REF = /\{\{[^}]*\}\}/g;   // the same count the Bolt pane makes: one reference per {{ ... }}
function bindMap(node, keysSpec, where, out, ctx = {}) {
	if (!node || node.t !== 'm') { out.push({ code: 'bind_invalid', message: `${where}: must be a mapping, got ${kindWord(node?.t)}` }); return; }
	for (const e of node.entries) {
		if (!Object.hasOwn(keysSpec, e.key)) out.push({ code: 'bind_unknown_key', message: `${where}.${e.key}: not a key this pane reads. Allowed: ${Object.keys(keysSpec).join(', ') || 'none'}` });
		else {
			const sp = keysSpec[e.key];
			if (sp.since) { const g = gateProblem(where, e.key, sp.since, ctx); if (g) out.push(g); }
			bindVal(e.value, sp, `${where}.${e.key}`, out, ctx);
			if (e.key === 'locale' && e.value && e.value.t === 's' && !/^[A-Za-z0-9-]*$/.test(e.value.v)) out.push({ code: 'bind_locale_chars', level: 'warning', message: `${where}.${e.key}: "${e.value.v.slice(0, 40)}" has characters outside letters, digits and "-" (de-DE, not de_DE). Bolt ignores a locale it cannot read and uses the system one` });
			if (sp.max_refs && e.value && e.value.t === 's') {
				const n = (e.value.v.match(REF) || []).length;
				if (n > sp.max_refs) out.push({ code: 'bind_too_many_refs', message: `${where}.${e.key}: has ${n} {{ }} references, at most ${sp.max_refs} are read (Bolt drops the picture). A picture that needs more parts is too big: use a smaller one` });
				else if (e.key === 'src' && !/^\s*\{\{\s*row\./.test(e.value.v) && !/^\s*data:image\/(png|jpe?g|gif|webp|avif|bmp)\b/i.test(e.value.v)) out.push({ code: 'hero_src_not_picture', level: 'warning', message: `${where}.${e.key}: is not a {{row.<field>}} reference or a data:image URI. A Bolt pane never loads a web address, so no hero would show` });
			}
		}
	}
	for (const [k, v] of Object.entries(keysSpec)) if (v.required && !get(node, k)) out.push({ code: 'bind_invalid', message: `${where}.${k}: is required` });
}
export function bindProblems(kind, bind, where, ctx = {}) {
	const out = [], spec = RULES.right_widget.bind[kind];
	if (!spec || !bind) return out;
	bindMap(bind, spec, where, out, ctx);
	if (kind === 'cards' && scalar(get(bind, 'layout')?.value) === 'tiles' && !get(bind, 'value')) out.push({ code: 'bind_invalid', message: `${where}.value: is required when layout is tiles` });
	return out;
}

// ---- 5: environment variables
const isSecretName = (n) => RULES.env.secret_name_parts.some((p) => n.toUpperCase().includes(p));
export function envProblems(root) {
	const out = [], b = get(root, 'bridge')?.value, E = RULES.env;
	if (!b) return out;
	const pass = items(get(b, 'env_passthrough')?.value);
	if (pass.length > E.passthrough_max) out.push({ code: 'env_passthrough_max', message: `bridge.env_passthrough lists ${pass.length} names; at most ${E.passthrough_max} are allowed` });
	const check = (name, where) => {
		if (!new RegExp(E.name_pattern).test(name) || name.length > E.name_max_len) out.push({ code: 'env_name', message: `${where}: "${name}" must be 1 to ${E.name_max_len} uppercase letters, digits or _, starting with a letter` });
		else if (isSecretName(name)) out.push({ code: 'env_secret_name', message: `${where}: "${name}" looks like a secret (it contains ${E.secret_name_parts.join(', ')}). Bolt treats it as secret-bearing and forwards it only to apps shipped inside Bolt. Keep keys in the system keychain or ~/.config/<id>/.env and read them in the script` });
		else if (!E.benign_passthrough.includes(name)) out.push({ code: 'env_not_allowed', message: `${where}: "${name}" is not on the launcher's list of variables an app may read (${E.benign_passthrough.join(', ')})` });
	};
	const seenPass = new Set();
	for (const [i, n] of pass.entries()) { const v = scalar(n); if (v !== undefined) { check(v, `bridge.env_passthrough[${i}]`); if (seenPass.has(v)) out.push({ code: 'env_passthrough_duplicate', message: `bridge.env_passthrough lists ${v} twice` }); seenPass.add(v); } }
	for (const e of entries(get(b, 'env')?.value)) {
		const v = scalar(e.value);
		if (v === undefined || !new RegExp(E.inline_value_pattern).test(v) || v !== '${env:' + e.key + '}') out.push({ code: 'env_inline_value', message: `bridge.env.${e.key}: the value must be exactly \${env:${e.key}} (a variable can be passed on, never set to a value or renamed)` });
		check(e.key, `bridge.env.${e.key}`);
	}
	return out;
}

// ---- 3, 13: timeouts and loopback services
export function timeoutProblems(root) {
	const out = [], T = RULES.timeouts, rt = scalar(get(root, 'runtime')?.value);
	const block = rt === 'bridge' ? get(root, 'bridge')?.value : rt === 'http_local' ? get(root, 'http')?.value : null;
	if (!block) return out;
	const raw = get(block, 'timeout_seconds')?.value, v = num(raw);
	if (raw === undefined) out.push({ code: 'timeout_default', level: 'warning', message: `${rt === 'bridge' ? 'bridge' : 'http'}.timeout_seconds is not set, so the launcher stops the app after ${T.default_s} seconds. Set it (${T.min_s} to ${T.max_s}) if the app can take longer` });
	else if (!Number.isInteger(v) || v < T.min_s || v > T.max_s) out.push({ code: 'timeout_out_of_range', message: `timeout_seconds must be a whole number from ${T.min_s} to ${T.max_s}, got ${JSON.stringify(scalar(raw) ?? null)}` });
	return out;
}
export function httpProblems(root) {
	const out = [], h = get(root, 'http')?.value, H = RULES.http_local;
	if (!h) return out;
	const p = num(get(h, 'port')?.value);
	if (!Number.isInteger(p) || p < 1 || p > 65535) out.push({ code: 'http_port', message: 'http.port must be a whole number from 1 to 65535 (0 is refused)' });
	else for (const [a, b] of H.reserved_ports) if (p >= a && p <= b) out.push({ code: 'http_port_reserved', message: `http.port ${p} is one of Bolt's own service ports (${H.reserved_ports.map((r) => r.join('-')).join(', ')}); the launcher refuses it. Use another port` });
	const host = scalar(get(h, 'host')?.value); if (host !== undefined && !H.hosts.includes(host)) out.push({ code: 'http_host_not_loopback', message: `http.host must be one of ${H.hosts.join(', ')}` });
	const m = scalar(get(get(h, 'request')?.value, 'method')?.value); if (m !== undefined && !H.methods.includes(m.toUpperCase())) out.push({ code: 'http_method_not_allowed', message: `http.request.method must be GET or POST` });
	for (const e of entries(get(h, 'headers')?.value)) {
		if (!new RegExp(H.header_name_pattern).test(e.key)) out.push({ code: 'http_header', message: `http.headers.${e.key}: a header name is letters, digits and - only` });
		const v = scalar(e.value);
		if (v !== undefined && v.includes('${')) { const mm = /^\$\{env:([A-Z][A-Z0-9_]*)\}$/.exec(v); if (!mm || !RULES.env.benign_passthrough.includes(mm[1])) out.push({ code: 'http_header', message: `http.headers.${e.key}: a value may use \${env:NAME} only for a name on the launcher's benign list (${RULES.env.benign_passthrough.slice(0, 5).join(', ')}, ...)` }); }
	}
	const pr = scalar(get(h, 'parse')?.value); if (pr !== undefined && !H.parse.includes(pr)) out.push({ code: 'http_parse', message: `http.parse must be json, lines or raw` });
	return out;
}

// ---- link hosts: parsed, not pattern-matched. Refuses userinfo, a placeholder host, and every spelling of a local or private address.
const IPV4_PRIVATE = (a, b) => a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
function ipv4Parts(h) {   // dotted, decimal, hex and octal spellings; null when h is not numeric
	const parts = h.split('.'); if (parts.length < 1 || parts.length > 4 || parts.some((p) => p === '')) return null;
	const nums = parts.map((p) => (/^0x[0-9a-f]+$/i.test(p) ? parseInt(p, 16) : /^0[0-7]+$/.test(p) ? parseInt(p, 8) : /^\d+$/.test(p) ? parseInt(p, 10) : NaN));
	if (nums.some((n) => Number.isNaN(n))) return null;
	let v = 0; for (let i = 0; i < nums.length - 1; i++) { if (nums[i] > 255) return null; v = v * 256 + nums[i]; }
	const last = nums[nums.length - 1], room = 256 ** (5 - nums.length); if (last >= room) return null;
	v = v * room + last; return [Math.floor(v / 2 ** 24) % 256, Math.floor(v / 2 ** 16) % 256, Math.floor(v / 256) % 256, v % 256];
}
function ipv6Groups(v) {   // eight 16-bit numbers, or null
	let t = v.toLowerCase(); const m4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(t);
	if (m4) { const q = m4[1].split('.').map(Number); if (q.some((n) => n > 255)) return null; t = t.slice(0, -m4[1].length) + ((q[0] << 8) | q[1]).toString(16) + ':' + ((q[2] << 8) | q[3]).toString(16); }
	const halves = t.split('::'); if (halves.length > 2) return null;
	const head = halves[0] ? halves[0].split(':') : [], tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
	const fill = halves.length === 2 ? 8 - head.length - tail.length : 0; if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
	const g = [...head, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...tail].map((x) => parseInt(x || '0', 16)); return g.length === 8 && g.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? g : null;
}
export function hostProblem(u) {
	const auth = /^https?:\/\/([^/?#]*)/i.exec(u)?.[1] ?? '';
	if (/[\\{}]/.test(auth)) return { code: 'action_url', message: 'must have a literal host after https:// (no \\ and no placeholder in the host part)' };
	let url; try { url = new URL(u); } catch { return { code: 'action_url', message: 'is not a valid https address' }; }
	if (url.protocol !== 'https:') return { code: 'action_url', message: 'must start with https://' };
	if (url.username || url.password) return { code: 'action_url', message: 'must not contain a user name or password before the host (user@host)' };
	if (url.port && url.port !== '443') return { code: 'action_url_port', level: 'warning', message: `names port ${url.port}; the launcher follows a link on a port other than 443 only when the app declares that site (opens_links:host:port)` };
	let h = url.hostname.toLowerCase().replace(/\.$/, '');
	const bad = (why) => ({ code: 'action_url_internal', message: `host "${h}" is ${why}; the launcher refuses links to those` });
	if (!h) return { code: 'action_url', message: 'has no host' };
	if (h.startsWith('[')) {
		const g = ipv6Groups(h.slice(1, -1)); if (!g) return { code: 'action_url', message: 'has an IPv6 address that cannot be read' };
		const lead = g[0];
		if (g.every((n, i) => i === 7 ? n <= 1 : n === 0)) return bad('the IPv6 loopback or unspecified address');
		// an IPv4 address carried inside an IPv6 one: mapped (::ffff:a.b.c.d), translated (::ffff:0:a.b.c.d) and the old compatible form (::a.b.c.d)
		const embedded = g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff ? [g[6], g[7]] : g.slice(0, 4).every((n) => n === 0) && g[4] === 0xffff && g[5] === 0 ? [g[6], g[7]] : g.slice(0, 6).every((n) => n === 0) ? [g[6], g[7]] : null;
		if (embedded) { const q = [embedded[0] >> 8, embedded[0] & 255]; return IPV4_PRIVATE(q[0], q[1]) ? bad('an IPv6 address that carries a private or local IPv4 address') : null; }
		if ((lead & 0xffc0) === 0xfe80 || (lead & 0xffc0) === 0xfec0 || (lead & 0xfe00) === 0xfc00 || (lead & 0xff00) === 0xff00 || lead === 0x2002 || (lead === 0x64 && g[1] === 0xff9b)) return bad('a local, private, translated or multicast IPv6 address');
		return null;   // a public IPv6 literal is allowed
	}
	const q = ipv4Parts(h);
	if (q) return IPV4_PRIVATE(q[0], q[1]) ? bad('a private or local address') : null;
	if (h === 'localhost' || !h.includes('.') || RULES.actions.internal_host_suffixes.some((x) => h.endsWith(x))) return bad('a local or single-name host');
	return null;
}

// ---- 6, 12: action rules
export function actionProblems(root) {
	const out = [], A = RULES.actions, acts = items(get(root, 'actions')?.value);
	const seen = new Set(); let primary = 0;
	acts.forEach((a, i) => {
		const g = (k) => scalar(get(a, k)?.value), w = `actions[${i}]`;
		const id = g('id'), kind = g('kind'), label = g('label');
		const has = (k) => g(k) !== undefined;
		// the id pattern and the prototype-name rule bind a run action (its id is looked up by name) and a script's row actions (kit); a plain manifest action only needs a unique id
		if (id !== undefined) { if (seen.has(id)) out.push({ code: 'action_id', message: `${w}.id "${id}" is used twice` }); seen.add(id); if (kind === 'run' && (!new RegExp(A.id_pattern).test(id) || A.forbidden_ids.includes(id))) out.push({ code: 'action_id', message: `${w}.id "${id}" must be 1 to 64 letters, digits, _ or -, and not ${A.forbidden_ids.join(', ')} (a run action is found by its id)` }); }
		if (kind !== undefined && !A.kinds.includes(kind)) out.push({ code: 'action_kind', message: `${w}.kind must be one of ${A.kinds.join(', ')}` });
		for (const k of A.manifest_only_keys) if (get(a, k)) out.push({ code: 'action_admin_only', message: `${w}.${k} is only for admin-provisioned apps; the launcher refuses it in a personal app` });
		if (kind === 'url' && !g('url_template')) out.push({ code: 'action_field', message: `${w}: a url action needs url_template` });
		if (kind === 'composer' && !g('insert')) out.push({ code: 'action_field', message: `${w}: a composer action needs insert` });
		if (kind === 'utility' && !g('target_chip')) out.push({ code: 'action_field', message: `${w}: a utility action needs target_chip` });
		if (kind === 'run') for (const k of ['primary', 'url_template', 'insert', 'target_chip']) if (has(k)) out.push({ code: 'action_field', message: `${w}: a run action takes only id, label, query_template and icon, not ${k}` });
		if (kind === 'utility') for (const k of ['url_template', 'insert']) if (has(k)) out.push({ code: 'action_field', message: `${w}: a utility action takes target_chip and query_template, not ${k}` });
		if (kind !== undefined && kind !== 'utility' && has('target_chip')) out.push({ code: 'action_field', message: `${w}: target_chip belongs to a utility action only` });
		if (kind !== undefined && kind !== 'utility' && kind !== 'run' && has('query_template')) out.push({ code: 'action_field', message: `${w}: query_template belongs to a utility or run action only` });
		if (kind === 'run') { const q = g('query_template') ?? ''; if (!q.trim() || q.includes('{{')) out.push({ code: 'run_action_template', message: `${w}: a run action needs query_template with fixed text and no {{ }}; otherwise the button does nothing` }); }
		if (g('primary') === 'true') primary++;
		const icon = g('icon'); if (icon !== undefined && !A.icons.includes(icon)) out.push({ code: 'action_icon', message: `${w}.icon "${icon}" is not one of the ${A.icons.length} names the launcher allows for footer buttons: ${A.icons.join(', ')}` });
		if (label !== undefined && A.reserved_label_words.includes(label.trim().toLowerCase())) out.push({ code: 'action_label_reserved', level: 'warning', message: `${w}.label "${label}" is a word the launcher reserves for its own prompts; it shows "App: ${label}" instead. Use a more specific label` });
		const u = g('url_template');
		if (u !== undefined && kind === 'url' && /^https?:\/\//i.test(u)) { const hp = hostProblem(u); if (hp) out.push({ code: hp.code, level: hp.level, message: `${w}.url_template ${hp.message}` }); }
	});
	if (primary > 1) out.push({ code: 'action_primary', message: 'at most one action may be primary' });
	return out;
}

// ---- 7, 8: row panes and nav
export function paneNavProblems(root) {
	const out = [], pres = get(root, 'presentation')?.value, views = entries(get(pres, 'views')?.value);
	const names = new Set(views.map((v) => v.key));
	const viewArg = scalar(get(pres, 'view_arg')?.value);
	if (viewArg) {
		const args = items(get(root, 'args')?.value);
		const arg = args.find((a) => scalar(get(a, 'name')?.value) === viewArg);
		const idx = Number(/^query\.word\(\s*(\d+)\s*\)$/.exec(scalar(get(arg, 'from')?.value) ?? '')?.[1]);
		if (Number.isInteger(idx) && idx > RULES.views.nav_word_max_index) out.push({ code: 'view_arg_index', message: `the view is read from query.word(${idx}); the launcher places at most ${RULES.views.nav_word_max_index} query words, so navigation is off` });
		for (let i = 0; Number.isInteger(idx) && i < idx; i++) {
			const holder = args.find((a) => a !== arg && new RegExp(`^query\\.word\\(\\s*${i}\\s*\\)$`).test(scalar(get(a, 'from')?.value) ?? ''));
			const d = get(holder, 'default')?.value;
			if (d && num(d) !== undefined) out.push({ code: 'view_arg_lead_default', message: `args default for query.word(${i}) is a number; quote it ("${d.v}"): a number default is not a nav token and turns navigation off` });
		}
	}
	return out;
}
export function paneProblem(pane, root) {
	if (typeof pane !== 'string' || !new RegExp(RULES.views.name_pattern).test(pane)) return `pane "${pane}" must match ${RULES.views.name_pattern}`;
	const views = entries(get(get(root, 'presentation')?.value, 'views')?.value);
	const v = views.find((e) => e.key === pane);
	if (!v) return `pane "${pane}" is not a view of this app (views: ${views.map((e) => e.key).join(', ') || 'none'})`;
	const rw = get(v.value, 'right_widget')?.value, kind = scalar(get(rw, 'kind')?.value), mode = scalar(get(rw, 'mode')?.value);
	if (!RULES.row_pane_kinds.includes(kind) || mode !== 'selected_row') return `pane "${pane}" must have a right_widget of kind ${RULES.row_pane_kinds.join(', ')} with mode selected_row (it is ${kind ?? 'none'}/${mode ?? 'default'})`;
	return null;
}

// ---- 11: pack version, parsed the way the launcher parses it
export function versionProblem(v) {
	let s = String(v).trim().replace(/^[vV]/, '').split('+')[0];
	const [core, pre] = [s.split('-')[0], s.includes('-') ? s.slice(s.indexOf('-') + 1) : null];
	if (!core || !core.split('.').every((p) => /^\d+$/.test(p))) return `version "${v}" is not a dotted number such as 1.0.1 (an optional leading v, a -prerelease and a +build are allowed)`;
	return null;
}

// ---- 10: script layout, as the launcher installs it
export function layoutProblems(files) {
	const out = [], depth = RULES.pack.script_max_depth, lower = new Map();
	for (const f of files) {
		const parts = f.split('/');
		if (parts.length > depth + 1) out.push({ code: 'script_depth', message: `scripts/${f} is nested more than ${depth} folders deep; the launcher refuses it` });
		if (parts.some((p) => p === '..' || p === '.' || p === '' || p.includes('..'))) out.push({ code: 'script_path', message: `scripts/${f} has a "." part or ".." inside a name; the launcher refuses it` });
		const l = f.toLowerCase(); if (lower.has(l) && lower.get(l) !== f) out.push({ code: 'script_case_clash', message: `scripts/${lower.get(l)} and scripts/${f} differ only in letter case; one would replace the other on macOS and Windows` }); lower.set(l, f);
	}
	const set = new Set(files.map((f) => f.toLowerCase()));
	for (const f of files) { const parts = f.split('/'); for (let i = 1; i < parts.length; i++) if (set.has(parts.slice(0, i).join('/').toLowerCase())) out.push({ code: 'script_file_folder', message: `scripts/${parts.slice(0, i).join('/')} is both a file and a folder` }); }
	return out;
}

// ---- 11: script namespacing. Bolt installs every pack's scripts into ONE shared folder and refuses a file whose path already belongs to another
// installed pack (owned_by_other). Every file an app ships starts with "<app id>__" (an id holds no underscore, so the first "__" always ends the id, and two
// different ids can never give the same name). Bolt tells apps apart by id: two apps with the same id replace each other, and two authors who both ship
// `weather` still collide, so the id must be distinctive. A bare bolt_app_kit.py or config.json collides with the next app.
export const nsPrefix = (id) => `${id}__`;
export function namespaceProblems(paths, id) {
	const out = [], known = typeof id === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(id);
	const first = (f) => f.split('/')[0];
	const prefixes = new Set(paths.map((f) => { const m = /^([a-z0-9][a-z0-9-]*)__./.exec(first(f)); return m ? m[1] : null; }));
	for (const f of paths) {
		const want = known ? nsPrefix(id) : null, m = /^([a-z0-9][a-z0-9-]*)__./.exec(first(f));
		const ok = known ? first(f).startsWith(want) && first(f).length > want.length : !!m && prefixes.size === 1;
		if (!ok) out.push({ code: 'script_not_namespaced', file: f, message: `scripts/${f} is not named for this app. Bolt keeps every installed app's scripts in one shared folder and refuses an app whose script has the same name as another app's (error code owned_by_other), so a shared name such as ${first(f)} would stop a second app installing. Fix: rename it to ${known ? nsPrefix(id) : '<app id>__'}<name> and use the same name after {{scripts_dir}}/. Apps built before this change: remove the old app in Bolt (Settings, User Apps, Remove), run ./bolt-apps new <template> <id>, then copy your own config.json and fixtures.json over the new ones and re-run ./bolt-apps check.` });
	}
	return out;
}
