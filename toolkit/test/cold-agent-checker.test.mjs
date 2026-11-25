// Run: node --test toolkit/test/cold-agent-checker.test.mjs
// The offline half of the cold-agent run (scripts/cold-agent.sh is manual: it needs a live agent). A canned good app must pass
// scripts/cold-agent-check.mjs and a canned bad one must fail, so a checker that always says yes is caught.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(REPO, 'toolkit/bin/bolt-apps.mjs');
const CHECK = path.join(REPO, 'scripts/cold-agent-check.mjs');
const node = (...a) => spawnSync(process.execPath, a, { encoding: 'utf8' });
const fresh = () => {
	const out = fs.mkdtempSync(path.join(os.tmpdir(), 'bolt-cold-chk-'));
	const n = node(CLI, 'new', 'lookup-template', 'cold-demo', '--dir', out);
	assert.equal(n.status, 0, n.stdout + n.stderr);
	return out;
};

test('cold-agent checker: a good produced app passes', () => {
	const r = node(CHECK, fresh());
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.match(r.stdout, /all steps passed/);
});

test('cold-agent checker: a bad produced app fails (an unknown key in the app file)', () => {
	const out = fresh(), y = path.join(out, 'cold-demo/utilities/cold-demo.yaml');
	fs.writeFileSync(y, fs.readFileSync(y, 'utf8') + '\nnot_a_real_key: 1\n');
	const r = node(CHECK, out);
	assert.notEqual(r.status, 0, 'a broken app must not pass: ' + r.stdout);
	assert.match(r.stdout, /FAIL/);
});

test('cold-agent checker: nothing produced is a failure, not a pass', () => {
	const r = node(CHECK, fs.mkdtempSync(path.join(os.tmpdir(), 'bolt-cold-empty-')));
	assert.equal(r.status, 2);
});

test('cold-agent.sh refuses to run without COLD_AGENT_CMD', () => {
	const r = spawnSync('bash', [path.join(REPO, 'scripts/cold-agent.sh')], { encoding: 'utf8', env: { ...process.env, COLD_AGENT_CMD: '' } });
	assert.notEqual(r.status, 0);
	assert.match(r.stderr, /COLD_AGENT_CMD/);
});
