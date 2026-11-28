// Run: node --test toolkit/test/release-cli.test.mjs
// The CLI release tarball: what is in it, that it builds the same bytes twice, and that the unpacked copy runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BUILD = path.join(REPO, 'scripts/build-cli-tarball.sh');
const VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'toolkit/package.json'), 'utf8')).version;
const hasGnuTar = ['tar', 'gtar'].some((t) => (spawnSync(t, ['--version'], { encoding: 'utf8' }).stdout || '').includes('GNU tar'));
const inGit = spawnSync('git', ['rev-parse', '--git-dir'], { cwd: REPO }).status === 0;
const skip = process.platform === 'win32' ? 'POSIX shell and GNU tar' : !hasGnuTar ? 'needs GNU tar' : !inGit ? 'needs a git checkout' : false;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bolt-cli-rel-'));
const env = { ...process.env, SOURCE_DATE_EPOCH: '1700000000' };
const build = (out) => spawnSync('sh', [BUILD, out], { cwd: REPO, encoding: 'utf8', env });

test('--version prints the toolkit version, then the oldest Bolt it lints for', () => {
	const r = spawnSync(process.execPath, [path.join(REPO, 'toolkit/bin/bolt-apps.mjs'), '--version'], { encoding: 'utf8' });
	assert.equal(r.status, 0);
	const [v, bolt] = r.stdout.trim().split('\n');
	assert.equal(v, VERSION);
	assert.match(bolt, /^lints for Bolt \d+\.\d+\.\d+ and newer/);
	assert.match(bolt, /keys added in Bolt \d+\.\d+\.\d+ need "min_bolt_version"/);
});

test('the tarball holds the runtime, leaves the tests and pictures out, and builds the same bytes twice', { skip }, () => {
	const a = tmp(), b = tmp();
	const r1 = build(a); assert.equal(r1.status, 0, r1.stderr);
	const r2 = build(b); assert.equal(r2.status, 0, r2.stderr);
	const name = `bolt-apps-${VERSION}`;
	const t1 = fs.readFileSync(path.join(a, `${name}.tar.gz`)), t2 = fs.readFileSync(path.join(b, `${name}.tar.gz`));
	assert.ok(t1.equals(t2), 'two builds of the same commit are byte-identical');
	const sums = fs.readFileSync(path.join(a, 'SHA256SUMS'), 'utf8');
	assert.match(sums, new RegExp(`^[0-9a-f]{64}  ${name.replace(/\./g, '\\.')}\\.tar\\.gz\\n$`));
	const list = spawnSync('tar', ['-tzf', path.join(a, `${name}.tar.gz`)], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
	for (const must of ['bolt-apps', 'bolt-apps.cmd', 'toolkit/bin/bolt-apps.mjs', 'toolkit/package.json', 'schema/bolt-rules.json', 'schema/install-rules.json', 'kit/examples/index.json', 'kit/python/bolt_app_engine.py', 'kit/schema/icons.json', 'LICENSE']) assert.ok(list.includes(`${name}/${must}`), `${must} is in the tarball`);
	assert.ok(list.every((f) => f.startsWith(`${name}/`)), 'everything sits under one folder');
	for (const never of ['toolkit/test/', 'kit/python/tests/', 'docs/images/', '.github/', 'apps/', '__pycache__', '.boltpack', '.pem', '.key']) assert.ok(!list.some((f) => f.includes(never)), `${never} is not in the tarball`);
	assert.ok(t1.length < 3 * 1024 * 1024, `tarball is ${t1.length} bytes, expected under 3 MB`);
	// the unpacked copy runs from any folder and can start an app from a template
	const x = tmp();
	assert.equal(spawnSync('tar', ['-xzf', path.join(a, `${name}.tar.gz`), '-C', x]).status, 0);
	const cli = path.join(x, name, 'bolt-apps');
	const v = spawnSync(cli, ['--version'], { encoding: 'utf8', cwd: x });
	assert.equal(v.stdout.split('\n')[0], VERSION, v.stderr);
	const n = spawnSync(cli, ['new', 'table-template', 'my-table'], { encoding: 'utf8', cwd: x });
	assert.equal(n.status, 0, n.stderr + n.stdout);
	assert.ok(fs.existsSync(path.join(x, 'my-table', 'bolt-app.json')));
});
