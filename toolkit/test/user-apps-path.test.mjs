// The tab in Bolt 0.1.182 is "Desktop App", and User Apps shows only when Settings is switched to Advanced.
// Every place that tells a person where to approve an app must say that, from ONE constant, and none may keep the old
// "Settings, Desktop, User Apps" (the tester on 0.1.182 followed it and found no such tab).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { USER_APPS_PATH, USER_APPS_HIDDEN_NOTE } from '../lib/boltsays.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIP = new Set(['node_modules', '.git', '.worktrees']);

function* walk(dir) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		if (SKIP.has(e.name)) continue;
		const p = path.join(dir, e.name);
		if (e.isDirectory()) yield* walk(p);
		else if (/\.(md|mjs|json|txt)$/.test(e.name)) yield p;
	}
}

test('the shared path names the real tab', () => {
	assert.equal(USER_APPS_PATH, 'Settings, Desktop App, User Apps');
	assert.match(USER_APPS_HIDDEN_NOTE, /Advanced/);
});

test('no file in the repo still sends a person to "Settings, Desktop, User Apps"', () => {
	const stale = [];
	for (const f of walk(REPO)) {
		if (path.relative(REPO, f) === path.join('toolkit', 'test', 'user-apps-path.test.mjs')) continue;
		if (/Settings, Desktop, User Apps|Desktop, User Apps/.test(fs.readFileSync(f, 'utf8'))) stale.push(path.relative(REPO, f));
	}
	assert.deepEqual(stale, []);
});

test('ship prints the real path and says what to do when User Apps is hidden', () => {
	const src = fs.readFileSync(path.join(REPO, 'toolkit', 'lib', 'workflow.mjs'), 'utf8');
	assert.match(src, /USER_APPS_PATH/, 'ship text must use the shared constant');
	assert.match(src, /USER_APPS_HIDDEN_NOTE/, 'ship text must carry the Advanced note');
});
