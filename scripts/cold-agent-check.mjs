// cold-agent-check.mjs <app-or-parent-folder>: the checking half of the cold-agent run (scripts/cold-agent.sh).
// Finds the app a fresh agent produced (the folder holding bolt-app.json), then runs the public toolkit on it:
// lint, check and verify (lint --personal for a script app). Exit 0 only if all pass. Offline; CI runs it on a canned good and a canned bad app.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = process.env.COLD_AGENT_CLI || path.resolve(HERE, '../toolkit/bin/bolt-apps.mjs');
const root = path.resolve(process.argv[2] || '.');

function findApp(dir, depth = 0) {
	if (fs.existsSync(path.join(dir, 'bolt-app.json'))) return dir;
	if (depth > 2) return null;
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') { const f = findApp(path.join(dir, e.name), depth + 1); if (f) return f; }
	}
	return null;
}
const app = fs.existsSync(root) ? findApp(root) : null;
if (!app) { console.error('cold-agent-check: no app (no bolt-app.json) under ' + root); process.exit(2); }
const script = fs.existsSync(path.join(app, 'scripts'));
const steps = [['lint', ...(script ? ['--personal'] : [])], ['check'], ['verify']];
let failed = 0;
for (const [cmd, ...flags] of steps) {
	const r = spawnSync(process.execPath, [CLI, cmd, app, ...flags], { encoding: 'utf8' });
	console.log(`${r.status === 0 ? 'PASS' : 'FAIL'}  ${cmd} ${app}`);
	if (r.status !== 0) { failed++; console.log((r.stdout + r.stderr).split('\n').slice(0, 12).join('\n')); }
}
console.log(failed ? `cold-agent-check: ${failed} step(s) failed` : 'cold-agent-check: all steps passed');
process.exit(failed ? 1 : 0);
