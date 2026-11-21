// Run: node --test toolkit/test/quickstart-journey.test.mjs
// A cold agent copies the commands out of kit/examples/QUICKSTART.md and runs them as written. This test does the same: it takes the
// command block and the regenerate command from the page text, runs them literally in a scratch HOME, and checks the paths and the chip
// the page names against what `new` made.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const QS = fs.readFileSync(path.join(REPO, 'kit/examples/QUICKSTART.md'), 'utf8');
const sh = (home, cmd) => spawnSync('sh', ['-c', cmd], { cwd: REPO, encoding: 'utf8', env: { ...process.env, HOME: home } });

test('QUICKSTART: the four commands and the regenerate line run as written against a fresh app', () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bolt-qs-'));
	const block = /```sh run\n([\s\S]*?)```/.exec(QS)[1].split('\n').filter((l) => l.trim());
	assert.equal(block.length, 4);
	const regen = /`(cd ~\/my-apps\/my-tool && python3 [^`]+)`/.exec(QS);
	assert.ok(regen, 'the page gives the regenerate command');
	for (const line of block.slice(0, 2)) { const r = sh(home, line); assert.equal(r.status, 0, `${line}\n${r.stdout}${r.stderr}`); }
	const app = path.join(home, 'my-apps', 'my-tool');
	// the files the page tells you to edit exist under the new id, and the script the regenerate line names exists
	for (const f of ['scripts/my-tool__config.json', 'scripts/my-tool__fixtures.json', 'scripts/my-tool__engine.py']) assert.ok(fs.existsSync(path.join(app, f)), f);
	const before = fs.readFileSync(path.join(app, 'utilities/my-tool.yaml'), 'utf8');
	const g = sh(home, regen[1]); assert.equal(g.status, 0, g.stdout + g.stderr);
	assert.equal(fs.readFileSync(path.join(app, 'utilities/my-tool.yaml'), 'utf8'), before, 'regenerating changes nothing on an untouched app');
	let shipOut = '';
	for (const line of block.slice(2)) { const r = sh(home, line); assert.equal(r.status, 0, `${line}\n${r.stdout}${r.stderr}`); shipOut = r.stdout; }
	assert.match(shipOut, /review card[\s\S]*self-signed[\s\S]*Install an unverified Bolt pack\?[\s\S]*Review and accept/);
	assert.doesNotMatch(shipOut, /macOS/);
	assert.doesNotMatch(shipOut, /once more/);
	// the chip the page tells you to type is the one the app has
	assert.match(QS, /type `=my-tool`/);
	assert.match(before, /^chip: my-tool$/m);
});

test('docs name no stale command or chip', () => {
	for (const f of ['kit/examples/QUICKSTART.md', 'README.md', 'AGENTS.md']) {
		const t = fs.readFileSync(path.join(REPO, f), 'utf8');
		assert.doesNotMatch(t, /python3 scripts\/engine\.py/, f);
		assert.doesNotMatch(t, /=mytool/, f);
		assert.doesNotMatch(t, /Bolt asks once more because you signed/, f);
	}
});

test('new prints the real file names to edit, not the template\'s', () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bolt-qs-'));
	const r = sh(home, './bolt-apps new portal-template shiny-tool --dir ~/a');
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.match(r.stdout, /edit: scripts\/shiny-tool__config\.json, scripts\/shiny-tool__fixtures\.json/);
	assert.doesNotMatch(r.stdout, /edit:[^\n]*portal-template/);
});

// One wording for the install, from the Bolt 0.1.181 source (not seen live by this test):
//  1. the review card (PackInstallReview.svelte: "Signed by its author ... If you made this pack yourself, that is expected: install it");
//  2. then, on EVERY OS and for every pack not signed by the Bolt publisher, Bolt's own native dialog "Install an unverified Bolt pack?" with Install and
//     Cancel (src-tauri/src/user_utilities/commands.rs, install_pack_inner, `confirm_unverified_pack_install`; declining returns
//     "Install cancelled: the pack is signed by its author, not by Sparcle."). It is not a macOS prompt;
//  3. then Settings, Desktop App, User Apps, expand the app, Review and accept.
const DIALOG = /Install an unverified Bolt pack\?/;
test('the journey text names the "Install an unverified Bolt pack?" dialog and no macOS-only prompt', () => {
	for (const f of ['kit/examples/QUICKSTART.md', 'README.md', 'AGENTS.md', 'toolkit/README.md']) {
		const t = fs.readFileSync(path.join(REPO, f), 'utf8');
		assert.match(t, DIALOG, `${f} must name the second dialog`);
		assert.match(t, /Review and accept/, f);
	}
});
const walk = (d, out = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (['node_modules', '.git', 'golden', '__pycache__'].includes(e.name)) continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p, out); else if (/\.(md|mjs|json|yaml)$/.test(e.name) && !p.includes(`${path.sep}test${path.sep}`)) out.push(p); } return out; };
test('no doc or tool tells the person to approve twice or "both prompts"', () => {
	const bad = /second prompt|both prompts|asks once more|confirm the permissions|approve both|macOS unverified|unverified-developer|possible macOS prompt|macOS prompt|on macOS an unverified/i;
	for (const f of walk(REPO)) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), bad, path.relative(REPO, f));
});

test('the Bolt-said table quotes the 181 dialog sentences, not the raw backend ones', async () => {
	const { BOLT_SAYS } = await import('../lib/boltsays.mjs');
	const said = Object.fromEntries(BOLT_SAYS.map((r) => [r[0], r[1]]));
	assert.match(said.owned_by_other, /^Bolt did not install this pack because one of its files already belongs to another installed pack\. Nothing was changed\./);
	assert.match(said.same_or_older_version, /this version, or a newer one, is already installed/);
	assert.match(said.version_unreadable, /^This pack cannot be installed here\./);
	assert.doesNotMatch(QS, /different signer/);
	assert.match(QS, /one of its files already belongs to another installed pack/);
});
