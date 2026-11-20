// Run: node --test toolkit/test/polish-181.test.mjs
// Small first-run fixes: bare `check`, one copy of each ship warning, stale-clone note, short "Make it yours", doctor's read-only user-utils scan.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { staleClone, userUtilsDir, userUtilsClashes } from '../lib/workflow.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const CLI = path.resolve(HERE, '../bin/bolt-apps.mjs');
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `${n}-`));
const run = (home, args, extra = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 120000, env: { ...process.env, HOME: home, USERPROFILE: home, ...extra } });
const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }); assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const TEMPLATE = 'system-glance';

test('check: no folder prints usage; a folder with no app says so; a snippet folder keeps the old message', () => {
	const home = tmp('p181-home');
	const a = run(home, ['check']);
	assert.equal(a.status, 2); assert.match(a.stderr, /usage: \.\/bolt-apps check <app-folder>/); assert.doesNotMatch(a.stderr, /not published yet/);
	const empty = tmp('p181-empty');
	const b = run(home, ['check', empty]);
	assert.equal(b.status, 2); assert.match(b.stderr, /no app found in .*: an app folder holds utilities\/<id>\.yaml/); assert.doesNotMatch(b.stderr, /not published yet/);
	const c = run(home, ['check', path.join(REPO, 'apps', 'clean-list')]);
	assert.match(c.stderr, /not published yet/);
});

test('staleClone: fixture repo behind origin/main, fresh fetch, old fetch, and every skip case', () => {
	const up = tmp('p181-up'), clone = path.join(tmp('p181-cl'), 'c');
	git(up, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(up, 'a'), '1'); git(up, 'add', '.'); git(up, 'commit', '-q', '-m', 'one');
	git('/', 'clone', '-q', up, clone);
	assert.equal(staleClone(clone), null, 'up to date and just fetched: silent');
	fs.writeFileSync(path.join(up, 'a'), '2'); git(up, 'commit', '-q', '-am', 'two'); fs.writeFileSync(path.join(up, 'a'), '3'); git(up, 'commit', '-q', '-am', 'three');
	assert.equal(staleClone(clone), null, 'no fetch yet, so the local ref is not behind: silent (no network)');
	git(clone, 'fetch', '-q', 'origin');
	assert.match(staleClone(clone), /your copy of bolt-apps is 2 commits behind \(last fetch: less than an hour ago\): run git pull --ff-only/);
	git(clone, 'merge', '-q', '--ff-only', 'origin/main');
	assert.equal(staleClone(clone), null);
	const old = (Date.now() - 3 * 86400e3) / 1000; for (const f of ['FETCH_HEAD', 'logs/HEAD']) fs.utimesSync(path.join(clone, '.git', f), old, old);
	assert.match(staleClone(clone), /last checked GitHub 3 days ago and may be behind: run git pull --ff-only/);
	fs.rmSync(path.join(clone, '.git', 'FETCH_HEAD'));
	assert.match(staleClone(clone), /3 days ago.*git pull --ff-only/, 'no FETCH_HEAD: the clone reflog dates it');
	// skips
	assert.equal(staleClone(tmp('p181-nogit')), null, 'not a git clone');
	const sub = path.join(clone, 'sub'); fs.mkdirSync(sub); assert.equal(staleClone(sub), null, 'a folder inside another repo');
	const bare = tmp('p181-noorigin'); git(bare, 'init', '-q', '-b', 'main'); assert.equal(staleClone(bare), null, 'no origin');
	git(clone, 'update-ref', '-d', 'refs/remotes/origin/main'); assert.equal(staleClone(clone), null, 'no origin/main ref');
});

test('new and ship: the stale note is one line on stderr and never fails the command', () => {
	// the toolkit runs from this clone; whatever its state, the command works and prints at most one "note:" line
	const home = tmp('p181-home'), dir = tmp('p181-apps');
	const n = run(home, ['new', TEMPLATE, 'my-pipe', '--dir', dir]);
	assert.equal(n.status, 0, n.stderr);
	assert.ok((n.stderr.match(/^note: your copy of bolt-apps/gm) || []).length <= 1);
});

test('new: Make it yours is four short lines with the facts', () => {
	const home = tmp('p181-home'), dir = tmp('p181-apps');
	const n = run(home, ['new', TEMPLATE, 'my-pipe', '--dir', dir]);
	assert.equal(n.status, 0, n.stderr);
	const i = n.stdout.indexOf('Make it yours'); assert.ok(i > 0);
	const block = n.stdout.slice(i).trim().split('\n');
	assert.equal(block.length, 5, block.join('\n'));   // heading + 4 lines
	for (const l of block) assert.ok(l.replace(dir, "").length < 130, l);
	const t = block.join('\n');
	assert.match(t, /TODO/); assert.match(t, /README\.md starts with a note/); assert.match(t, /--update-golden/); assert.match(t, /ENGINE\.md/);
});

test('ship: each distinct warning appears once', () => {
	const home = tmp('p181-home'), dir = tmp('p181-apps');
	assert.equal(run(home, ['new', TEMPLATE, 'my-pipe', '--dir', dir]).status, 0);
	const s = run(home, ['ship', path.join(dir, 'my-pipe')]);
	assert.equal(s.status, 0, s.stdout + s.stderr);
	const lines = s.stdout.split('\n').filter((l) => /listing_todo|description_todo|WARNING your app description/.test(l));
	assert.ok(lines.length >= 1, 'the fixture must produce a TODO warning');
	assert.equal(new Set(lines.map((l) => l.trim())).size, lines.length, `a warning repeated:\n${lines.join('\n')}`);
	assert.match(s.stdout, /ok pack [^\n]*\(same warnings as above\)/);
});

test('doctor: scans the user apps folder by name only and says what to remove; documented in --help only', () => {
	const home = tmp('p181-home'), dir = tmp('p181-apps'), uu = tmp('p181-uu');
	assert.equal(run(home, ['new', TEMPLATE, 'my-pipe', '--dir', dir]).status, 0);
	const app = path.join(dir, 'my-pipe');
	const helper = fs.readdirSync(path.join(app, 'scripts')).find((f) => f.startsWith('my-pipe__') && f.endsWith('.py') && !/bolt_app_kit/.test(f));
	const flat = helper.slice('my-pipe__'.length);
	fs.mkdirSync(path.join(uu, 'scripts')); fs.writeFileSync(path.join(uu, 'my-pipe.yaml'), 'x'); fs.writeFileSync(path.join(uu, 'scripts', flat), 'x'); fs.writeFileSync(path.join(uu, 'scripts', 'other__a.py'), 'x');
	const before = fs.readdirSync(uu, { recursive: true }).sort();
	const d = run(home, ['doctor', app], { BOLT_USER_UTILS_DIR: uu });
	assert.equal(d.status, 1, d.stdout);
	assert.match(d.stdout, /my-pipe\.yaml/); assert.match(d.stdout, new RegExp(`scripts[\\\\/]${flat.replace(/\./g, '\\.')}`)); assert.match(d.stdout, /file_exists/); assert.match(d.stdout, /rm |del /);
	assert.doesNotMatch(d.stdout, /other__a/);
	assert.deepEqual(fs.readdirSync(uu, { recursive: true }).sort(), before, 'doctor must not change the folder');
	assert.equal(fs.readFileSync(path.join(uu, 'my-pipe.yaml'), 'utf8'), 'x');
	const none = run(home, ['doctor', app], { BOLT_USER_UTILS_DIR: path.join(uu, 'missing') });
	assert.doesNotMatch(none.stdout, /user apps folder/);
	assert.match(run(home, ['doctor', '--help']).stdout, /BOLT_USER_UTILS_DIR/);
	assert.doesNotMatch(run(home, ['--help']).stdout, /BOLT_USER_UTILS_DIR/);
});

test('doctor: advises removing only a file the pack would write; another app\'s flat names and an old script of this app are left alone', () => {
	const home = tmp('p181-home'), dir = tmp('p181-apps'), uu = tmp('p181-uu');
	assert.equal(run(home, ['new', TEMPLATE, 'my-pipe', '--dir', dir]).status, 0);
	assert.equal(run(home, ['keygen']).status, 0);   // so the only thing doctor can find is in the user apps folder
	const app = path.join(dir, 'my-pipe');
	const helper = fs.readdirSync(path.join(app, 'scripts')).find((f) => f.startsWith('my-pipe__') && f.endsWith('.py') && !/bolt_app_kit/.test(f));
	// An app installed by hand before scripts were namespaced: its own app file and the common flat names. None of them is a name the pack of my-pipe writes.
	fs.mkdirSync(path.join(uu, 'scripts')); fs.writeFileSync(path.join(uu, 'eagle-info.yaml'), 'x');
	for (const f of ['bolt_app_kit.py', helper.slice('my-pipe__'.length), 'my-pipe__old.py']) fs.writeFileSync(path.join(uu, 'scripts', f), 'x');
	const before = fs.readdirSync(uu, { recursive: true }).sort();
	const d = run(home, ['doctor', app], { BOLT_USER_UTILS_DIR: uu });
	assert.equal(d.status, 0, d.stdout + d.stderr);
	assert.doesNotMatch(d.stdout, /file_exists|rm |del |FIX /, d.stdout);
	assert.match(d.stdout, /bolt_app_kit\.py is in your Bolt user apps folder\. It does not stop this pack installing/);
	assert.doesNotMatch(d.stdout, /my-pipe__old\.py/, 'a script the pack does not write is not a clash');
	assert.deepEqual(userUtilsClashes(uu, 'my-pipe', app).filter((c) => c.blocks), []);
	// The same name as a script of the pack is a clash, with the exact file to remove
	fs.writeFileSync(path.join(uu, 'scripts', helper), 'x');
	const d2 = run(home, ['doctor', app], { BOLT_USER_UTILS_DIR: uu });
	assert.equal(d2.status, 1, d2.stdout);
	assert.match(d2.stdout, new RegExp(`FIX  script in your Bolt user apps folder: [^\\n]*${helper.replace(/\./g, '\\.')}`)); assert.match(d2.stdout, /file_exists/);
	assert.equal((d2.stdout.match(/^FIX /gm) || []).length, 1, d2.stdout);
	assert.deepEqual(fs.readdirSync(uu, { recursive: true }).sort(), [...before, path.join('scripts', helper)].sort(), 'doctor must not change the folder');
});

test('userUtilsDir: per OS, with the override', () => {
	assert.equal(userUtilsDir({}, 'darwin', '/h'), '/h/Library/Application Support/app.sparcle.bolt.enterprise/user-utils');
	assert.equal(userUtilsDir({ APPDATA: 'C:\\A' }, 'win32', 'C:\\h'), path.join('C:\\A', 'app.sparcle.bolt.enterprise', 'user-utils'));
	assert.equal(userUtilsDir({}, 'linux', '/h'), '/h/.config/app.sparcle.bolt.enterprise/user-utils');
	assert.equal(userUtilsDir({ BOLT_USER_UTILS_DIR: '/x' }, 'linux', '/h'), '/x');
	assert.deepEqual(userUtilsClashes('/nonexistent-dir', 'a', '/nope'), []);
});
