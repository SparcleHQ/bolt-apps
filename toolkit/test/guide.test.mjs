// Run: node --test toolkit/test/guide.test.mjs
// The guide must never tell an agent to do something Bolt rejects. Every command line in the docs is run, the worked
// example goes through lint, verify and pack, and every code the guide names is a code verify can emit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXES } from '../lib/verify.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '../bin/bolt-apps.mjs');
const REPO = path.resolve(HERE, '../..');
const DOCS = ['AGENTS.md', 'CHECKER.md', 'CONTRIBUTING.md', 'toolkit/README.md'];
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
const CASES = JSON.parse(read('conformance/verify-cases.json'));
const write = (f, c) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); };
const SUBCOMMANDS = ['new', 'lint', 'check', 'keygen', 'pack', 'verify', 'kit'];
const FLAGS = { new: ['--type', '--dir', '--author'], lint: ['--json', '--personal'], check: ['--json', '--os', '--case', '--update-golden'], keygen: ['--out'], pack: ['--key', '--out', '--version', '--notes', '--personal'], verify: ['--json'], kit: [] };

// Every command line inside a fenced block of the guide.
function commandLines() {
	const out = [];
	for (const f of DOCS) {
		let fence = false, future = false;
		read(f).split('\n').forEach((line, i) => {
			if (/^## /.test(line)) future = f === 'CHECKER.md' && /^## (Run it|Machine-readable)/.test(line); // documents the checker CLI that is not published yet
			if (line.startsWith('```')) { fence = !fence; return; }
			if (future) return;
			const m = fence && /^\s*(?:node toolkit\/bin\/bolt-apps\.mjs|bolt-apps)\s+(.*?)\s*(?:#.*)?$/.exec(line);
			if (m) out.push({ doc: f, line: i + 1, text: m[0].trim(), args: m[1] });
		});
	}
	return out;
}
const LINES = commandLines();

test('the guide documents commands (so this test cannot pass by finding none)', () => {
	assert.ok(LINES.length >= 15, `found ${LINES.length}`);
	assert.ok(LINES.some((l) => /pack .*--personal/.test(l.args)) && LINES.some((l) => /^verify /.test(l.args)));
});

test('every documented command line uses a real subcommand and real flags', () => {
	for (const l of LINES) {
		const [sub, ...rest] = l.args.split(/\s+/);
		assert.ok(SUBCOMMANDS.includes(sub), `${l.doc}:${l.line} unknown subcommand: ${l.text}`);
		for (const t of rest.filter((x) => x.startsWith('--'))) assert.ok(FLAGS[sub].includes(t), `${l.doc}:${l.line} unknown flag ${t} for ${sub}: ${l.text}`);
	}
});

// Run the documented lines against real fixtures. `check` and `kit` are exercised by kit.test.mjs.
function workspace(script) {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bolt-guide-')), env = { ...process.env, HOME: d, USERPROFILE: d };
	const sh = (...a) => spawnSync(process.execPath, [CLI, ...a], { cwd: d, env, encoding: 'utf8' });
	assert.equal(sh('keygen').status, 0);
	if (script) {
		const dir = path.join(d, 'apps', 'demo-app');
		write(path.join(dir, 'bolt-app.json'), JSON.stringify({ schema_version: 1, id: 'demo-app', title: 'Demo', role: 'Me', saves: 'Time', author: { name: 'T' }, tier: 3, permissions: ['runs_commands'] }));
		write(path.join(dir, 'utilities', 'demo-app.yaml'), CASES.base['utilities/eagle-info.yaml'].replace('eagle.py', 'demo.py').replace('eagle.py', 'demo.py').replace(/id: eagle-info/, 'id: demo-app'));
		write(path.join(dir, 'scripts', 'demo.py'), "print('[]')\n");
		assert.equal(sh('pack', 'apps/demo-app', '--personal').status, 0);
	} else assert.equal(sh('new', 'demo-app', '--type', 'transform').status, 0);
	return { d, sh };
}
const subst = (a, script) => a.replace(/<app-folder[^>]*>|<folder>/g, 'apps/demo-app').replace(/<id>/g, 'demo-app').replace(/my-app/g, 'demo-app').replace(/<the folder or the pack>/g, 'apps/demo-app').replace(/\|[a-z]+(\|[a-z]+)+/g, '');
test('every documented lint, pack, verify, keygen and new line runs and exits 0 on a fixture', () => {
	let ran = 0;
	for (const l of LINES) {
		const [sub] = l.args.split(/\s+/);
		if (['check', 'kit'].includes(sub)) continue;
		const personalPath = /--personal|<folder>|\.boltpack|<app-folder/.test(l.args);
		const { d, sh } = workspace(personalPath);
		let a = subst(l.args, personalPath).split(/\s+/);
		if (sub === 'keygen') { fs.rmSync(path.join(d, '.bolt-apps'), { recursive: true }); }
		if (sub === 'new') a = a.map((x) => (x === 'demo-app' || x === 'my-app' ? 'fresh-app' : x)).map((x) => (x === 'snippet|search|transform|recognizer' ? 'snippet' : x));
		a = a.map((x) => x.replace(/^snippet\|.*$/, 'snippet')).map((x) => (x === 'my-app' ? 'demo-app' : x)).map((x) => (x === 'my-app.boltpack' ? 'demo-app.boltpack' : x));
		const r = sh(...a);
		assert.equal(r.status, 0, `${l.doc}:${l.line}  ${l.text}\n${r.stdout}${r.stderr}`);
		ran++;
	}
	assert.ok(ran >= 10, `ran ${ran}`);
});

test('the worked example in AGENTS.md goes through lint, verify and pack', () => {
	const md = read('AGENTS.md'), sec = md.slice(md.indexOf('## 9. Worked example'));
	const yaml = /```yaml\n([\s\S]*?)```/.exec(sec)[1], json = /```json\n([\s\S]*?)```/.exec(sec)[1];
	const { d, sh } = workspace(false);
	write(path.join(d, 'apps/sorted-unique-lines/utilities/sortu.yaml'), yaml); write(path.join(d, 'apps/sorted-unique-lines/bolt-app.json'), json);
	for (const a of [['lint', 'apps/sorted-unique-lines'], ['verify', 'apps/sorted-unique-lines'], ['pack', 'apps/sorted-unique-lines'], ['verify', 'sorted-unique-lines.boltpack']]) { const r = sh(...a); assert.equal(r.status, 0, a.join(' ') + r.stdout + r.stderr); }
});

test('every verify code the guide names exists, and every Bolt error it quotes comes from the conformance cases', () => {
	const md = read('AGENTS.md'), s = md.slice(md.indexOf('## 4b.'), md.indexOf('## 5. Check'));
	const GALLERY_AND_LINT = ['tier3_not_accepted'];
	const named = [...s.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]).filter((c) => !['bolt_app_kit', 'scripts_dir', 'timeout_seconds'].includes(c));
	assert.ok(named.length >= 10);
	for (const c of named) assert.ok(c in FIXES || GALLERY_AND_LINT.includes(c), `4b names ${c}, which verify never emits`);
	const rows = [...s.matchAll(/^\| (.+?) \| `([a-z_]+)` \|$/gm)].filter((m) => m[2] in FIXES);
	assert.ok(rows.length >= 10);
	for (const [, said, code] of rows) {
		for (const part of said.split(' or ').map((p) => p.replace(/^`|`$/g, '').replace(/\\`/g, '`'))) {
			const ok = CASES.cases.some((c) => c.expect.includes(code) && (c.bolt_error_contains || '').includes(part.replace(/^Bolt's error contains /, '')));
			assert.ok(ok, `no conformance case ties "${part}" to ${code}`);
		}
	}
});

test('the guide never sends a person to Admin settings except to say not to', () => {
	for (const f of DOCS) for (const line of read(f).split('\n')) if (/Admin settings/.test(line)) assert.match(line, /\b(not|never|Do not)\b/i, `${f}: ${line}`);
});

test('gallery wording: tier 1 and 2 only, own-use tier 3 through --personal', () => {
	assert.match(read('AGENTS.md'), /takes tier 1 and 2 only/); assert.match(read('CONTRIBUTING.md'), /takes tier 1 and 2 only/);
	assert.match(read('CHECKER.md'), /takes tier 1 and 2 only/); assert.match(read('toolkit/README.md'), /takes tier 1 and 2 only/);
	for (const f of DOCS.filter((x) => x !== 'CHECKER.md')) assert.match(read(f), /--personal/, f);
});
