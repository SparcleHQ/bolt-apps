// Run: node --test toolkit/test/compat-corpus.test.mjs
// The compat corpus: every gallery app (released 181 to 184) is a frozen fixture with goldens. Each one must still pass lint and check on the
// current toolkit, so a change that breaks an old app fails here. Fixtures are the public gallery files only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EX = path.join(REPO, 'kit/examples');
const apps = fs.readdirSync(EX).filter((d) => fs.existsSync(path.join(EX, d, 'check.json'))).sort();
const run = (args) => spawnSync(process.execPath, [path.join(REPO, 'toolkit/bin/bolt-apps.mjs'), ...args], { cwd: REPO, encoding: 'utf8', timeout: 120000 });

test('the corpus is the whole gallery: every app with a check.json is here, and each case that names a golden has the file', () => {
	assert.ok(apps.length >= 20, `only ${apps.length} apps`);
	let withGoldens = 0;
	for (const a of apps) {
		const cases = JSON.parse(fs.readFileSync(path.join(EX, a, 'check.json'), 'utf8')).cases || [];
		for (const c of cases) if (c.golden) { assert.ok(fs.existsSync(path.join(EX, a, c.golden)), `${a}: missing ${c.golden}`); withGoldens++; }
	}
	assert.ok(withGoldens >= 60, `only ${withGoldens} goldens`);
});

for (const a of apps) {
	test(`compat: ${a} passes lint --personal and check`, () => {
		const l = run(['lint', '--personal', `kit/examples/${a}`]);
		assert.equal(l.status, 0, `${a} lint:\n${(l.stdout + l.stderr).slice(-800)}`);
		const c = run(['check', `kit/examples/${a}`]);
		assert.equal(c.status, 0, `${a} check:\n${(c.stdout + c.stderr).slice(-800)}`);
	});
}
