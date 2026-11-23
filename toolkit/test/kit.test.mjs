// Tests for the authoring kit: the icon generator, the row contract, `bolt-apps check` and `kit vendor`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseIconKeys } from '../../kit/schema/gen-icons.mjs';
import { createHash } from 'node:crypto';
import { assessYaml } from '../lib/assess.mjs';
import { flatKitSource, checkApp, checkRows, inside, platformFindings, schemaCheck, treeHash, vendorKit, KIT_ROOT, KIT_PY } from '../lib/check.mjs';
import { pythonCmd } from '../lib/python.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXAMPLE = path.join(root, 'kit', 'examples', 'system-glance');
const CLI = path.join(root, 'toolkit', 'bin', 'bolt-apps.mjs');
const codes = (f) => f.map((x) => x.code);
// A copy of the example switched to the PACKAGE-FOLDER kit (the folder-mode guard tests need that shape; the shipped example is flat).
const tmpCopy = () => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-test-')); fs.cpSync(EXAMPLE, d, { recursive: true });
	fs.rmSync(path.join(d, 'scripts', 'system-glance__bolt_app_kit.py')); fs.rmSync(path.join(d, 'bolt_app_kit.lock.json'));
	const cfg = JSON.parse(fs.readFileSync(path.join(d, 'check.json'), 'utf8')); cfg.kit = 'scripts/bolt_app_kit'; fs.writeFileSync(path.join(d, 'check.json'), JSON.stringify(cfg));
	vendorKit(d); return d;
};

test('icon parser reads the shapes UTILITY_ICON_MAP uses', () => {
	const ts = `import x;\nexport const UTILITY_ICON_MAP: Record<string, Component> = {\n  Calculator,\n  Bolt: BoltIcon,\n  // comment\n  'credit-card': CreditCard,\n  Search, // trailing\n};\nexport function f() {}`;
	assert.deepEqual(parseIconKeys(ts), ['Bolt', 'Calculator', 'Search', 'credit-card']);
	assert.throws(() => parseIconKeys('nothing'));
});

test('icon list: schema, icons.json and the Python module agree (drift test)', () => {
	const s = JSON.parse(fs.readFileSync(path.join(KIT_ROOT, 'schema', 'row.schema.json'), 'utf8')).$defs.icon.enum;
	const j = JSON.parse(fs.readFileSync(path.join(KIT_ROOT, 'schema', 'icons.json'), 'utf8')).icons;
	const py = [...fs.readFileSync(path.join(KIT_PY, 'icons_data.py'), 'utf8').matchAll(/^\s+"([^"]+)",$/gm)].map((m) => m[1]);
	assert.deepEqual(s, j); assert.deepEqual(py, j); assert.ok(j.length > 100);
});

test('packaged Python schema equals the schema', () => {
	assert.equal(fs.readFileSync(path.join(KIT_PY, 'row_schema.json'), 'utf8'), fs.readFileSync(path.join(KIT_ROOT, 'schema', 'row.schema.json'), 'utf8'));
});

test('conformance: every validate case gives the same answer in the JS validator', () => {
	const cases = JSON.parse(fs.readFileSync(path.join(KIT_ROOT, 'conformance', 'cases.json'), 'utf8')).validate;
	for (const c of cases) assert.equal(checkRows(c.rows).length === 0, c.valid, c.name);
});

test('checkRows: numeric tile rule, footer and label limits, text safety', () => {
	const f = (r, m) => codes(checkRows([r], m));
	assert.ok(f({ title: 'x', kpi_label: 'Disk', kpi_value: '' }).includes('tile_without_number'));
	assert.ok(f({ title: 'x', kpi_value: '12' }).includes('schema_invalid'));
	assert.deepEqual(f({ title: 'x', kpi_label: 'Disk', kpi_value: 4, kpi_unit: '%' }), []);
	const a = (i, l = 'ok') => ({ id: `a${i}`, kind: 'composer', label: l, insert: 'y' });
	assert.ok(f({ title: 'x', actions: [a(1), a(2), a(3)] }).includes('footer_too_many'));
	assert.deepEqual(f({ title: 'x', actions: [a(1), a(2), a(3)] }, 0), []);
	assert.ok(f({ title: 'x', actions: [a(1, 'fifteen chars!!!')] }).includes('label_too_long'));
	assert.ok(f({ title: 'x\u202e' }).includes('text_unsafe'));
	assert.ok(f({ title: 'a {{b}}' }).includes('text_braces'));
	assert.deepEqual(f({ title: 'x', body: 'line1\nline2' }), []);
	assert.ok(f({ title: 'x', nav: { back: true }, actions: [a(1)] }).includes('nav_with_actions'));
});

test('platforms and requires validate', () => {
	assert.deepEqual(platformFindings({ platforms: ['macos', 'linux'], requires: [{ interpreter: 'python', min_version: '3.9' }] }), []);
	assert.equal(platformFindings({ platforms: ['beos'] })[0].code, 'platforms_invalid');
	assert.equal(platformFindings({ platforms: [] })[0].code, 'platforms_invalid');
	assert.equal(platformFindings({ requires: [{ interpreter: 'ruby' }] })[0].code, 'requires_invalid');
	assert.equal(platformFindings({ requires: [{ interpreter: 'node', min_version: 'x' }] })[0].code, 'requires_invalid');
});

test('lint reports bad platforms in bolt-app.json', () => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-plat-')); const id = 'plat-test'; const dir = path.join(d, id);
	assert.equal(spawnSync('node', [CLI, 'new', id, '--type', 'transform'], { cwd: d, encoding: 'utf8' }).status, 0);
	const file = path.join(d, 'apps', id, 'bolt-app.json');
	const dirApp = fs.existsSync(file) ? path.dirname(file) : dir;
	const bj = path.join(dirApp, 'bolt-app.json'); const j = JSON.parse(fs.readFileSync(bj, 'utf8'));
	assert.equal(spawnSync('node', [CLI, 'lint', dirApp, '--json'], { encoding: 'utf8' }).status, 0);
	j.platforms = ['plan9']; fs.writeFileSync(bj, JSON.stringify(j));
	const r = spawnSync('node', [CLI, 'lint', dirApp, '--json'], { encoding: 'utf8' });
	assert.equal(r.status, 1); assert.ok(r.stdout.includes('platforms_invalid'));
});

test('the example app passes check, with every case', async () => {
	const r = await checkApp(EXAMPLE);
	assert.deepEqual(r.findings, []);
	assert.ok(r.cases.length >= 9);
	for (const c of r.cases) assert.deepEqual(c.findings.filter((x) => !(x.code === 'tile_row_without_value' && x.level === 'warning')), [], c.name);
});

test('--os selects fixture cases; an OS with no case is an error', async () => {
	const lin = await checkApp(EXAMPLE, { os: 'linux' });
	assert.ok(lin.cases.length && lin.cases.every((c) => c.os === 'linux'));
	assert.match(lin.cases[0].tested, /fixtures only|stubbed/);
	const d = tmpCopy(); const none = JSON.parse(fs.readFileSync(path.join(d, 'check.json'), 'utf8')); none.cases = none.cases.filter((c) => c.os !== 'windows'); fs.writeFileSync(path.join(d, 'check.json'), JSON.stringify(none));
	assert.equal((await checkApp(d, { os: 'windows' })).findings[0].code, 'no_cases_for_os');
});

function brokenApp(scriptBody, kase = {}) {
	const d = tmpCopy();
	fs.writeFileSync(path.join(d, 'scripts', 'system-glance__system-glance.py'), scriptBody);
	fs.writeFileSync(path.join(d, 'check.json'), JSON.stringify({ script: 'scripts/system-glance__system-glance.py', interpreter: 'python3', kit: 'scripts/bolt_app_kit', cases: [{ name: 'broken', os: 'macos', args: [], ...kase }] }));
	return d;
}

test('check fails a script that prints a string tile value, a long label and braces (failing first)', async () => {
	const body = `import json\nprint(json.dumps([{"title":"{{x}}","kpi_label":"Disk","kpi_value":"-","actions":[{"id":"a","kind":"composer","label":"this label is too long","insert":"y"}]}]))`;
	const r = await checkApp(brokenApp(body));
	const c = codes(r.cases[0].findings);
	for (const code of ['schema_invalid', 'tile_not_numeric', 'tile_without_number', 'label_too_long', 'text_braces']) assert.ok(c.includes(code), code);
});

test('check fails a hung script that has no deadline', async () => {
	const body = process.platform === 'win32'
		? `import time\ntime.sleep(6)\nprint("[]")`
		: `import subprocess\nsubprocess.run(["/bin/sleep","6"])\nprint("[]")`;
	const d = brokenApp(body, { expect: { max_seconds: 2 } });
	const r = await checkApp(d);
	assert.ok(codes(r.cases[0].findings).includes('deadline_exceeded'));
});

test('check fails non-JSON output, a non-zero exit, and a clean-zero on a failed probe', async () => {
	assert.ok(codes((await checkApp(brokenApp('print("hello")'))).cases[0].findings).includes('non_json_output'));
	assert.ok(codes((await checkApp(brokenApp('import sys\nsys.exit(4)'))).cases[0].findings).includes('exit_code'));
	const lies = `import json\nprint(json.dumps([{"title":"All clear","kpi_label":"Ports","kpi_value":0}]))`;
	const r = await checkApp(brokenApp(lies, { stubs: { ss: { rc: 2 } }, expect: { text_absent: ['All clear'] } }));
	assert.ok(codes(r.cases[0].findings).includes('forbidden_text_present'));
});

test('the script runs with an empty environment and a temp HOME', async () => {
	if (process.platform === 'win32') {
		const allowed = 'HOME PATH USER LOGNAME PYTHONNOUSERSITE PYTHONDONTWRITEBYTECODE PYTHONUNBUFFERED GIT_CONFIG_NOSYSTEM GIT_OPTIONAL_LOCKS GIT_TERMINAL_PROMPT LC_CTYPE __CF_USER_TEXT_ENCODING CPATH LIBRARY_PATH MANPATH SDKROOT USERPROFILE SYSTEMROOT COMSPEC PATHEXT TEMP TMP PYTHONUTF8 HOMEDRIVE HOMEPATH LOGONSERVER SYSTEMDRIVE USERDOMAIN USERNAME WINDIR';
		const tmpRoot = path.resolve(os.tmpdir()).toLowerCase();
		const body = `import os, json\nallowed = set(${JSON.stringify(allowed)}.split())\nh = os.path.abspath(os.environ.get("HOME",""))\nin_tmp = h.lower().startswith(${JSON.stringify(tmpRoot)}) and os.path.basename(h) == "home" and h == os.path.abspath(os.environ.get("USERPROFILE",""))\nprint(json.dumps([{"title":"extra:" + str([k for k in os.environ if k not in allowed]) + " home_tmp:" + ("1" if in_tmp else "0")}]))`;
		const r = await checkApp(brokenApp(body, { expect: { text_present: ['extra:[]', 'home_tmp:1'] } }));
		assert.ok(!codes(r.cases[0].findings).includes('expected_text_missing'), JSON.stringify(r.cases[0].findings));
	} else {
		const body = `import os, json\nprint(json.dumps([{"title":"extra:" + str([k for k in os.environ if k not in ("HOME","PATH","USER","LOGNAME","PYTHONNOUSERSITE","PYTHONDONTWRITEBYTECODE","PYTHONUNBUFFERED","GIT_CONFIG_NOSYSTEM","GIT_OPTIONAL_LOCKS","GIT_TERMINAL_PROMPT","LC_CTYPE","__CF_USER_TEXT_ENCODING","CPATH","LIBRARY_PATH","MANPATH","SDKROOT")]) + " home:" + os.environ.get("HOME","")[:9]}]))`;
		const r = await checkApp(brokenApp(body, { expect: { text_present: ['extra:[]', 'home:/'] } }));
		assert.ok(!codes(r.cases[0].findings).includes('expected_text_missing'), JSON.stringify(r.cases[0].findings));
	}
});

test('golden snapshots: a missing or changed golden fails, --update-golden writes it', async () => {
	const d = tmpCopy();
	fs.writeFileSync(path.join(d, 'golden', 'macos-overview.json'), '[]');
	assert.ok(codes((await checkApp(d, { os: 'macos', only: 'macos overview' })).cases[0].findings).includes('golden_mismatch'));
	fs.rmSync(path.join(d, 'golden', 'macos-overview.json'));
	assert.ok(codes((await checkApp(d, { os: 'macos', only: 'macos overview' })).cases[0].findings).includes('golden_missing'));
	await checkApp(d, { os: 'macos', only: 'macos overview', updateGolden: true });
	assert.deepEqual((await checkApp(d, { os: 'macos', only: 'macos overview' })).cases[0].findings.filter((x) => x.code !== 'tile_row_without_value'), []);   // system-glance carries known_empty_tiles (a warning)
});

test('kit guard: edited, missing and outdated vendored kits are caught', async () => {
	const d = tmpCopy();
	fs.appendFileSync(path.join(d, 'scripts', 'bolt_app_kit', 'fmt.py'), '\n# edit\n');
	assert.ok(codes((await checkApp(d, { only: 'macos disk' })).findings).includes('kit_modified'));
	vendorKit(d);
	assert.deepEqual((await checkApp(d, { only: 'macos disk' })).findings, []);
	fs.rmSync(path.join(d, 'scripts', 'bolt_app_kit'), { recursive: true });
	assert.ok(codes((await checkApp(d, { only: 'macos disk' })).findings).includes('kit_not_vendored'));
	vendorKit(d);
	const lock = path.join(d, 'scripts', 'bolt_app_kit.lock.json'); const l = JSON.parse(fs.readFileSync(lock, 'utf8')); l.version = '0.0.1'; fs.writeFileSync(lock, JSON.stringify(l));
	assert.ok(codes((await checkApp(d, { only: 'macos disk' })).findings).includes('kit_outdated'));
});

test('paths in check.json cannot leave the app folder (kit vendor never deletes outside it)', () => {
	const d = tmpCopy();
	for (const bad of ['.', '..', '../../x', '/etc']) assert.throws(() => inside(d, bad), /outside the app folder/);
	fs.writeFileSync(path.join(d, 'check.json'), JSON.stringify({ script: 'scripts/system-glance__system-glance.py', interpreter: 'python3', kit: '..', cases: [] }));
	assert.throws(() => vendorKit(d), /outside/);
	assert.ok(fs.existsSync(path.join(d, 'scripts')));
});

test('kit guard: an old version label does not hide an edit, and the kit beside the script is the one guarded', async () => {
	const d = tmpCopy();
	fs.appendFileSync(path.join(d, 'scripts', 'bolt_app_kit', 'fmt.py'), '\n# edit\n');
	const lock = path.join(d, 'scripts', 'bolt_app_kit.lock.json');
	fs.writeFileSync(lock, JSON.stringify({ name: 'bolt_app_kit', version: '0.0.1', sha256: treeHash(path.join(d, 'scripts', 'bolt_app_kit')) }));
	const r = await checkApp(d, { only: 'macos disk' });
	assert.ok(codes(r.findings).includes('kit_outdated') && r.findings.find((x) => x.code === 'kit_outdated').level === 'error');
	const c = JSON.parse(fs.readFileSync(path.join(d, 'check.json'), 'utf8')); c.kit = 'elsewhere/bolt_app_kit';
	fs.writeFileSync(path.join(d, 'check.json'), JSON.stringify(c));
	assert.ok(codes((await checkApp(d, { only: 'macos disk' })).findings).includes('kit_not_beside_script'));
});

test('kit guard: extra files, binaries, pyc and symlinks inside the kit directory are flagged, never skipped', async () => {
	const add = async (mut) => { const d = tmpCopy(); mut(path.join(d, 'scripts', 'bolt_app_kit')); return codes((await checkApp(d, { only: 'macos disk' })).findings); };
	assert.ok((await add((k) => fs.writeFileSync(path.join(k, 'evil.so'), 'x'))).includes('kit_modified'));
	assert.ok((await add((k) => fs.writeFileSync(path.join(k, 'evil.pyd'), 'x'))).includes('kit_modified'));
	assert.ok((await add((k) => fs.writeFileSync(path.join(k, 'extra.py'), 'x = 1'))).includes('kit_modified'));
	assert.ok((await add((k) => fs.writeFileSync(path.join(k, 'fmt.cpython-313.pyc'), 'x'))).includes('kit_modified'));
	if (process.platform !== 'win32') {
		assert.ok((await add((k) => fs.symlinkSync('/etc/hosts', path.join(k, 'link.py')))).includes('kit_modified'));
		assert.ok((await add((k) => { fs.rmSync(path.join(k, 'fmt.py')); fs.symlinkSync(path.join(k, 'text.py'), path.join(k, 'fmt.py')); })).includes('kit_modified'));
	}
	assert.ok((await add((k) => { fs.mkdirSync(path.join(k, 'sub')); fs.writeFileSync(path.join(k, 'sub', 'a.py'), ''); })).includes('kit_modified'));
	assert.ok(!(await add((k) => { fs.mkdirSync(path.join(k, '__pycache__'), { recursive: true }); fs.writeFileSync(path.join(k, '__pycache__', 'x.pyc'), 'x'); })).includes('kit_modified'));
});

test('symlinks inside the app folder cannot redirect kit vendor or check outside it', { skip: process.platform === 'win32' }, async () => {
	const out = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
	fs.mkdirSync(path.join(out, 'bolt_app_kit')); fs.writeFileSync(path.join(out, 'bolt_app_kit', 'keep.txt'), 'precious');
	const a = tmpCopy(); fs.rmSync(path.join(a, 'scripts'), { recursive: true }); fs.symlinkSync(out, path.join(a, 'scripts'));
	assert.throws(() => vendorKit(a), /symlink|outside/);
	assert.ok(fs.existsSync(path.join(out, 'bolt_app_kit', 'keep.txt')));
	const b = tmpCopy(); fs.rmSync(path.join(b, 'scripts', 'bolt_app_kit'), { recursive: true }); fs.symlinkSync(path.join(out, 'bolt_app_kit'), path.join(b, 'scripts', 'bolt_app_kit'));
	assert.throws(() => vendorKit(b), /symlink|outside/);
	assert.ok(fs.existsSync(path.join(out, 'bolt_app_kit', 'keep.txt')));
	assert.ok(codes((await checkApp(a, { only: 'macos disk' })).findings).includes('path_outside_app'));
	const c = tmpCopy(); const cfg = JSON.parse(fs.readFileSync(path.join(c, 'check.json'), 'utf8')); cfg.kit = 'scripts/other'; fs.writeFileSync(path.join(c, 'check.json'), JSON.stringify(cfg));
	assert.throws(() => vendorKit(c), /bolt_app_kit/);
});

test('the vendored example kit equals the kit in this repo', () => {
	assert.equal(fs.readFileSync(path.join(EXAMPLE, 'scripts', 'system-glance__bolt_app_kit.py'), 'utf8'), flatKitSource());
});

test('CLI: check exits 0 on the example and 1 on a broken app; plain apps keep the old message', () => {
	assert.equal(spawnSync('node', [CLI, 'check', EXAMPLE, '--case', 'macos disk'], { encoding: 'utf8' }).status, 0);
	const d = brokenApp('print("x")');
	assert.equal(spawnSync('node', [CLI, 'check', d, '--json'], { encoding: 'utf8' }).status, 1);
	const r = spawnSync('node', [CLI, 'check', path.join(root, 'apps', 'clean-list')], { encoding: 'utf8' });
	assert.equal(r.status, 2); assert.match(r.stderr, /not published yet/);
});

test('the Python kit unit tests pass (3.9+)', (t) => {
	if (process.platform === 'win32') return t.skip('kit unit tests use POSIX mode bits');
	const py = pythonCmd();
	if (!py) return t.skip('python not available');
	const r = spawnSync(py.cmd, [...py.args, '-m', 'unittest', 'discover', '-s', 'tests'], { cwd: path.join(root, 'kit', 'python'), encoding: 'utf8' });
	assert.equal(r.status, 0, r.stderr.slice(-2000));
});

// ---- flat (single-file) kit: what makes an app packable with --personal ----
const ACME = path.join(root, 'kit', 'examples', 'acme-dash');
const flatCopy = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-flat-')); fs.cpSync(ACME, d, { recursive: true }); return d; };

test('flat kit: the example is flat, in sync with the repo kit, and passes check', async () => {
	const lock = JSON.parse(fs.readFileSync(path.join(ACME, 'bolt_app_kit.lock.json'), 'utf8'));
	assert.equal(lock.flat, true);
	assert.equal(fs.readFileSync(path.join(ACME, 'scripts', 'acme-dash__bolt_app_kit.py'), 'utf8'), flatKitSource());
	assert.deepEqual((await checkApp(ACME, { only: 'overview' })).findings, []);
});

test('flat kit guard: edited, missing, shadowed and outdated are caught', async () => {
	const d = flatCopy(), kit = path.join(d, 'scripts', 'acme-dash__bolt_app_kit.py');
	fs.appendFileSync(kit, '\n# edit\n');
	assert.ok(codes((await checkApp(d, { only: 'overview' })).findings).includes('kit_modified'));
	vendorKit(d);
	assert.deepEqual((await checkApp(d, { only: 'overview' })).findings, []);
	fs.mkdirSync(path.join(d, 'scripts', 'bolt_app_kit'));
	assert.ok(codes((await checkApp(d, { only: 'overview' })).findings).includes('kit_modified'));
	fs.rmSync(path.join(d, 'scripts', 'bolt_app_kit'), { recursive: true });
	fs.rmSync(kit);
	assert.ok(codes((await checkApp(d, { only: 'overview' })).findings).includes('kit_not_vendored'));
	vendorKit(d);
	const lp = path.join(d, 'bolt_app_kit.lock.json'), l = JSON.parse(fs.readFileSync(lp, 'utf8')); l.version = '0.0.1'; fs.writeFileSync(lp, JSON.stringify(l));
	assert.ok(codes((await checkApp(d, { only: 'overview' })).findings).includes('kit_outdated'));
	// a lock that claims this version but a file that differs from the repo kit is diverged
	l.version = JSON.parse(fs.readFileSync(path.join(ACME, 'bolt_app_kit.lock.json'), 'utf8')).version;
	const body = flatKitSource() + '\n# changed\n'; fs.writeFileSync(kit, body); l.sha256 = createHash('sha256').update(body).digest('hex'); fs.writeFileSync(lp, JSON.stringify(l));
	assert.ok(codes((await checkApp(d, { only: 'overview' })).findings).includes('kit_diverged'));
});

test('flat kit behaves like the package kit (same rows, same refusals)', (t) => {
	const py = pythonCmd(); if (!py) return t.skip('python not available');
	const run = (dir, code) => spawnSync(py.cmd, [...py.args, '-c', code], { encoding: 'utf8', env: { PYTHONPATH: dir, PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' } });
	const code = 'import bolt_app_kit as k, json\nr=[k.row("a {{x}}", "b", tile=k.tile("T", 5, "%", 10), nav={"view":"v","arg":"a"}), k.back_row("x")]\nprint(json.dumps(r), k.validate_rows(r), k.__version__)\ntry:\n k.tile("T","x")\nexcept k.KitError as e:\n print("refused")\ntry:\n k.row("a", icon="nope")\nexcept k.KitError:\n print("icon refused")';
	const flatDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-flatdir-')); fs.copyFileSync(path.join(ACME, 'scripts', 'acme-dash__bolt_app_kit.py'), path.join(flatDir, 'bolt_app_kit.py'));
	const a = run(flatDir, code), b = run(path.join(root, 'kit', 'python'), code);
	assert.equal(a.status, 0, a.stderr); assert.equal(a.stdout, b.stdout); assert.match(a.stdout, /icon refused/);
});

test('flat kit: both examples lint and pack with --personal, and the lock is not packed', () => {
	for (const app of ['acme-dash', 'portal-template']) {
		const dir = path.join(root, 'kit', 'examples', app);
		const l = spawnSync('node', [CLI, 'lint', dir, '--personal', '--json'], { encoding: 'utf8' });
		assert.equal(l.status, 0, l.stdout + l.stderr);
		const v = spawnSync('node', [CLI, 'verify', dir, '--json'], { encoding: 'utf8' });
		assert.equal(v.status, 0, v.stdout);
		assert.ok(!JSON.parse(v.stdout).findings.some((x) => x.code === 'script_unused'), v.stdout);
	}
});

test('script_unused still reports a real unused script, but not an imported module or a named data file', () => {
	const d = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'unused-')), 'acme-dash'); fs.cpSync(ACME, d, { recursive: true });
	fs.writeFileSync(path.join(d, 'scripts', 'stray.py'), 'print(1)\n');
	fs.writeFileSync(path.join(d, 'scripts', 'orphan.json'), '{}');
	const v = spawnSync('node', [CLI, 'verify', d, '--json'], { encoding: 'utf8' });
	const un = JSON.parse(v.stdout).findings.filter((x) => x.code === 'script_unused').map((x) => x.file).sort();
	assert.deepEqual(un, ['scripts/orphan.json', 'scripts/stray.py']);
});

// ---- the launcher's scripts-folder rule (the launcher plain_script_refs) ----
const sdYaml = (cmd, extra = '') => `${extra}schema_version: 1\nruntime: bridge\nid: sd\nchip: sd\ntitle: "sd"\nicon: activity\ndescription: "d"\nemits: Generic\nbridge:\n  command:\n    macos: ${cmd}\n  parse: json\n  timeout_seconds: 20\npresentation:\n  widget: list\n  title_field: title\n  subtitle_field: subtitle\n`;
const sdCodes = (y) => assessYaml(y, 'sd').problems.filter((p) => p.code !== 'command_os_missing').map((p) => p.code);   // the one-OS command warning is tested in launcher-rules.test.mjs
test('scripts_dir_form: every mention must be {{scripts_dir}}/<file> as its own word, comments included', () => {
	assert.deepEqual(sdCodes(sdYaml('"python3 {{scripts_dir}}/engine.py {{view}}"')), []);
	assert.deepEqual(sdCodes(sdYaml('"python3 {{scripts_dir}}/a.py {{scripts_dir}}/b.json"')), []);   // two plain files are fine
	assert.deepEqual(sdCodes(sdYaml('"python3 {{scripts_dir}}/engine.py"', '# data: {{scripts_dir}}/fixtures.json\n')), ['scripts_dir_form']);   // the real failure: a comment
	assert.deepEqual(sdCodes(sdYaml('"python3 {{scripts_dir}}/engine.py"', '# see scripts_dir\n')), ['scripts_dir_form']);
	assert.deepEqual(sdCodes(sdYaml('"python3 {{ scripts_dir }}/engine.py"')), ['scripts_dir_form']);
	assert.deepEqual(sdCodes(sdYaml('"python3 {{SCRIPTS_DIR}}/engine.py"')), ['scripts_dir_form']);
	assert.deepEqual(sdCodes(sdYaml('"python3 {{scripts_dir}}/../x.py"')), ['scripts_dir_form']);
	assert.deepEqual(sdCodes(sdYaml('"python3 {{scripts_dir}}/.hidden.py"')), ['scripts_dir_form']);
	assert.deepEqual(sdCodes(sdYaml('"python3 {{scripts_dir}}/name."')), ['scripts_dir_form']);
	assert.deepEqual(sdCodes(sdYaml('"python3 -c {{scripts_dir}}"')), ['scripts_dir_form']);
});

test('scripts_dir_form: lint --personal and verify refuse a comment mention; the examples have none', () => {
	const d = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sd-')), 'acme-dash'); fs.cpSync(ACME, d, { recursive: true });
	const y = path.join(d, 'utilities', 'acme-dash.yaml');
	fs.writeFileSync(y, '# data in {{scripts_dir}}/fixtures.json\n' + fs.readFileSync(y, 'utf8'));
	for (const cmd of ['lint', 'verify']) {
		const r = spawnSync('node', [CLI, cmd, d, '--personal', '--json'], { encoding: 'utf8' });
		assert.equal(r.status, 1, cmd); assert.match(r.stdout, /scripts_dir_form/);
	}
	for (const app of ['acme-dash', 'portal-template']) assert.ok(!/scripts_dir/.test(fs.readFileSync(path.join(root, 'kit', 'examples', app, 'utilities', `${app}.yaml`), 'utf8').replace(/\{\{scripts_dir\}\}\/[a-z0-9-]+__(engine\.py|config\.json|fixtures\.json|bolt_app_kit\.py|bolt_app_engine\.py)/g, '')));
});

test('a check.json load error is a finding in both library modes and exits 2 in the CLI', async (t) => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-badcfg-'));
	t.after(() => fs.rmSync(d, { recursive: true, force: true }));
	const file = path.join(d, 'check.json');
	for (const [body, want] of [['{oops', /check\.json is not valid JSON/], ['[]', /check\.json must be a JSON object\./], ['null', /check\.json must be a JSON object\./], [null, /check\.json could not be read/]]) {
		if (body === null) { fs.rmSync(file); fs.mkdirSync(file); }
		else fs.writeFileSync(file, body);
		for (const shared of [false, true]) {
			const report = await checkApp(d, { shared });
			assert.deepEqual(report.cases, []);
			assert.deepEqual(codes(report.findings), ['load_error']);
			assert.equal(report.findings[0].path, 'check.json');
			assert.match(report.findings[0].message, want);
		}
		const plain = spawnSync(process.execPath, [CLI, 'check', d], { encoding: 'utf8' });
		assert.equal(plain.status, 2, plain.stdout + plain.stderr);
		assert.match(plain.stderr, want);
		assert.equal(plain.stderr.trimEnd().split('\n').length, 1);
		const json = spawnSync(process.execPath, [CLI, 'check', d, '--shared', '--json'], { encoding: 'utf8' });
		assert.equal(json.status, 2, json.stdout + json.stderr);
		assert.equal(json.stderr, '');
		const result = JSON.parse(json.stdout);
		assert.equal(result.ok, false);
		assert.match(result.error, want);
		assert.deepEqual(codes(result.findings), ['load_error']);
	}
});

test('a valid check.json object still exits 1 for a checker finding', (t) => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-invalidcheck-'));
	t.after(() => fs.rmSync(d, { recursive: true, force: true }));
	fs.writeFileSync(path.join(d, 'check.json'), '{}');
	const r = spawnSync(process.execPath, [CLI, 'check', d, '--json'], { encoding: 'utf8' });
	assert.equal(r.status, 1, r.stdout + r.stderr);
	const result = JSON.parse(r.stdout);
	assert.equal(result.ok, false);
	assert.equal(result.error, undefined);
	assert.ok(codes(result.findings).includes('interpreter_missing'));
	assert.ok(!codes(result.findings).includes('load_error'));
});

test('check takes the script app path when check.json is present but cannot be reached', { skip: process.platform === 'win32' }, (t) => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-unreachablecfg-'));
	t.after(() => { fs.chmodSync(d, 0o755); fs.rmSync(d, { recursive: true, force: true }); });
	const app = path.join(d, 'app');
	fs.mkdirSync(app);
	fs.symlinkSync('missing.json', path.join(app, 'check.json'));
	const dangling = spawnSync(process.execPath, [CLI, 'check', app, '--json'], { encoding: 'utf8' });
	assert.equal(dangling.status, 2, dangling.stdout + dangling.stderr);
	const result = JSON.parse(dangling.stdout);
	assert.match(result.error, /check\.json could not be read \(ENOENT\)/);
	assert.deepEqual(codes(result.findings), ['load_error']);
	if (process.getuid() === 0) return;  // root reads a folder with no permissions
	fs.rmSync(path.join(app, 'check.json'));
	fs.writeFileSync(path.join(app, 'check.json'), '{}');
	fs.chmodSync(d, 0o000);
	const locked = spawnSync(process.execPath, [CLI, 'check', app], { encoding: 'utf8' });
	fs.chmodSync(d, 0o755);
	assert.equal(locked.status, 2, locked.stdout + locked.stderr);
	assert.match(locked.stderr, /check\.json could not be read \(EACCES\)/);
});
