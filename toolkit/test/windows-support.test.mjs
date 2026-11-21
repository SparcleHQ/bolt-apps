// Native Windows support: check stubs, USERPROFILE isolation, doctor, bolt-apps.cmd.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkApp, formatReport, hostOs, reportOk, vendorKit } from '../lib/check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const CLI = path.join(REPO, 'toolkit', 'bin', 'bolt-apps.mjs');
const HOSTILE = 'a\u202eb\u200bc{{x}}\u{E0041}d\u2028e\u0007f\u3164g\u2800h';
const codes = (f) => f.map((x) => x.code);
const cli = (home, args, extra = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 120000, env: { ...process.env, HOME: home, USERPROFILE: home, ...extra } });

function tinyApp(script, cases) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bolt-win-'));
	const id = 'wintiny';
	const dir = path.join(root, id);
	fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
	fs.writeFileSync(path.join(dir, 'bolt-app.json'), JSON.stringify({ schema_version: 1, id, title: 'Win Tiny', role: 'test', saves: 'test', summary: 'test', author: { name: 'Test' }, tier: 3, permissions: ['runs_commands'] }));
	fs.writeFileSync(path.join(dir, 'scripts', `${id}__app.py`), script);
	fs.writeFileSync(path.join(dir, 'check.json'), JSON.stringify({ script: `scripts/${id}__app.py`, interpreter: 'python3', kit: `scripts/${id}__bolt_app_kit.py`, cases }));
	vendorKit(dir, { flat: true });
	return dir;
}

test('formatReport: a Windows host omits Windows from the Not run footer', () => {
	const win = formatReport({ app: 'x', host_os: 'windows', findings: [], cases: [{ name: 'a', os: 'windows', ok: true, findings: [] }] });
	assert.match(win, /Not run: the real launcher, macOS, Linux, other OS tools\./);
	assert.doesNotMatch(win, /Not run: the real launcher, Windows,/);
	const mac = formatReport({ app: 'x', host_os: 'macos', findings: [], cases: [{ name: 'a', os: 'macos', ok: true, findings: [] }] });
	assert.match(mac, /Not run: the real launcher, Windows, other OS tools\./);
});

test('checkApp: portal-template and system-glance pass on this host', async () => {
	for (const name of ['portal-template', 'system-glance']) {
		const r = await checkApp(path.join(REPO, 'kit', 'examples', name));
		assert.equal(r.findings.filter((x) => x.level === 'error').length, 0, `${name} findings: ${JSON.stringify(r.findings)}`);
		assert.ok(r.cases.length, name);
		for (const c of r.cases) assert.ok(c.ok, `${name} ${c.name}: ${JSON.stringify(c.findings)}`);
		assert.ok(reportOk(r), name);
	}
});

test('check stubs: by_args, hang, and hostile UTF-8 bytes', async () => {
	const osName = hostOs() === 'other' ? 'linux' : hostOs();
	const script = `import os, json, subprocess, time
sep = os.pathsep
stubdir = os.environ["PATH"].split(sep)[0]
ext = ".cmd" if os.path.isfile(os.path.join(stubdir, "mytool.cmd")) else ""
stub = os.path.join(stubdir, "mytool" + ext)
def run(args):
    return subprocess.run([stub] + args, capture_output=True)
r1, r2, r3 = run(["status"]), run(["log"]), run(["other"])
print(json.dumps([{"title": (r1.stdout.decode("utf-8").strip() + "|" + r2.stdout.decode("utf-8").strip() + "|" + r3.stdout.decode("utf-8").strip() + "|" + str(r2.returncode)), "subtitle": "by"}]))
`;
	const d = tinyApp(script, [{
		name: 'by_args',
		os: osName,
		stubs: { mytool: { stdout: 'default', by_args: [{ args: ['status'], stdout: 'clean' }, { args: ['log'], stdout: 'two', rc: 3 }] } },
		expect: { text_present: ['clean|two|default|3'] },
	}]);
	const r = await checkApp(d);
	assert.ok(r.cases[0].ok, JSON.stringify(r.cases[0].findings));

	const hangScript = `import os, json, subprocess, time
stubdir = os.environ["PATH"].split(os.pathsep)[0]
ext = ".cmd" if os.path.isfile(os.path.join(stubdir, "slow.cmd")) else ""
stub = os.path.join(stubdir, "slow" + ext)
t0 = time.monotonic()
try:
    subprocess.run([stub], timeout=1)
except subprocess.TimeoutExpired:
    pass
dt = time.monotonic() - t0
print(json.dumps([{"title": "hung-ok" if 0.5 <= dt < 8 else "hung-bad", "subtitle": str(dt)}]))
`;
	const dh = tinyApp(hangScript, [{ name: 'hang', os: osName, hang: ['slow'], expect: { text_present: ['hung-ok'], max_seconds: 10 } }]);
	const rh = await checkApp(dh);
	assert.ok(rh.cases[0].ok, JSON.stringify(rh.cases[0].findings));

	const hex = Buffer.from(HOSTILE, 'utf8').toString('hex');
	const hostileScript = `import os, json, subprocess
stubdir = os.environ["PATH"].split(os.pathsep)[0]
ext = ".cmd" if os.path.isfile(os.path.join(stubdir, "mytool.cmd")) else ""
stub = os.path.join(stubdir, "mytool" + ext)
r = subprocess.run([stub], capture_output=True)
print(json.dumps([{"title": r.stdout.hex(), "subtitle": "h"}]))
`;
	const df = tinyApp(hostileScript, [{ name: 'hostile', os: osName, hostile: true, stubs: { mytool: { stdout: '@@HOSTILE@@' } }, expect: { text_present: [hex] } }]);
	const rf = await checkApp(df);
	assert.ok(rf.cases[0].ok, JSON.stringify(rf.cases[0].findings));
});

test('home_absent: expanduser(~) stays inside the temp home (USERPROFILE on Windows)', async () => {
	const osName = hostOs() === 'other' ? 'linux' : hostOs();
	const leak = `import os, json
p = os.path.join(os.path.expanduser("~"), "leaked.txt")
open(p, "w", encoding="utf-8").write("SECRET-LEAK-VALUE-42")
same = True if os.name != "nt" else os.environ.get("USERPROFILE") == os.environ.get("HOME")
print(json.dumps([{"title": "ok", "subtitle": "same" if same else "USERPROFILE-mismatch"}]))
`;
	const d = tinyApp(leak, [{ name: 'leak', os: osName, expect: { home_absent: ['SECRET-LEAK-VALUE-42'] } }]);
	const r = await checkApp(d);
	assert.ok(codes(r.cases[0].findings).includes('text_on_disk'), JSON.stringify(r.cases[0].findings));
	assert.equal(r.cases[0].findings.find((x) => x.code === 'text_on_disk').message.includes('SECRET-LEAK-VALUE-42'), true);
	assert.ok(!codes(r.cases[0].findings).includes('expected_text_missing'));
});

test('doctor: Windows skips chmod 600 on .env and quotes del paths with double quotes', () => {
	const src = fs.readFileSync(path.join(REPO, 'toolkit', 'lib', 'workflow.mjs'), 'utf8');
	assert.match(src, /Windows ACLs/);
	assert.match(src, /icacls/);
	assert.match(src, /del "\$\{String\(c\.file\)/);
	assert.doesNotMatch(src, /del \$\{q\(c\.file\)\}/);
	assert.match(src, /Create the folder/);

	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bolt-doc-'));
	const home = path.join(root, 'home');
	fs.mkdirSync(home);
	const id = 'windoctor';
	const dir = path.join(root, id);
	fs.mkdirSync(dir);
	fs.writeFileSync(path.join(dir, 'bolt-app.json'), JSON.stringify({ schema_version: 1, id, title: 'T', role: 'r', saves: 's', summary: 's', author: { name: 'T' }, tier: 2, permissions: [] }));
	const envFile = path.join(home, '.config', id, '.env');
	fs.mkdirSync(path.dirname(envFile), { recursive: true });
	fs.writeFileSync(envFile, 'X=1\n');
	try { fs.chmodSync(envFile, 0o666); } catch { /* win32 may ignore mode bits */ }
	const uu = path.join(root, 'uu');
	fs.mkdirSync(path.join(uu, 'scripts'), { recursive: true });
	fs.writeFileSync(path.join(uu, `${id}.yaml`), 'x');
	const d = cli(home, ['doctor', dir], { BOLT_USER_UTILS_DIR: uu });
	if (process.platform === 'win32') {
		assert.doesNotMatch(d.stdout, /chmod 600/);
		assert.doesNotMatch(d.stdout, /chmod 700/);
		assert.match(d.stdout, /Windows ACLs|icacls/);
		assert.match(d.stdout, /del "/);
		assert.doesNotMatch(d.stdout, /del '/);
	} else {
		assert.match(d.stdout, /chmod 600/);
		assert.match(d.stdout, /rm /);
	}
});

test('bolt-apps.cmd help', { skip: process.platform !== 'win32' }, () => {
	const cmd = path.join(REPO, 'bolt-apps.cmd');
	assert.ok(fs.existsSync(cmd));
	const r = spawnSync(process.env.COMSPEC || 'cmd.exe', ['/d', '/c', cmd, 'help'], { encoding: 'utf8', timeout: 30000, windowsHide: true });
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.match(r.stdout, /bolt-apps: author toolkit/);
});
