// `bolt-apps migrate`: moves an app off keys that are deprecated. Nothing is deprecated in 184, so DEPRECATIONS is empty and the command
// reports "nothing to migrate" and writes nothing. The wiring is real so the first deprecation is one entry here plus a line in
// CONTRACT-EVOLUTION.md. An entry keeps working for at least two releases after `since` (see CONTRACT-EVOLUTION.md).
//   { id, since, remove_not_before, find: RegExp (one line of an app file), replace: string, note }
import fs from 'node:fs';
import path from 'node:path';

export const DEPRECATIONS = [];

/** Pure: the app file text after the deprecations are applied, and what changed. */
export function migrateText(text, deprecations = DEPRECATIONS) {
	const changes = [];
	const out = String(text).split('\n').map((line, i) => {
		let cur = line;
		for (const d of deprecations) {
			if (d.find.test(cur)) { const next = cur.replace(d.find, d.replace); if (next !== cur) { changes.push({ id: d.id, line: i + 1, before: cur.trim(), after: next.trim() }); cur = next; } }
		}
		return cur;
	}).join('\n');
	return { text: out, changes };
}

/** The app files of a folder (utilities/*.yaml), migrated in place unless dryRun. Returns {files, changes}. */
export function migrateApp(dir, { dryRun = false, deprecations = DEPRECATIONS } = {}) {
	const ud = path.join(dir, 'utilities');
	if (!fs.existsSync(ud)) throw new Error(`no app found in ${dir}: an app folder holds utilities/<id>.yaml`);
	const files = fs.readdirSync(ud).filter((f) => /\.ya?ml$/.test(f)).sort();
	const all = [];
	for (const f of files) {
		const p = path.join(ud, f), before = fs.readFileSync(p, 'utf8'), r = migrateText(before, deprecations);
		if (r.changes.length) { all.push(...r.changes.map((c) => ({ file: path.join('utilities', f), ...c }))); if (!dryRun) fs.writeFileSync(p, r.text); }
	}
	return { files, changes: all, dryRun };
}

export function cmdMigrate(args, die) {
	const dir = args.find((a) => !a.startsWith('--'));
	if (!dir) die('usage: ./bolt-apps migrate <app-folder> [--dry-run]');
	let r; try { r = migrateApp(dir, { dryRun: args.includes('--dry-run') }); } catch (e) { die(e.message); }
	if (!r.changes.length) { console.log(`nothing to migrate in ${dir}: no key it uses is deprecated (${DEPRECATIONS.length} deprecation${DEPRECATIONS.length === 1 ? '' : 's'} known)`); return; }
	for (const c of r.changes) console.log(`${r.dryRun ? 'would change' : 'changed'} ${c.file}:${c.line} (${c.id})\n  - ${c.before}\n  + ${c.after}`);
}
