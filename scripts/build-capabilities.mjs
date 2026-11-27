#!/usr/bin/env node
// Writes kit/examples/CAPABILITIES.md from kit/examples/capabilities.json and schema/bolt-rules.json.
// {rules:a.b} in a limit is replaced by that value from the rules file, so a number is typed once.
// Run with --check to fail when the committed file is stale.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rules = JSON.parse(fs.readFileSync(path.join(REPO, 'schema/bolt-rules.json'), 'utf8'));
export const caps = JSON.parse(fs.readFileSync(path.join(REPO, 'kit/examples/capabilities.json'), 'utf8'));
export const ruleValue = (p) => p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), rules);
export const placeholders = (s) => [...String(s).matchAll(/\{rules:([a-z_.]+)\}/g)].map((m) => m[1]);
export const resolve = (s) => String(s).replace(/\{rules:([a-z_.]+)\}/g, (_, p) => { const v = ruleValue(p); if (v === undefined) throw new Error(`unknown rules path ${p}`); return typeof v === 'string' ? '`' + v + '`' : String(v); });
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function render() {
	const out = ['# What a Bolt App can do', '', '_Generated from `capabilities.json` by `scripts/build-capabilities.mjs`: edit the JSON, not this file._', '',
		'One row per capability. Status is derived from the code and `schema/bolt-rules.json`. Most rows are lint and fixture tested only; the rows that a real Bolt dev build drew on 2026-11-26 say so in their limit. The sandbox is not shipped: a personal script runs as you. To start, read [QUICKSTART.md](QUICKSTART.md); the limits are in its one rules table.', '',
		'| Capability | Status | Since | Older Bolt | Example | Proven by | Limit |', '|---|---|---|---|---|---|---|'];
	for (const r of caps.rows) out.push(`| ${cell(r.name)} | ${r.status} | ${r.since} | ${cell(r.older_bolt)} | ${r.example ? `[${path.basename(r.example)}](${path.relative('kit/examples', r.example)})` : (r.example_note || 'none')} | \`${r.test}\` | ${cell(resolve(r.limit))} |`);
	out.push('', '## Pick the version first', '', 'Use the oldest Bolt version that has what you need, and set `min_bolt_version` in `bolt-app.json` to it. A row\'s Since column is the first Bolt that reads it; Older Bolt says what happens on a Bolt before that.', '');
	const vers = [...new Set(caps.rows.filter((r) => /^0\.1\.\d+$/.test(r.since)).map((r) => r.since))].sort();
	for (const v of vers) out.push(`- **${v}**: ${caps.rows.filter((r) => r.since === v && r.status !== 'not supported').map((r) => r.name).join('; ')}`);
	for (const k of [...new Set(caps.rows.filter((r) => /^kit /.test(r.since)).map((r) => r.since))].sort()) out.push(`- **${k}** (not a Bolt version; the app vendors the kit): ${caps.rows.filter((r) => r.since === k).map((r) => r.name).join('; ')}`);
	out.push('', '## Do not use in this version', '', 'These are named so nobody builds on them. Lint refuses each one.', '');
	for (const r of caps.rows.filter((x) => x.status === 'reserved')) out.push(`- ${r.name}: ${r.limit}`);
	out.push('', '## Snippets', '');
	for (const r of caps.rows) if (r.status !== 'not supported' && r.status !== 'reserved') out.push(`### ${r.name} (\`${r.id}\`)`, '', '```', r.snippet, '```', '');
	return out.join('\n').replace(/\n+$/, '\n');
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
	const f = path.join(REPO, 'kit/examples/CAPABILITIES.md'), text = render();
	if (process.argv.includes('--check')) { if (!fs.existsSync(f) || fs.readFileSync(f, 'utf8') !== text) { console.error('kit/examples/CAPABILITIES.md is stale: run node scripts/build-capabilities.mjs'); process.exit(1); } }
	else fs.writeFileSync(f, text);
}
