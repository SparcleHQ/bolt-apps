// Run: node --test toolkit/test/leak-scan.test.mjs
// This repo is public. Nothing internal may ship in any tracked file: internal host names, machine or agent
// names, absolute home paths, secrets, personal emails, addresses of real machines. A hit fails the suite.
// The list is conservative on purpose. Each SUPPRESSED entry below is a known false positive, with the reason it is public.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Every file git tracks is scanned (the whole repo is public), except this file, which holds the patterns it looks for.

const DENY = [
	['internal host name', /\b[a-z0-9-]+(\.[a-z0-9-]+)*\.(local|internal|corp|lan|localdomain|intranet)\b/i],
	['device name', /\b(evo-?x2|win-do|bolt-do|macbook[- ]?(air|pro)?[-\w]*)\b/i],
	['agent name or fleet tool', /\b(agent\/[a-z0-9-]+|Co-Authored-By|wt (new|register|ready|goal)|bolt-ship|bolt-devkit|subagent)\b/],
	['internal repo or source file name', /\b(bolt-native|bolt-pwa|bolt-api|bolt-common|aeira-rs)\b|\b(executor|contract|pack_validate|pack_install|http_local|userAppNav|userAppWidget|userAppSchema|widgetRows|widgetImage|widgetBind|utilityIconMap)\.(rs|ts)\b|\bChartWidget\.svelte\b|\bSECRET_NAME_PARTS\b/],
	['absolute home path', /(\/Users\/[A-Za-z0-9._-]+|\/home\/[A-Za-z0-9._-]+|C:\\Users\\[A-Za-z0-9._-]+|~\/dev\b)/],
	['token-shaped string', /\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,})/],
	['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
	['email address', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/],
	['IP address', /\b(?:\d{1,3}\.){3}\d{1,3}\b/],
	['the word sparcle', /sparcle/i],
];
// Allowed values, per rule.
const OK_EMAIL = /@(example\.(com|org|net)|users\.noreply\.github\.com|sparcle\.app)$/i;                       // reserved example domains, GitHub's no-reply, and the project's public contact domain
const OK_IP = (ip) => /^(127\.\d+\.\d+\.\d+|0\.0\.0\.0|1\.1\.1\.1|1\.0\.0\.1|8\.8\.8\.8|8\.8\.4\.4|192\.0\.2\.\d+|198\.51\.100\.\d+|203\.0\.113\.\d+)$/.test(ip) || ip.split('.').some((n) => Number(n) > 255); // loopback, wildcard, public resolvers, RFC 5737 documentation ranges; a version number such as 1.2.3.4567 is not an address
// "sparcle" is allowed only: in an author block, inside a URL (github.com/SparcleHQ, sparcle.app), or in these public product phrases.
// The project's own governance files may name the company that publishes it.
// The legal notices must name the company that holds the copyright and the trademarks (Apache-2.0 NOTICE, third-party notices, legal notes): exactly these files.
const OK_SPARCLE_FILES = /^(\.github\/|[A-Z_]+\.md$|toolkit\/README\.md$|NOTICE$|THIRD-PARTY-NOTICES\.md$|docs\/LEGAL\.md$)/;
// app.sparcle.bolt is the public product data folder name that Bolt itself shows in its install screens; the Mentions mirror must match Bolt's regex exactly (the second entry is that regex as written in source).
const OK_SPARCLE_PHRASES = [/app\.sparcle\.bolt\b/, /app\\\.sparcle\\\.bolt/, /app\.sparcle\.bolt\.enterprise/, /signed by a Sparcle or company key/, /Sparcle or your company signed it/, /Sparcle-signed bundles/, /Reviewed by Sparcle/, /Sparcle maintainer/, /pull requests from outside Sparcle/, /Sparcle checked this version/, /signed by Sparcle\. This pack/, /signed by its author, not by Sparcle\."/];   // the last is the literal 181 install-dialog sentence
const SUPPRESSED = [
	[/Claude Code/, 'AGENTS.md addresses AI coding agents by product name; no device or fleet name'],
];

const TEXT = /\.(md|json|ya?ml|py|mjs|js|txt|out|rc|csv|sh|toml)$/i;
export function files() {
	const list = spawnSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout.split('\0').filter(Boolean);
	const out = [];
	for (const rel of list) {
		if (rel === 'toolkit/test/leak-scan.test.mjs') continue;
		const f = path.join(REPO, rel);
		if (!fs.existsSync(f) || !fs.statSync(f).isFile()) continue;
		const b = fs.readFileSync(f);
		if (!b.includes(0)) out.push(f);
	}
	return out;
}
// Hits in one text: [{ line, rule, text }]
export function scan(text, rel = '') {
	const hits = [], lines = text.split('\n');
	lines.forEach((line, i) => {
		const add = (rule, t) => hits.push({ line: i + 1, rule, text: t.slice(0, 80) });
		for (const [rule, re] of DENY) {
			const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
			for (const m of line.matchAll(g)) {
				if (rule === 'email address' && (OK_EMAIL.test(m[0]) || /:\/\/[^\s@/]*$/.test(line.slice(0, m.index)))) continue;   // a user@host inside a URL is a URL userinfo test string, not an address
				if (rule === 'IP address' && OK_IP(m[0])) continue;
				if (rule === 'internal host name' && /^(\w+\.)?(py|json|yaml|yml|md|mjs|js)$/.test(m[0])) continue;
				if (rule === 'the word sparcle') {
					if (OK_SPARCLE_FILES.test(rel)) continue;
					const around = line.slice(Math.max(0, m.index - 60), m.index + 60);
					if (/github\.com\/SparcleHQ/i.test(around) || /https?:\/\/[^\s"')>]*sparcle\.app/i.test(around) || /\bsparcle\.app\b/i.test(around)) continue;
					if (/"author"\s*:/.test(line) || /^\s*(author|"name")\s*:.*sparcle/i.test(line)) continue;
					if (OK_SPARCLE_PHRASES.some((p) => p.test(line))) continue;
					// One deliberate, narrow exception: the shared-kit manifest names this public repository as its source. Those bytes are pinned by a hash table in the Bolt app, so the string cannot be reworded.
					if (rel === 'toolkit/lib/shared.mjs' && line.trim().includes("manifest.source = { repo: 'SparcleHQ/bolt-apps', sha:")) continue;
				}
				add(rule, m[0]);
			}
		}
	});
	return hits;
}

test('leak scan: the detector flags each kind of leak and passes the allowed look-alikes', () => {
	const bad = {
		'internal host name': 'ssh builder.corp', 'device name': 'run on evo-x2', 'agent name or fleet tool': 'branch agent/portal-template',
		'absolute home path': 'cd /Users/alex/dev', 'token-shaped string': 'key ghp_abcdefghijklmnopqrstuvwxyz0123',
		'email address': 'mail alex@acme.io', 'IP address': 'host 10.20.30.40', 'the word sparcle': 'ask Sparcle for access',
	};
	for (const [rule, text] of Object.entries(bad)) assert.ok(scan(text).some((h) => h.rule === rule), `${rule} not flagged in: ${text}`);
	const ok = ['ada@example.com', 'bind 127.0.0.1:3000 and 0.0.0.0', 'ping 1.1.1.1', 'version 1.2.3.4567', 'https://github.com/SparcleHQ/bolt-apps', '"author": { "name": "Sparcle" }', 'see https://sparcle.app/docs/', 'config.json and engine.py', 'Reviewed by Sparcle badge'];
	for (const text of ok) assert.deepEqual(scan(text), [], text);
});

test('leak scan: every tracked file holds nothing internal', () => {
	const found = [];
	for (const f of files()) { const rel = path.relative(REPO, f).split(path.sep).join('/'); for (const h of scan(fs.readFileSync(f, 'utf8'), rel)) found.push(`${rel}:${h.line} [${h.rule}] ${h.text}`); }
	assert.deepEqual(found, [], `leaks found:\n${found.join('\n')}`);
});

test('leak scan: the one shared-kit manifest exception is narrow (that file, that line, nothing else)', () => {
	const line = "if (opts.sourceSha) manifest.source = { repo: 'SparcleHQ/bolt-apps', sha: opts.sourceSha };";
	assert.deepEqual(scan(line, 'toolkit/lib/shared.mjs'), []);
	assert.ok(scan(line, 'toolkit/lib/other.mjs').some((h) => h.rule === 'the word sparcle'));
	assert.ok(scan("const x = 'Sparcle internal';", 'toolkit/lib/shared.mjs').some((h) => h.rule === 'the word sparcle'));
});
