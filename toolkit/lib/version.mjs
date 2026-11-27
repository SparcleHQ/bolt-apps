// What `bolt-apps --version` reports: the toolkit version and the oldest Bolt it lints for.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RULES } from './boltrules.mjs';

// The oldest Bolt this toolkit writes apps for. Keys a newer Bolt added are gated by "since" in schema/bolt-rules.json and need min_bolt_version in the app.
export const MIN_BOLT = '0.1.181';

const here = path.dirname(fileURLToPath(import.meta.url));
export const toolkitVersion = () => JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version;

// The newest "since" anywhere in the rules file: the Bolt an app must declare once it uses the newest key.
export function newestGate(rules = RULES) {
	let best = null;
	const num = (v) => v.split('.').map(Number);
	const newer = (a, b) => { const x = num(a), y = num(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
	const take = (v) => { if (typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v) && (!best || newer(v, best))) best = v; };
	const walk = (n, gated) => {
		if (Array.isArray(n)) return n.forEach((x) => walk(x, false));
		if (n && typeof n === 'object') for (const [k, v] of Object.entries(n)) {
			if (k === 'since') take(v);
			else if (gated) take(v);
			else walk(v, k === 'since_values' || k === 'kind_since');
		}
	};
	walk(rules, false);
	return best;
}

export function versionText() {
	const gate = newestGate();
	return `${toolkitVersion()}\nlints for Bolt ${MIN_BOLT} and newer${gate ? `; keys added in Bolt ${gate} need "min_bolt_version": "${gate}" in bolt-app.json` : ''}`;
}
