// Run: node --test toolkit/test/cold-agent.test.mjs
// Defects found by agents that built an app from the guide and a clean checkout: sample mode in check, stale goldens, the engine's own
// error row, what check prints on a missing text, stubs that vary by argument, icons, permissions, pack and folder verify, and --help.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const CLI = path.join(REPO, 'toolkit/bin/bolt-apps.mjs');
const run = (cwd, ...a) => spawnSync(process.execPath, [CLI, ...a], { cwd, encoding: 'utf8' });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bolt-cold-'));
const write = (f, c) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); };
const copyExample = (name, dest) => { fs.cpSync(path.join(REPO, 'kit/examples', name), dest, { recursive: true }); fs.rmSync(path.join(dest, 'scripts/__pycache__'), { recursive: true, force: true }); return dest; };

// A tiny kit app: prints the sample flag, and the answer of a tool called with two different subcommands.
function toolApp(root, cases) {
	const dir = path.join(root, 'tool-app');
	write(path.join(dir, 'bolt-app.json'), JSON.stringify({ schema_version: 1, id: 'tool-app', title: 'Tool', role: 'Me', saves: 'A tool', summary: 'Tool.', author: { name: 'T' }, tier: 3, permissions: ['runs_commands'], platforms: ['macos', 'linux'] }));
	write(path.join(dir, 'utilities', 'tool.yaml'), 'schema_version: 1\nruntime: bridge\nid: tool-app\nchip: tool-app\ntitle: "Tool"\nicon: terminal\ndescription: "Tool"\nemits: Generic\nargs:\n  - { name: view, from: "query.word(0)", default: overview }\nbridge:\n  command:\n    macos: "python3 {{scripts_dir}}/tool-app__t.py {{view}} {{scripts_dir}}/tool-app__bolt_app_kit.py"\n    linux: "python3 {{scripts_dir}}/tool-app__t.py {{view}} {{scripts_dir}}/tool-app__bolt_app_kit.py"\n  parse: json\n  timeout_seconds: 10\npresentation:\n  widget: list\n  title_field: title\n  view_arg: view\n  views:\n    overview: {}\n');
	write(path.join(dir, 'scripts', 'tool-app__t.py'), 'import os, subprocess, sys\nimport importlib.util as u\ns = u.spec_from_file_location("bolt_app_kit", os.path.join(os.path.dirname(os.path.abspath(__file__)), "tool-app__bolt_app_kit.py"))\nkit = u.module_from_spec(s)\nsys.modules["bolt_app_kit"] = kit\ns.loader.exec_module(kit)\nrows = [kit.row("sample=" + os.environ.get("BOLT_APP_FIXTURE", "unset"), "x")]\nfor sub in ("status", "log"):\n    r = kit.run(["mytool", sub], timeout=5)\n    rows.append(kit.row(sub + ": " + (r.out.strip() or "empty"), "rc %s" % r.rc))\nrows.append(kit.row("env=" + os.environ.get("MYVAR", "none"), "x"))\nkit.emit(rows)\n');
	write(path.join(dir, 'check.json'), JSON.stringify({ script: 'scripts/tool-app__t.py', interpreter: 'python3', manifest_actions: 1, kit: 'scripts/tool-app__bolt_app_kit.py', cases }, null, 2));
	assert.equal(run(root, 'kit', 'vendor', '--flat', dir).status, 0);
	return dir;
}

test('check: sample mode is chosen by the case or by check.json, and is off when neither says so', () => {
	const d = toolApp(tmp(), [
		{ name: 'unset', os: 'macos', args: [], stubs: { mytool: { stdout: 'a' } }, expect: { text_present: ['sample=unset'] } },
		{ name: 'on by the case', os: 'macos', args: [], fixture: true, stubs: { mytool: { stdout: 'a' } }, expect: { text_present: ['sample=1'] } },
		{ name: 'off by the case', os: 'macos', args: [], fixture: false, stubs: { mytool: { stdout: 'a' } }, expect: { text_present: ['sample=0'] } },
	]);
	const r = run(path.dirname(d), 'check', d); assert.equal(r.status, 0, r.stdout);
	const c = JSON.parse(fs.readFileSync(path.join(d, 'check.json'), 'utf8')); c.fixture = true; c.cases = [c.cases[0], c.cases[2]];
	fs.writeFileSync(path.join(d, 'check.json'), JSON.stringify(c));
	assert.equal(run(path.dirname(d), 'check', d).status, 1, 'the whole app in sample mode makes "unset" read sample=1');
});

test('check: stubs can answer by argument, and a case can set environment variables', () => {
	const d = toolApp(tmp(), [{ name: 'two subcommands', os: 'macos', args: [], env: { MYVAR: 'hello', PATH: '/nope' },
		stubs: { mytool: { stdout: 'default', by_args: [{ args: ['status'], stdout: 'clean tree' }, { args: ['log'], stdout: 'two commits', rc: 3 }] } },
		expect: { text_present: ['status: clean tree', 'log: two commits', 'env=hello'] } }]);
	const r = run(path.dirname(d), 'check', d); assert.equal(r.status, 0, r.stdout);   // status answered 'clean tree', log answered 'two commits' with rc 3, MYVAR reached the script, PATH stayed the stub folder
});

test('check: a missing expected text prints the first rows that WERE found', () => {
	const d = toolApp(tmp(), [{ name: 'wrong text', os: 'macos', args: [], stubs: { mytool: { stdout: 'a' } }, expect: { text_present: ['not there'] } }]);
	const r = run(path.dirname(d), 'check', d); assert.equal(r.status, 1);
	assert.match(r.stdout, /The first rows were: .*sample=unset/);
});

test('check: a script that prints its own "not set up correctly" row is reported as that, not as missing text', () => {
	const root = tmp(), d = copyExample('lookup-template', path.join(root, 'lookup-template'));
	const cfgp = path.join(d, 'scripts/lookup-template__config.json'), cfg = JSON.parse(fs.readFileSync(cfgp, 'utf8')); cfg.overview = undefined; cfg.app.icon = 'no-such-icon'; fs.writeFileSync(cfgp, JSON.stringify(cfg));
	const r = run(root, 'check', d, '--update-golden'); assert.equal(r.status, 1);
	assert.match(r.stdout, /app_error_row/); assert.match(r.stdout, /icon "no-such-icon"/);
	assert.doesNotMatch(r.stdout, /expected_text_missing/);
});

test('check: a golden file no case names is an error with the fix, and passes once named or deleted', () => {
	const root = tmp(), d = copyExample('system-glance', path.join(root, 'system-glance'));
	assert.equal(run(root, 'check', d).status, 0);
	write(path.join(d, 'golden', 'left-over.json'), '[]\n');
	const r = run(root, 'check', d); assert.equal(r.status, 1); assert.match(r.stdout, /golden_stale/); assert.match(r.stdout, /Delete it/);
	fs.rmSync(path.join(d, 'golden', 'left-over.json'));
	assert.equal(run(root, 'check', d).status, 0);
});

test('lint: an icon not in the launcher list is a warning in the app file and an error in scripts/config.json; listed icons pass', () => {
	const root = tmp(), d = copyExample('lookup-template', path.join(root, 'lookup-template'));
	assert.equal(run(root, 'lint', d, '--personal').status, 0);
	const y = path.join(d, 'utilities', 'lookup-template.yaml'); fs.writeFileSync(y, fs.readFileSync(y, 'utf8').replace(/^icon: .*$/m, 'icon: no-such-icon'));
	let r = run(root, 'lint', d, '--personal'); assert.equal(r.status, 0, 'an unknown icon in the app file is a warning: the launcher draws a plug'); assert.match(r.stdout, /icon_unknown/); assert.match(r.stdout, /kit\/schema\/icons\.json/);
	fs.writeFileSync(y, fs.readFileSync(y, 'utf8').replace(/^icon: .*$/m, 'icon: cloud-sun'));
	const c = path.join(d, 'scripts', 'lookup-template__config.json'), cfg = JSON.parse(fs.readFileSync(c, 'utf8')); cfg.lookup.rows[0].icon = 'no-such-icon'; fs.writeFileSync(c, JSON.stringify(cfg));
	r = run(root, 'lint', d, '--personal'); assert.equal(r.status, 1); assert.match(r.stdout, /scripts\/lookup-template__config\.json lookup\.rows\[0\]\.icon/);
});

test('lint: declared permissions that disagree with the computed ones warn, and say which wins', () => {
	const root = tmp(), d = copyExample('system-glance', path.join(root, 'system-glance'));
	const r = run(root, 'lint', d, '--personal', '--json'); const j = JSON.parse(r.stdout);
	assert.equal(JSON.stringify(j).includes('permissions_differ'), false, 'system-glance declares exactly what is computed');
	const lp = path.join(d, 'bolt-app.json'), l = JSON.parse(fs.readFileSync(lp, 'utf8'));
	l.permissions = ['runs_commands', 'files', 'network']; fs.writeFileSync(lp, JSON.stringify(l));   // declared extras are fine for a script app
	assert.equal(JSON.stringify(JSON.parse(run(root, 'lint', d, '--personal', '--json').stdout)).includes('permissions_differ'), false);
	l.permissions = ['files']; fs.writeFileSync(lp, JSON.stringify(l));   // a computed permission left out warns, and the message says which list wins
	const r2 = run(root, 'lint', d, '--personal'); assert.equal(r2.status, 0);
	assert.match(r2.stdout, /permissions_differ/); assert.match(r2.stdout, /computed but not declared: .*runs_commands/); assert.match(r2.stdout, /computed list wins/);
});

test('verify: a pack and its folder agree about platforms (a pack records none, so no OS command is reported missing)', () => {
	const root = tmp(), d = copyExample('system-glance', path.join(root, 'system-glance'));
	const key = path.join(root, 'k.pem'); assert.equal(run(root, 'keygen', '--out', key).status, 0);
	const out = path.join(root, 'sg.boltpack'); assert.equal(run(root, 'pack', d, '--personal', '--key', key, '--out', out).status, 0);
	const f = run(root, 'verify', d); const p = run(root, 'verify', out);
	assert.doesNotMatch(f.stdout, /command_os_missing/); assert.doesNotMatch(p.stdout, /command_os_missing/);
});

test('help lists every command and --version prints the version', () => {
	const h = run(REPO, '--help').stdout;
	for (const w of ['new', 'lint', 'check', 'kit vendor', 'keygen', 'pack', 'verify', '--version']) assert.ok(h.includes(w), w);
	assert.match(run(REPO, '--version').stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('workflow: new <template> <id> -> run -> ship passes from a fresh copy, with no hand edits', () => {
	const root = tmp(), home = path.join(root, 'home'); fs.mkdirSync(home);
	const env = { ...process.env, HOME: home, USERPROFILE: home };
	const sh = (...a) => spawnSync(process.execPath, [CLI, ...a], { cwd: root, encoding: 'utf8', env });
	const n = sh('new', 'script-template', 'my-tool'); assert.equal(n.status, 0, n.stdout + n.stderr); assert.match(n.stdout, /check passes/);
	assert.ok(!fs.existsSync(path.join(root, 'my-tool', 'golden', 'left-over.json')));
	const r = sh('run', 'my-tool', 'items', '--sample'); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /Landscape with Saint John on Patmos/); assert.match(r.stdout, /right pane: entity_preview/); assert.match(n.stdout, /change first: the API: in scripts\/my-tool__config\.json set api\.base_url/);
	const j = JSON.parse(sh('run', 'my-tool', '--sample', '--json').stdout); assert.ok(Array.isArray(j));
	const s1 = sh('ship', 'my-tool'); assert.equal(s1.status, 0, s1.stdout + s1.stderr); assert.match(s1.stdout, /Shipped my-tool 1\.0\.\d+/); assert.match(s1.stdout, /type =my-tool/);
	const v1 = /Shipped my-tool (\S+):/.exec(s1.stdout)[1];
	const s2 = sh('ship', 'my-tool'); const v2 = /Shipped my-tool (\S+):/.exec(s2.stdout)[1]; assert.ok(Number(v2.split('.')[2]) > Number(v1.split('.')[2]), `${v2} must be higher than ${v1}`);
	assert.ok(!fs.existsSync(path.join(root, 'my-tool', 'scripts', '__pycache__')));
});

test('workflow: run and ship refuse a folder that holds a real-looking key; doctor reports fixes', () => {
	const root = tmp(), home = path.join(root, 'home'); fs.mkdirSync(home);
	const env = { ...process.env, HOME: home, USERPROFILE: home };
	const sh = (...a) => spawnSync(process.execPath, [CLI, ...a], { cwd: root, encoding: 'utf8', env });
	assert.equal(sh('new', 'script-template', 'leaky').status, 0);
	fs.writeFileSync(path.join(root, 'leaky', 'scripts', 'notes.txt'), 'token ghp_' + 'a'.repeat(36));
	for (const c of ['run', 'ship']) { const r = sh(c, 'leaky', '--sample'); assert.equal(r.status, 1); assert.match(r.stderr, /shaped like a real key/); assert.doesNotMatch(r.stdout + r.stderr, /ghp_a{36}/); }
	const d = sh('doctor'); assert.equal(d.status, 1); assert.match(d.stdout, /bolt-apps keygen/);
});

test('check: text_on_disk fails a script that wrote a secret into its cache (the check case lists it in home_absent)', () => {
	const root = tmp(), d = copyExample('script-template', path.join(root, 'script-template'));
	const cj = path.join(d, 'check.json'), c = JSON.parse(fs.readFileSync(cj, 'utf8'));
	c.cases.push({ name: 'a secret in the environment never reaches the cache', os: 'macos', args: ['overview'], env: { LEAK_TOKEN: 'tpl-leak-1234567890' }, expect: { home_absent: ['tpl-leak-1234567890'] } });
	fs.writeFileSync(cj, JSON.stringify(c, null, 2));
	assert.equal(run(root, 'check', d).status, 0);
	const sp = path.join(d, 'scripts/script-template__app.py'), t = fs.readFileSync(sp, 'utf8');
	assert.ok(t.includes('        self.fresh.put(key, val)'));
	fs.writeFileSync(sp, t.replace('        self.fresh.put(key, val)', '        val["leak"] = os.environ.get("LEAK_TOKEN", "")\n        self.fresh.put(key, val)'));
	const r = run(root, 'check', d); assert.equal(r.status, 1); assert.match(r.stdout, /text_on_disk/);
});

test('ship and doctor: a bolt-app.json that is JSON null (or a list) gives a plain error, not a crash and not "not valid JSON"', () => {
	const root = tmp(), home = path.join(root, 'home'); fs.mkdirSync(home);
	const env = { ...process.env, HOME: home, USERPROFILE: home };
	const sh = (...a) => spawnSync(process.execPath, [CLI, ...a], { cwd: root, encoding: 'utf8', env });
	assert.equal(sh('new', 'script-template', 'odd').status, 0);
	for (const body of ['null', '[]', '7']) {
		fs.writeFileSync(path.join(root, 'odd', 'bolt-app.json'), body);
		const s1 = sh('ship', 'odd'); assert.equal(s1.status, 1); assert.match(s1.stderr, /must be a JSON object/); assert.doesNotMatch(s1.stderr + s1.stdout, /TypeError|at .*\.mjs/);
		const d = sh('doctor', 'odd'); assert.equal(d.status, 1); assert.match(d.stdout, /is a JSON object/); assert.doesNotMatch(d.stdout, /not valid JSON/);
	}
});

test('the repo-root bolt-apps launcher runs the toolkit from any folder, through a symlink, and says so when node is missing', { skip: process.platform === 'win32' ? 'POSIX ./bolt-apps; Windows uses bolt-apps.cmd (windows-launcher.test.mjs)' : false }, () => {
	const launcher = path.join(REPO, 'bolt-apps');
	assert.ok(fs.statSync(launcher).mode & 0o111, 'bolt-apps is executable');
	const root = tmp();
	const run1 = (cmd, args, env = process.env) => spawnSync(cmd, args, { cwd: root, encoding: 'utf8', env });
	assert.match(run1(launcher, ['--version']).stdout.trim(), /^\d+\.\d+\.\d+$/);
	assert.match(run1(launcher, ['--help']).stdout, /new <template> <id>/);
	const link = path.join(root, 'bolt-apps-link'); fs.symlinkSync(launcher, link);
	assert.match(run1(link, ['--version']).stdout.trim(), /^\d+\.\d+\.\d+$/);
	const hop1 = path.join(root, 'hop1'), hop2 = path.join(root, 'sub', 'hop2'); fs.mkdirSync(path.join(root, 'sub'));
	fs.symlinkSync(launcher, hop1); fs.symlinkSync(path.join('..', 'hop1'), hop2);   // a two-link chain, the second one with a relative target
	assert.match(run1(hop2, ['--version']).stdout.trim(), /^\d+\.\d+\.\d+$/);
	const fake = path.join(root, 'oldnode'); fs.mkdirSync(fake);   // a node that says it is version 16
	fs.writeFileSync(path.join(fake, 'node'), '#!/bin/sh\ncase "$1" in -p) echo 16 ;; -v) echo v16.0.0 ;; *) echo ran ;; esac\n', { mode: 0o755 });
	const old = run1('/bin/sh', [launcher, '--version'], { PATH: `${fake}:/usr/bin:/bin` });
	assert.equal(old.status, 127); assert.match(old.stderr, /Node 18 or newer is needed; this is Node v16/);
	const nonode = run1('/bin/sh', [launcher, '--version'], { PATH: '/nonexistent' });
	assert.equal(nonode.status, 127); assert.match(nonode.stderr, /Node 18 or newer is needed/);
});

test('workflow: ship of a transform app says it skipped check and does not call it a script', () => {
	const root = tmp(), home = path.join(root, 'home'); fs.mkdirSync(home);
	const env = { ...process.env, HOME: home, USERPROFILE: home };
	const sh = (...a) => spawnSync(process.execPath, [CLI, ...a], { cwd: root, encoding: 'utf8', env });
	assert.equal(sh('new', 'flip', '--type', 'transform').status, 0);
	const s = sh('ship', path.join('apps', 'flip')); assert.equal(s.status, 0, s.stdout + s.stderr);
	assert.match(s.stdout, /skip check: no check\.json/);
	assert.match(s.stdout, /rates the app MEDIUM risk: it runs no command and no script/);
	assert.doesNotMatch(s.stdout, /HIGH risk|runs a script on your computer|as its script says|This app runs as you/);
	assert.match(s.stdout, /type =flip/);
});
