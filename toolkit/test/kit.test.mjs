// Tests for the authoring kit: the icon generator, the row contract, `bolt-apps check` and `kit vendor`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseIconKeys } from '../../kit/schema/gen-icons.mjs';
import { checkApp, checkRows, platformFindings, schemaCheck, treeHash, vendorKit, KIT_ROOT, KIT_PY } from '../lib/check.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXAMPLE = path.join(root, 'kit', 'examples', 'system-glance');
const CLI = path.join(root, 'toolkit', 'bin', 'bolt-apps.mjs');
const codes = (f) => f.map((x) => x.code);
const tmpCopy = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-test-')); fs.cpSync(EXAMPLE, d, { recursive: true }); return d; };

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

test('icon list still matches the launcher source when that checkout is present', (t) => {
	const src = path.join(os.homedir(), 'dev', 'bolt-pwa', 'src', 'lib', 'components', 'ui', 'utilityIconMap.ts');
	if (!fs.existsSync(src)) return t.skip('launcher source not on this machine; CI cannot see it');
	const r = spawnSync('node', [path.join(KIT_ROOT, 'schema', 'gen-icons.mjs'), src, '--check'], { encoding: 'utf8' });
	assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('packaged Python schema equals the schema', () => {
	assert.equal(fs.readFileSync(path.join(KIT_PY, 'row_schema.json'), 'utf8'), fs.readFileSync(path.join(KIT_ROOT, 'schema', 'row.schema.json'), 'utf8'));
});

test('conformance: every validate case gives the same answer in the JS validator', () => {
	const cases = JSON.parse(fs.readFileSync(path.join(KIT_ROOT, 'conformance', 'cases.json'), 'utf8')).validate;
	for (const c of cases) assert.equal(schemaCheck(c.rows, JSON.parse(fs.readFileSync(path.join(KIT_ROOT, 'schema', 'row.schema.json'), 'utf8'))).length === 0, c.valid, c.name);
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
	for (const c of r.cases) assert.deepEqual(c.findings, [], c.name);
});

test('--os selects fixture cases; an OS with no case is an error', async () => {
	const lin = await checkApp(EXAMPLE, { os: 'linux' });
	assert.ok(lin.cases.length && lin.cases.every((c) => c.os === 'linux'));
	assert.match(lin.cases[0].tested, /fixtures only|stubbed/);
	const none = JSON.parse(fs.readFileSync(path.join(EXAMPLE, 'check.json'), 'utf8')); none.cases = none.cases.filter((c) => c.os !== 'windows');
	const d = tmpCopy(); fs.writeFileSync(path.join(d, 'check.json'), JSON.stringify(none));
	assert.equal((await checkApp(d, { os: 'windows' })).findings[0].code, 'no_cases_for_os');
});

function brokenApp(scriptBody, kase = {}) {
	const d = tmpCopy();
	fs.writeFileSync(path.join(d, 'scripts', 'system-glance.py'), scriptBody);
	fs.writeFileSync(path.join(d, 'check.json'), JSON.stringify({ script: 'scripts/system-glance.py', interpreter: 'python3', kit: 'scripts/bolt_app_kit', cases: [{ name: 'broken', os: 'macos', args: [], ...kase }] }));
	return d;
}

test('check fails a script that prints a string tile value, a long label and braces (failing first)', async () => {
	const body = `import json\nprint(json.dumps([{"title":"{{x}}","kpi_label":"Disk","kpi_value":"-","actions":[{"id":"a","kind":"composer","label":"this label is too long","insert":"y"}]}]))`;
	const r = await checkApp(brokenApp(body));
	const c = codes(r.cases[0].findings);
	for (const code of ['schema_invalid', 'tile_not_numeric', 'tile_without_number', 'label_too_long', 'text_braces']) assert.ok(c.includes(code), code);
});

test('check fails a hung script that has no deadline', async () => {
	const body = `import subprocess\nsubprocess.run(["/bin/sleep","6"])\nprint("[]")`;
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
	const body = `import os, json\nprint(json.dumps([{"title":"extra:" + str([k for k in os.environ if k not in ("HOME","PATH","LC_CTYPE","__CF_USER_TEXT_ENCODING","CPATH","LIBRARY_PATH","MANPATH","SDKROOT")]) + " home:" + os.environ.get("HOME","")[:9]}]))`;
	const r = await checkApp(brokenApp(body, { expect: { text_present: ['extra:[]', 'home:/'] } }));
	assert.ok(!codes(r.cases[0].findings).includes('expected_text_missing'), JSON.stringify(r.cases[0].findings));
});

test('golden snapshots: a missing or changed golden fails, --update-golden writes it', async () => {
	const d = tmpCopy();
	fs.writeFileSync(path.join(d, 'golden', 'macos-overview.json'), '[]');
	assert.ok(codes((await checkApp(d, { os: 'macos', only: 'macos overview' })).cases[0].findings).includes('golden_mismatch'));
	fs.rmSync(path.join(d, 'golden', 'macos-overview.json'));
	assert.ok(codes((await checkApp(d, { os: 'macos', only: 'macos overview' })).cases[0].findings).includes('golden_missing'));
	await checkApp(d, { os: 'macos', only: 'macos overview', updateGolden: true });
	assert.deepEqual((await checkApp(d, { os: 'macos', only: 'macos overview' })).cases[0].findings, []);
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

test('the vendored example kit equals the kit in this repo', () => {
	assert.equal(treeHash(path.join(EXAMPLE, 'scripts', 'bolt_app_kit')), treeHash(KIT_PY));
});

test('CLI: check exits 0 on the example and 1 on a broken app; plain apps keep the old message', () => {
	assert.equal(spawnSync('node', [CLI, 'check', EXAMPLE, '--case', 'macos disk'], { encoding: 'utf8' }).status, 0);
	const d = brokenApp('print("x")');
	assert.equal(spawnSync('node', [CLI, 'check', d, '--json'], { encoding: 'utf8' }).status, 1);
	const r = spawnSync('node', [CLI, 'check', path.join(root, 'apps', 'clean-list')], { encoding: 'utf8' });
	assert.equal(r.status, 2); assert.match(r.stderr, /not published yet/);
});

test('the Python kit unit tests pass (3.9+)', (t) => {
	const py = spawnSync('python3', ['--version']);
	if (py.status !== 0) return t.skip('python3 not available');
	const r = spawnSync('python3', ['-m', 'unittest', 'discover', '-s', 'tests'], { cwd: path.join(root, 'kit', 'python'), encoding: 'utf8' });
	assert.equal(r.status, 0, r.stderr.slice(-2000));
});
