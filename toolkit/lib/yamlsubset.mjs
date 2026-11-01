// A strict reader for the small YAML subset Bolt apps use. It is an ALLOWLIST: anything that is not exactly the shape
// below throws Unreadable, and callers then report "unable to assess" (tier and risk unknown), never a lower value.
// Allowed: block mappings and block sequences indented with spaces; `key: value`; `- value`; `- key: value`;
// single-line flow maps `{ k: v }` and flow lists `[ a, b ]`; plain, "double" (escapes \" and \\ only) and 'single'
// scalars; whole-line comments and ` # comment` after a value. Keys are bare words with the colon touching them.
// Not allowed (Unreadable): tabs in indentation, anchors, aliases, tags, block scalars, quoted or complex keys, merge
// keys, directives, document markers, BOM, bare CR and Unicode line or bidi separators, duplicate keys, multi-line
// scalars, a line over 64 KB or a file over 1 MB. Linear time: one pass over each line, no backtracking regexes.
export class Unreadable extends Error {}
const MAX_LINE = 64 * 1024, MAX_FILE = 1024 * 1024;
const bad = (why) => { throw new Unreadable(why); };
const KEY_START = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
const KEY_CHAR = (c) => KEY_START(c) || (c >= '0' && c <= '9') || c === '-';
const FORBIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u200b\u200e\u200f\u2028-\u202e\u2060-\u2069\ufeff]/;

// Scan a bare key at s[i]; returns the end index or -1. The colon must touch the key.
function scanKey(s, i) {
	if (!KEY_START(s[i] || '')) return -1;
	let j = i + 1; while (j < s.length && KEY_CHAR(s[j])) j++;
	return s[j] === ':' && (j + 1 === s.length || s[j + 1] === ' ') ? j : -1;
}
// One scalar or flow value starting at s[i]. ctx 'block' or 'flow'. Returns [value, nextIndex].
function value(s, i, ctx, depth = 0) {
	if (depth > 8) bad('nesting deeper than 8');
	const c = s[i];
	if (c === '"') {
		let out = '', j = i + 1;
		for (; j < s.length; j++) {
			if (s[j] === '\\') { const n = s[j + 1]; if (n !== '"' && n !== '\\') bad('an escape sequence in double quotes'); out += n; j++; }
			else if (s[j] === '"') return [{ t: 's', v: out, q: true }, j + 1];
			else out += s[j];
		}
		bad('an unterminated double-quoted string');
	}
	if (c === "'") {
		let out = '', j = i + 1;
		for (; j < s.length; j++) {
			if (s[j] === "'") { if (s[j + 1] === "'") { out += "'"; j++; } else return [{ t: 's', v: out, q: true }, j + 1]; } else out += s[j];
		}
		bad('an unterminated single-quoted string');
	}
	if (c === '{') {
		const entries = [], seen = new Set(); let j = i + 1;
		for (;;) {
			while (s[j] === ' ') j++;
			if (s[j] === '}') return [{ t: 'm', entries }, j + 1];
			const e = scanKey(s, j); if (e < 0) bad('a flow-map key that is not a bare word touching its colon');
			const key = s.slice(j, e); if (seen.has(key)) bad(`a duplicate key "${key}"`); seen.add(key);
			j = e + 1; while (s[j] === ' ') j++;
			let v; [v, j] = value(s, j, 'flow', depth + 1); entries.push({ key, value: v });
			while (s[j] === ' ') j++;
			if (s[j] === ',') j++; else if (s[j] !== '}') bad('a flow map that is not closed');
		}
	}
	if (c === '[') {
		const items = []; let j = i + 1;
		for (;;) {
			while (s[j] === ' ') j++;
			if (s[j] === ']') return [{ t: 'l', items }, j + 1];
			let v; [v, j] = value(s, j, 'flow', depth + 1); items.push(v);
			while (s[j] === ' ') j++;
			if (s[j] === ',') j++; else if (s[j] !== ']') bad('a flow list that is not closed');
		}
	}
	if (c === undefined) bad('a missing value');
	if ('&*!|>%@`'.includes(c)) bad(c === '&' || c === '*' ? 'an anchor or alias' : c === '!' ? 'a tag' : c === '|' || c === '>' ? 'a block scalar' : `a value starting with ${c}`);
	if ((c === '?' || c === '-') && (s[i + 1] === ' ' || s[i + 1] === undefined)) bad('a complex key or nested sequence on one line');
	// plain scalar
	let j = i; const stop = ctx === 'flow' ? ',]}' : '';
	while (j < s.length) {
		const ch = s[j];
		if (stop.includes(ch)) break;
		if (ch === '#' && j > i && s[j - 1] === ' ') break;
		if (ch === ':' && (s[j + 1] === ' ' || s[j + 1] === undefined || (ctx === 'flow' && ',]}'.includes(s[j + 1])))) bad('a nested mapping where a value belongs');
		j++;
	}
	const v = s.slice(i, j).trimEnd();
	return [{ t: 's', v, q: false }, i + v.length];
}
function restOfLine(s, j) { while (s[j] === ' ') j++; if (j < s.length && !(s[j] === '#' && s[j - 1] === ' ')) bad('text after a value'); }

export function parseYaml(text) {
	if (typeof text !== 'string') bad('not text');
	if (text.length > MAX_FILE) bad('a file over 1 MB');
	if (FORBIDDEN.test(text)) bad('a control, separator or byte-order character');
	if (/\r(?!\n)/.test(text)) bad('a bare carriage return');
	const lines = [];
	text.split('\n').forEach((raw, n) => {
		const l = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
		if (l.length > MAX_LINE) bad('a line over 64 KB');
		const t = l.trimStart();
		if (!t || t[0] === '#') return;
		const indent = l.length - t.length;
		if (l.slice(0, indent).includes('\t')) bad('a tab in indentation');
		if (/^(---|\.\.\.)(\s|$)/.test(l) || l[0] === '%') bad('a document marker or directive');
		lines.push({ indent, t, line: n + 1 });
	});
	if (!lines.length) bad('an empty file');
	let pos = 0;
	function block(indent) {
		const first = lines[pos];
		if (first.t.startsWith('- ') || first.t === '-') return sequence(indent);
		return mapping(indent);
	}
	function mapping(indent, pending) {
		const entries = [], seen = new Set();
		for (;;) {
			const L = pending || lines[pos];
			if (!L || L.indent < indent) break;
			if (L.indent > indent) bad('inconsistent indentation');
			if (L.t.startsWith('- ')) break;
			const e = scanKey(L.t, 0); if (e < 0) bad(`a line that is not "key: value" (line ${L.line})`);
			const key = L.t.slice(0, e); if (key === '<<') bad('a merge key');
			if (seen.has(key)) bad(`a duplicate key "${key}"`); seen.add(key);
			if (!pending) pos++; else pending = null;
			let j = e + 1; while (L.t[j] === ' ') j++;
			let v;
			if (j >= L.t.length || (L.t[j] === '#' && L.t[j - 1] === ' ')) {
				const nx = lines[pos];
				v = nx && nx.indent > indent ? block(nx.indent) : { t: 's', v: '', q: false };
			} else { let k; [v, k] = value(L.t, j, 'block'); restOfLine(L.t, k); }
			entries.push({ key, value: v, line: L.line });
		}
		return { t: 'm', entries };
	}
	function sequence(indent) {
		const items = [];
		for (;;) {
			const L = lines[pos];
			if (!L || L.indent !== indent || !(L.t.startsWith('- ') || L.t === '-')) { if (L && L.indent > indent) bad('inconsistent indentation'); break; }
			const rest = L.t.slice(1).replace(/^ +/, ''), off = L.t.length - rest.length;
			if (!rest || rest[0] === '#') { pos++; const nx = lines[pos]; items.push(nx && nx.indent > indent ? block(nx.indent) : { t: 's', v: '', q: false }); continue; }
			if (scanKey(rest, 0) >= 0) { const sub = { indent: indent + off, t: rest, line: L.line }; pos++; items.push(mapping(indent + off, sub)); continue; }
			pos++; const [v, k] = value(rest, 0, 'block'); restOfLine(rest, k); items.push(v);
		}
		return { t: 'l', items };
	}
	if (lines[0].indent !== 0) bad('a document that is indented');
	const root = block(0);
	if (pos < lines.length) bad(`unexpected content at line ${lines[pos].line}`);
	if (root.t !== 'm') bad('a document that is not a mapping');
	return root;
}
export const get = (m, key) => (m && m.t === 'm' ? m.entries.find((e) => e.key === key) : undefined);
export const str = (n) => (n && n.t === 's' ? n.v : undefined);
