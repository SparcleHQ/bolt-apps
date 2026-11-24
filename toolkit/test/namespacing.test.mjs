// Run: node --test toolkit/test/namespacing.test.mjs
// Bolt installs every pack's scripts into ONE shared folder and refuses (owned_by_other) a file whose path already belongs to another installed pack.
// These tests simulate that ownership rule on real packs: two apps built from the public examples must never share a script path, and a copy made
// with `new` must carry its own names and none of the template's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { readPack, tarFile } from '../bin/bolt-apps.mjs';
import { clockVersion, newer, bump } from '../lib/workflow.mjs';
import { BOLT_SAYS, markdownTable } from '../lib/boltsays.mjs';
import { scanMentions, declaredHostsOf, assessYaml } from '../lib/assess.mjs';
import { spawnPython } from '../lib/python.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const CLI = path.resolve(HERE, '../bin/bolt-apps.mjs');
const EX = path.join(REPO, 'kit', 'examples');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const cli = (home, cwd, ...a) => spawnSync(process.execPath, [CLI, ...a], { cwd, encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
const KEY = (() => { const d = tmp('ns-key-'); const k = path.join(d, 'key.pem'); const r = spawnSync(process.execPath, [CLI, 'keygen', '--out', k], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return k; })();
const examples = fs.readdirSync(EX, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(EX, e.name, 'bolt-app.json'))).map((e) => e.name);

// What Bolt would write under scripts/ for this pack: the path of every script entry, relative to scripts/.
function installedScripts(pack) {
	const r = readPack(pack); assert.ok(r.ok, `${pack}: ${r.reason}`);
	return r.meta.entries.filter((e) => e.kind === 'script').map((e) => e.path.replace(/^manifests\/scripts\//, ''));
}
function packOf(dir, out) { const r = cli(os.homedir(), REPO, 'pack', dir, '--personal', '--key', KEY, '--out', out); assert.equal(r.status, 0, `${dir}\n${r.stdout}${r.stderr}`); return out; }
// Bolt's ownership by path, case-insensitive (one file on macOS and Windows), and a name that is a file in one pack and a folder in the other.
function clashes(a, b) {
	const out = [], low = (x) => x.toLowerCase();
	for (const x of a) for (const y of b) { const p = low(x), q = low(y); if (p === q || p.startsWith(`${q}/`) || q.startsWith(`${p}/`)) out.push(`${x} vs ${y}`); }
	return out;
}

test('every public example ships only files named for its own app id', () => {
	const out = tmp('ns-all-');
	const sets = new Map(examples.map((n) => [n, installedScripts(packOf(path.join(EX, n), path.join(out, `${n}.boltpack`)))]));
	for (const [n, files] of sets) for (const f of files) assert.ok(f.startsWith(`${n}__`), `${n}: scripts/${f} is not named ${n}__<name>`);
	assert.ok(examples.length >= 21, `expected all 21 examples, found ${examples.length}`);
});

test('any two public examples are pairwise disjoint (Bolt would refuse the second install with owned_by_other)', () => {
	const out = tmp('ns-pairs-');
	const sets = examples.map((n) => [n, installedScripts(packOf(path.join(EX, n), path.join(out, `${n}.boltpack`)))]);
	let pairs = 0;
	for (let i = 0; i < sets.length; i++) for (let j = i + 1; j < sets.length; j++) { pairs++; assert.deepEqual(clashes(sets[i][1], sets[j][1]), [], `${sets[i][0]} and ${sets[j][0]} would collide in Bolt's shared scripts folder`); }
	assert.ok(pairs >= 210);
});

test('the check at the heart of it: two apps that share a bare file name are told apart by the toolkit', () => {
	const d = tmp('ns-bare-'), home = tmp('ns-home-');
	for (const id of ['bare-one', 'bare-two']) {
		const r = cli(home, d, 'new', 'script-template', id, '--dir', d); assert.equal(r.status, 0, r.stderr);
		// undo the namespacing the way an old app would have it
		const sd = path.join(d, id, 'scripts');
		for (const f of fs.readdirSync(sd)) fs.renameSync(path.join(sd, f), path.join(sd, f.replace(`${id}__`, '')));
	}
	const v = cli(home, d, 'lint', path.join(d, 'bare-one'), '--personal'); assert.notEqual(v.status, 0);
	assert.match(v.stdout, /script_not_namespaced/);
	assert.match(v.stdout, /owned_by_other/);
	const p = cli(home, d, 'pack', path.join(d, 'bare-one'), '--personal', '--key', KEY); assert.notEqual(p.status, 0);
});

test('`new` from the same template with two ids gives disjoint paths, and so does a different template', () => {
	const d = tmp('ns-new-'), home = tmp('ns-home-');
	const made = [['portal-template', 'one-app'], ['portal-template', 'two-app'], ['pulse-feed', 'three-app'], ['script-template', 'four-app'], ['expense-tracker', 'five-app']];
	const sets = made.map(([t, id]) => { const r = cli(home, d, 'new', t, id, '--dir', d); assert.equal(r.status, 0, `${t} ${id}\n${r.stdout}${r.stderr}`); return [id, installedScripts(packOf(path.join(d, id), path.join(d, `${id}.boltpack`)))]; });
	for (const [id, files] of sets) { assert.ok(files.length, id); for (const f of files) assert.ok(f.startsWith(`${id}__`), `${id}: ${f}`); }
	for (let i = 0; i < sets.length; i++) for (let j = i + 1; j < sets.length; j++) assert.deepEqual(clashes(sets[i][1], sets[j][1]), []);
});

test('a copy made with `new` rewrites the template chip, id and file prefix outside the README credit', () => {
	const d = tmp('ns-words-'), home = tmp('ns-home-');
	for (const t of ['branch-explorer', 'acme-dash', 'portal-template', 'script-template', 'pulse-feed', 'around', 'repo-radar', 'cli-wrapper-template', 'unit-convert', 'widget-gallery']) {
		const yamlT = fs.readFileSync(path.join(EX, t, 'utilities', fs.readdirSync(path.join(EX, t, 'utilities'))[0]), 'utf8');
		const oldChip = /^chip: (\S+)/m.exec(yamlT)[1];
		const id = `${t.slice(0, 8).replace(/-$/, '')}-copy`;
		const r = cli(home, d, 'new', t, id, '--dir', d); assert.equal(r.status, 0, `${t}\n${r.stdout}${r.stderr}`);
		const files = [];
		const walk = (x) => { for (const e of fs.readdirSync(x, { withFileTypes: true })) { const f = path.join(x, e.name); if (e.isDirectory()) walk(f); else if (/\.(md|json|yaml)$/.test(e.name) && !/fixtures\.json$|^golden$/.test(e.name) && !f.includes(`${path.sep}golden${path.sep}`)) files.push(f); } };
		walk(path.join(d, id));
		const newChip = /^chip: (\S+)/m.exec(fs.readFileSync(path.join(d, id, 'utilities', `${id}.yaml`), 'utf8'))[1];
		for (const f of files) {
			const text = fs.readFileSync(f, 'utf8'), rel = path.relative(path.join(d, id), f);
			if (oldChip !== newChip) assert.ok(!new RegExp(`=${oldChip}(?![A-Za-z0-9_-])`).test(text), `${t}: ${rel} still tells the person to type =${oldChip}`);
			if (/README\.md$/.test(rel)) {
				const credit = `\n> Based on the \`${t}\` example from Bolt Apps,`;
				const readme = rel === 'README.md' ? text.replace(credit, '\n') : text;
				assert.doesNotMatch(readme, new RegExp(`(?<![A-Za-z0-9_-])${t}(?![A-Za-z0-9_]|-[A-Za-z0-9])`), `${t}: ${rel} still names the template ${t}`);
			}
			assert.ok(!text.includes(`${t}__`), `${t}: ${rel} still has the template's file prefix`);
		}
		const lint = cli(home, d, 'lint', path.join(d, id), '--personal'); assert.equal(lint.status, 0, lint.stdout);
		assert.ok(!/description_chip_mismatch/.test(lint.stdout), `${t}: ${lint.stdout}`);
	}
});

test('lint and verify warn when the description names a =chip that is not the app\'s chip', () => {
	const d = tmp('ns-chip-'), home = tmp('ns-home-');
	assert.equal(cli(home, d, 'new', 'branch-explorer', 'chipcheck', '--dir', d).status, 0);
	const y = path.join(d, 'chipcheck', 'utilities', 'chipcheck.yaml');
	fs.writeFileSync(y, fs.readFileSync(y, 'utf8').replace(/^description: "/m, 'description: "Type =branch, then Enter. '));
	for (const a of [['lint', path.join(d, 'chipcheck'), '--personal'], ['verify', path.join(d, 'chipcheck')]]) { const r = cli(home, d, ...a); assert.match(r.stdout, /description_chip_mismatch/, a[0]); assert.match(r.stdout, /=branch/); assert.match(r.stdout, /warning/i); }
});

test('the toolkit refuses a bare shared name; verify says what to do', () => {
	const d = tmp('ns-verify-'), home = tmp('ns-home-');
	assert.equal(cli(home, d, 'new', 'script-template', 'vtest', '--dir', d).status, 0);
	const sd = path.join(d, 'vtest', 'scripts');
	fs.renameSync(path.join(sd, 'vtest__config.json'), path.join(sd, 'config.json'));
	const r = cli(home, d, 'verify', path.join(d, 'vtest'), '--json'); const j = JSON.parse(r.stdout);
	const f = j.findings.find((x) => x.code === 'script_not_namespaced'); assert.ok(f, r.stdout); assert.match(f.fix, /<app id>__/);
});

test('ship: a lost ship.json cannot make a lower version; --version still wins; the reason is printed', async () => {
	const d = tmp('ns-ship-'), home = tmp('ns-home-');
	const options = { cwd: d, encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } };
	const run = (...args) => spawnSync(process.execPath, [CLI, ...args], options);
	assert.equal(run('new', 'script-template', 'shipper', '--dir', d).status, 0);
	const ver = (r) => {
		assert.equal(r.status, 0, r.stdout + r.stderr);
		const shipped = /^Shipped shipper (\S+): (.+)$/m.exec(r.stdout);
		assert.ok(shipped, r.stdout);
		assert.equal(shipped[2], path.join(home, '.bolt-apps', 'packs', `shipper-${shipped[1]}.boltpack`));
		return shipped[1];
	};
	const v1 = ver(run('ship', path.join(d, 'shipper')));
	assert.match(v1, /^1\.0\.\d+$/);
	const r2 = run('ship', path.join(d, 'shipper')); const v2 = ver(r2); assert.ok(newer(v2, v1), `${v2} must be higher than ${v1}`);
	// lose every note this computer kept
	fs.rmSync(path.join(home, '.bolt-apps', 'ship.json')); fs.rmSync(path.join(home, '.bolt-apps', 'packs'), { recursive: true });
	await new Promise((r) => setTimeout(r, 1100));
	const r3 = run('ship', path.join(d, 'shipper')); const v3 = ver(r3); assert.ok(newer(v3, v2), `${v3} must be higher than ${v2} after ship.json was deleted`);
	assert.match(r3.stdout, /version \S+: taken from the clock/);
	assert.match(r3.stdout, /HIGH risk/); assert.match(r3.stdout, /owned_by_other/);
	const forced = run('ship', path.join(d, 'shipper'), '--version', '9.9.9'); assert.equal(ver(forced), '9.9.9');
	const after = run('ship', path.join(d, 'shipper')); assert.ok(newer(ver(after), '9.9.9'));
	const bad = run('ship', path.join(d, 'shipper'), '--version', 'abc'); assert.notEqual(bad.status, 0);
	// --version also takes a short or tagged form; the next build must still be higher than it, never 1.0.1
	for (const v of ['20.0', 'v30.1.0-rc1']) {
		assert.equal(ver(run('ship', path.join(d, 'shipper'), '--version', v)), v);
		const next = ver(run('ship', path.join(d, 'shipper'))); assert.ok(newer(next, v), `${next} must be higher than ${v}`);
	}
	// the same when ship.json is lost: the version is read from the packs themselves, in every form --version takes
	for (const v of ['40', 'V41.0', 'v42.1.0-rc1', '43.1.0+build.7']) {
		assert.equal(ver(run('ship', path.join(d, 'shipper'), '--version', v)), v);
		fs.rmSync(path.join(home, '.bolt-apps', 'ship.json'));
		const lost = ver(run('ship', path.join(d, 'shipper'))); assert.ok(newer(lost, v), `${lost} must be higher than ${v} after ship.json was deleted`);
	}
	// a pack of another app whose id starts the same (shipper-2) never counts, however its file is named
	const top = ver(run('ship', path.join(d, 'shipper')));
	assert.equal(run('new', 'script-template', 'shipper-2', '--dir', d).status, 0);
	assert.equal(run('ship', path.join(d, 'shipper-2'), '--version', '900.0.0').status, 0);
	fs.renameSync(path.join(home, '.bolt-apps', 'packs', 'shipper-2-900.0.0.boltpack'), path.join(home, '.bolt-apps', 'packs', 'shipper-900.0.0.boltpack'));
	fs.rmSync(path.join(home, '.bolt-apps', 'ship.json'));
	const own = ver(run('ship', path.join(d, 'shipper'))); assert.ok(newer(own, top) && !newer(own, '900.0.0'), `${own}: only shipper's own packs count`);
	// Invalid packs never raise the version, and ship does not open a pipe.
	const pk = path.join(home, '.bolt-apps', 'packs'); fs.rmSync(path.join(pk, 'shipper-900.0.0.boltpack'));
	const candidate = path.join(pk, 'shipper-999.0.0.boltpack');
	const fake = Buffer.from(JSON.stringify({ pack: { pack_id: 'shipper' }, bundle_version: '999.0.0' }));
	fs.writeFileSync(candidate, zlib.gzipSync(Buffer.concat([tarFile('bundle.json', fake), Buffer.alloc(1024)])));
	// A real pack can be renamed. Its metadata, not file name or modification time, determines its version.
	fs.renameSync(path.join(pk, `shipper-${own}.boltpack`), path.join(pk, 'shipper-0.1.0.boltpack'));
	const renamed = path.join(pk, 'shipper-0.1.0.boltpack');
	const archive = zlib.gunzipSync(fs.readFileSync(renamed));
	const manifestSize = parseInt(archive.toString('utf8', 124, 136), 8);
	const manifestEnd = 512 + Math.ceil(manifestSize / 512) * 512;
	const signatureEnd = manifestEnd + 1024;   // 512-byte header, 64-byte signature and padding
	// Moving the first tar member does not change the signed bytes. The alternate order still counts.
	fs.writeFileSync(renamed, zlib.gzipSync(Buffer.concat([archive.subarray(manifestEnd, signatureEnd), archive.subarray(0, manifestEnd), archive.subarray(signatureEnd)])));
	assert.equal(readPack(renamed).ok, true);
	fs.utimesSync(renamed, 1000, 1000);
	fs.writeFileSync(path.join(pk, 'shipper-950.0.0.boltpack'), 'not a pack');
	if (process.platform !== 'win32') assert.equal(spawnSync('mkfifo', [path.join(pk, 'shipper-960.0.0.boltpack')]).status, 0);
	fs.rmSync(path.join(home, '.bolt-apps', 'ship.json'));
	// Count full reads by ship, not by its verify subprocess.
	const trace = path.join(d, 'trace.cjs'), reads = path.join(d, 'pack-reads.log');
	fs.writeFileSync(reads, '');
	fs.writeFileSync(trace, `
const fs = require('node:fs');
const path = require('node:path');
const read = fs.readFileSync;
fs.readFileSync = (file, ...args) => {
	if (typeof file === 'string' && file.endsWith('.boltpack')) fs.appendFileSync(${JSON.stringify(reads)}, path.basename(file) + '\\n');
	return read(file, ...args);
};`);
	const safe = spawnSync(process.execPath, ['--require', trace, CLI, 'ship', path.join(d, 'shipper')], { ...options, timeout: 120000 });
	assert.equal(safe.error, undefined, 'ship must not block on a pipe in the packs folder'); const sv = ver(safe); assert.ok(newer(sv, own) && !newer(sv, '900.0.0'), sv);
	const fullyRead = fs.readFileSync(reads, 'utf8').split('\n').filter(Boolean);
	assert.deepEqual(fullyRead.filter((f) => f !== path.basename(candidate)), [path.basename(renamed)], 'older packs must not be read in full');
});

test('pack version hints read leading metadata without trusting it as a verified pack', async (t) => {
	const { readPackMetadata } = await import('../lib/pack.mjs');
	const d = tmp('ns-meta-');
	t.after(() => fs.rmSync(d, { recursive: true, force: true }));
	const file = path.join(d, 'build.boltpack'), meta = { bundle_version: '8.1', pack: { pack_id: 'shipper' } };
	const header = tarFile('bundle.json', Buffer.from(JSON.stringify(meta)));
	const write = (...entries) => fs.writeFileSync(file, zlib.gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)])));
	write(header);
	assert.deepEqual(await readPackMetadata(file), meta);
	assert.equal(readPack(file).ok, false, 'metadata alone is not evidence of a valid pack');
	write(tarFile('signature.bin', Buffer.alloc(64)), header);
	assert.equal(await readPackMetadata(file), undefined, 'other tar member orders use the full reader');
});

test('pack suggests a --version that is really higher, also for a +build version', () => {
	const d = tmp('ns-hint-'), home = tmp('ns-home-');
	assert.equal(cli(home, d, 'new', 'script-template', 'hinted', '--dir', d).status, 0);
	const r = cli(home, d, 'pack', path.join(d, 'hinted'), '--personal', '--key', KEY, '--version', '1.2.3+build.7', '--out', path.join(d, 'h.boltpack')); assert.equal(r.status, 0, r.stdout + r.stderr);
	const s = /for example --version (\S+)\)/.exec(r.stdout); assert.ok(s, r.stdout); assert.ok(newer(s[1], '1.2.3+build.7'), s[1]);
});

test('bump gives a version newer than every form --version accepts', () => {
	for (const [v, want] of [['1.0.5', '1.0.6'], ['2.0', '2.0.1'], ['2', '2.0.1'], ['v1.2.0-rc1', '1.2.1'], ['1.2.3+build.7', '1.2.4'], ['1.2.3.1000', '1.2.3.1001']]) {
		assert.equal(bump(v), want, v); assert.ok(newer(bump(v), v), v);
	}
});

test('bump and newer keep all digits of large version components', () => {
	const last = '2.0.0.9007199254740992';
	const next = '2.0.0.9007199254740993';
	assert.equal(bump(last), next);
	assert.equal(bump(`v${next}-rc1+build.7`), '2.0.0.9007199254740994');
	assert.ok(newer(next, last));
	assert.ok(!newer(last, next));
});

test('new <template> <id> puts the person in author, never the examples name, and the pack carries that name', () => {
	const d = tmp('ns-author-'), home = tmp('ns-home-');
	const author = (id) => JSON.parse(fs.readFileSync(path.join(d, id, 'bolt-app.json'), 'utf8')).author;
	const authorReminder = /login name.*author\.name in bolt-app\.json.*before sharing/;
	const custom = cli(home, d, 'new', 'portal-template', 'mine', '--dir', d, '--author', 'Tester');
	assert.equal(custom.status, 0, custom.stdout + custom.stderr);
	assert.doesNotMatch(custom.stdout, authorReminder);
	assert.match(custom.stdout, /README\.md starts with a note\. Replace the template text and keep the source credit/);
	assert.deepEqual(author('mine'), { name: 'Tester' });
	const out = path.join(d, 'mine.boltpack'); packOf(path.join(d, 'mine'), out);
	const r = readPack(out); assert.ok(r.ok, r.reason); assert.equal(r.meta.signed_by, 'Tester'); assert.equal(r.meta.pack.author.name, 'Tester');
	assert.doesNotMatch(JSON.stringify(r.meta), /Bolt Apps examples|github\.com/);
	// with no --author, the login name, as `new <id>` does
	for (const [id, args] of [['mine-2', ['script-template']], ['mine-3', []]]) {
		const created = cli(home, d, 'new', ...args, id, '--dir', d);
		assert.equal(created.status, 0, created.stdout + created.stderr);
		assert.match(created.stdout, authorReminder);
		if (args.length) assert.ok(created.stdout.search(authorReminder) < created.stdout.indexOf("Make it yours"), created.stdout);
		assert.deepEqual(author(id), { name: os.userInfo().username });
	}
	const readme = fs.readFileSync(path.join(d, 'mine', 'README.md'), 'utf8');
	assert.match(readme, /`portal-template` example.*Apache-2\.0/);
	assert.match(readme, /author credit.*`derived_from`/);
});

test('new rejects a missing or blank --author value without creating an app', () => {
	const d = tmp('ns-author-invalid-'), home = tmp('ns-home-');
	for (const prefix of [['portal-template'], []]) {
		for (const args of [['--author', '--dir', d], ['--dir', d, '--author'], ['--dir', d, '--author', ''], ['--dir', d, '--author', '   ']]) {
			const r = cli(home, d, 'new', ...prefix, 'mine', ...args);
			assert.equal(r.status, 2, r.stdout + r.stderr);
			assert.match(r.stderr, /--author requires a non-empty name/);
			assert.deepEqual(fs.readdirSync(d), []);
		}
	}
});

test('new skips the login lookup for --author and falls back if no login is available', () => {
	const d = tmp('ns-author-login-'), home = tmp('ns-home-');
	const preload = path.join(d, 'no-login.cjs');
	fs.writeFileSync(preload, "require('node:os').userInfo = () => { process.stderr.write('userInfo called\\n'); throw new Error('no login'); };\n");
	const create = (id, ...args) => {
		const r = spawnSync(process.execPath, ['--require', preload, CLI, 'new', 'portal-template', id, '--dir', d, ...args], {
			cwd: d, encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, USER: 'FixtureUser' },
		});
		assert.equal(r.status, 0, r.stdout + r.stderr);
		const { author } = JSON.parse(fs.readFileSync(path.join(d, id, 'bolt-app.json'), 'utf8'));
		return { author, stderr: r.stderr };
	};
	const explicit = create('explicit', '--author', 'Tester');
	assert.deepEqual(explicit.author, { name: 'Tester' });
	assert.doesNotMatch(explicit.stderr, /userInfo called/);
	const fallback = create('fallback');
	assert.deepEqual(fallback.author, { name: 'FixtureUser' });
	assert.match(fallback.stderr, /userInfo called/);
});

test('the transform `new` writes and the AGENTS.md worked example use icons the launcher has (no icon_unknown)', () => {
	const d = tmp('ns-icon-'), home = tmp('ns-home-');
	assert.equal(cli(home, d, 'new', 'g-app', '--type', 'transform', '--dir', d, '--author', 'Tester').status, 0);
	const l = cli(home, d, 'lint', path.join(d, 'g-app')); assert.equal(l.status, 0, l.stdout); assert.doesNotMatch(l.stdout, /icon_unknown|warning/);
	const icons = new Set(JSON.parse(fs.readFileSync(path.join(REPO, 'kit', 'schema', 'icons.json'), 'utf8')).icons);
	const agents = fs.readFileSync(path.join(REPO, 'AGENTS.md'), 'utf8'), m = /\nicon: (\S+)\n/.exec(agents.slice(agents.indexOf('## 9. Worked example')));
	assert.ok(m && icons.has(m[1]), `AGENTS.md worked example icon: ${m && m[1]}`);
});

test('clockVersion follows the rules of Bolt\'s own version order', () => {
	const a = clockVersion(Date.UTC(2026, 10, 15)), b = clockVersion(Date.UTC(2026, 10, 15, 0, 0, 1));
	assert.ok(newer(b, a)); assert.ok(newer('1.0.1000000', '1.0.999999')); assert.ok(!newer('1.0', '1.0.0'));
	assert.match(a, /^1\.0\.[1-9]\d*$/);
});

test('"Bolt said X, do Y": every code has a plain fix, and the table for the docs is generated from the same list', () => {
	const codes = new Set(BOLT_SAYS.map((r) => r[0]));
	for (const c of ['same_or_older_version', 'owned_by_other', 'version_unreadable', 'file_exists', 'file_and_folder', 'case_collision', 'too_deep', 'unsafe_path', 'in_the_way', 'write_failed', 'ledger_unreadable', 'signature_recheck', 'unverified', 'outside_pack', 'cancelled', 'org_policy']) assert.ok(codes.has(c), c);
	for (const [c, said, fix] of BOLT_SAYS) { assert.ok(said.length > 8 && fix.length > 20, c); assert.ok(!/[\u2013\u2014]/.test(said + fix), `${c}: no dashes`); }
	assert.ok(markdownTable().split('\n').length === BOLT_SAYS.length + 2);
	const r = spawnSync(process.execPath, [CLI, 'doctor', '--bolt-says'], { encoding: 'utf8' }); assert.equal(r.status, 0); assert.match(r.stdout, /same_or_older_version/);
});

test('docs/verify-rules.md holds the same "Bolt said X, do Y" table the toolkit prints', () => {
	assert.ok(fs.readFileSync(path.join(REPO, 'docs', 'verify-rules.md'), 'utf8').includes(markdownTable()));
});

test('`new` with an id that contains the template name (X-2, X-2-a, X itself, a prefix, a suffix) never doubles a name', () => {
	const d = tmp('ns-ids-'), home = tmp('ns-home-');
	for (const id of ['script-template-2', 'script-template-2-a', 'script-template', 'script', 'template', 'x-script-template']) {
		const r = cli(home, d, 'new', 'script-template', id, '--dir', d); assert.equal(r.status, 0, `${id}\n${r.stdout}${r.stderr}`);
		const files = fs.readdirSync(path.join(d, id, 'scripts'));
		assert.ok(files.length && files.every((f) => f.startsWith(`${id}__`) && !f.slice(id.length + 2).includes('__')), `${id}: ${files}`);
		const l = cli(home, d, 'lint', path.join(d, id), '--personal'); assert.equal(l.status, 0, `${id}\n${l.stdout}`);
		for (const f of fs.readdirSync(path.join(d, id), { recursive: true })) { const p = path.join(d, id, f); if (fs.statSync(p).isFile() && /\.(md|json|yaml)$/.test(f) && !/fixtures\.json$/.test(f) && !f.includes('golden')) assert.ok(!new RegExp(`${id}-\\d+__|${id}-${id}`).test(fs.readFileSync(p, 'utf8')), `${id}: ${f}`); }
	}
});

test('`new` removes the half-made folder when it fails (no python to generate the app file)', () => {
	const d = tmp('ns-fail-'), id = 'half-made';
	const r = spawnSync(process.execPath, [CLI, 'new', 'portal-template', id, '--dir', d], { encoding: 'utf8', env: { HOME: d, PATH: '/nonexistent' } });
	assert.notEqual(r.status, 0); assert.match(r.stderr, /could not generate/);
	assert.ok(!fs.existsSync(path.join(d, id)), 'no half-made folder is left');
});

test('a pack path over 100 characters is refused by lint with the plain fix', () => {
	const d = tmp('ns-long-'), home = tmp('ns-home-');
	assert.equal(cli(home, d, 'new', 'script-template', 'longer', '--dir', d).status, 0);
	fs.writeFileSync(path.join(d, 'longer', 'scripts', `longer__${'x'.repeat(80)}.py`), 'x');
	const l = cli(home, d, 'lint', path.join(d, 'longer'), '--personal'); assert.equal(l.status, 1); assert.match(l.stdout, /too long/); assert.match(l.stdout, /up to 128 characters per name/); assert.match(l.stdout, /at most 82/); assert.match(l.stdout, /Shorten the file name or the app id/);
	fs.rmSync(path.join(d, 'longer', 'scripts', `longer__${'x'.repeat(80)}.py`));
	fs.writeFileSync(path.join(d, 'longer', 'scripts', `longer__${'y'.repeat(125)}.py`), 'x');
	const l2 = cli(home, d, 'lint', path.join(d, 'longer'), '--personal'); assert.equal(l2.status, 1); assert.match(l2.stdout, /up to 128 characters per name/);
});

test('lint refuses ".." inside a script name (the launcher refuses any path part containing ..)', () => {
	const d = tmp('ns-dots-'), home = tmp('ns-home-');
	assert.equal(cli(home, d, 'new', 'script-template', 'dots', '--dir', d).status, 0);
	fs.writeFileSync(path.join(d, 'dots', 'scripts', 'dots__a..b.py'), 'x');
	const l = cli(home, d, 'lint', path.join(d, 'dots'), '--personal'); assert.equal(l.status, 1); assert.match(l.stdout, /script_path/);
});

test('a script run under another name says what is wrong in one sentence, not a traceback', () => {
	const d = tmp('ns-rename-'), home = tmp('ns-home-');
	assert.equal(cli(home, d, 'new', 'script-template', 'renamed', '--dir', d).status, 0);
	const sd = path.join(d, 'renamed', 'scripts'); fs.renameSync(path.join(sd, 'renamed__app.py'), path.join(sd, 'app.py'));
	const r = spawnPython(['-X', 'utf8', '-I', path.join(sd, 'app.py')], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
	assert.notEqual(r.status, 0); assert.match(r.stderr, /script files must be named <app id>__<name>/); assert.doesNotMatch(r.stderr, /Traceback|ModuleNotFoundError/);
});

test('docs/verify-rules.md quotes the exact Bolt install sentences', () => {
	const d = fs.readFileSync(path.join(REPO, 'docs', 'verify-rules.md'), 'utf8');
	for (const s of ['a pack is only replaced by a newer version', 'it cannot tell whether this is newer than the installed version', 'already belongs to', 'is nested more than 8 folders deep', "Your organization's policy on this device installs only packs signed with a key built into Bolt", 'at most 82']) assert.ok(d.includes(s), s);
});

test('the install-prompt scan reads the .json files the app file names, as Bolt does', () => {
	const d = tmp('ns-scan-'), home = tmp('ns-home-');
	assert.equal(cli(home, d, 'new', 'script-template', 'scanned', '--dir', d).status, 0);
	const fx = path.join(d, 'scanned', 'scripts', 'scanned__fixtures.json'), j = JSON.parse(fs.readFileSync(fx, 'utf8'));
	j.note = 'Run open -a Safari to see it, or visit https://user:pw@example.com/x'; fs.writeFileSync(fx, JSON.stringify(j));
	const v = JSON.parse(cli(home, d, 'verify', path.join(d, 'scanned'), '--json').stdout);
	const m = v.findings.filter((f) => f.code === 'script_mentions').map((f) => f.message).join('\n');
	assert.match(m, /open \(starts other programs or documents\) \(in scanned__fixtures\.json\)/); assert.match(m, /user name or a backslash in it \(in scanned__fixtures\.json\)/);
});

test('the chip is the id (hyphens kept), an upgrade keeps it, and a changed chip warns on ship', () => {
	const d = tmp('ns-chip2-'), home = tmp('ns-home-');
	for (const [tpl, id] of [['acme-dash', 'acme-dashx'], ['script-template', 'csv-insights'], ['portal-template', 'cdp-tabs']]) {
		assert.equal(cli(home, d, 'new', tpl, id, '--dir', d).status, 0);
		const y = fs.readFileSync(path.join(d, id, 'utilities', `${id}.yaml`), 'utf8');
		assert.match(y, new RegExp(`^chip: ${id}$`, 'm'), `${id}: chip keeps its hyphens`);
	}
	const app = path.join(d, 'acme-dashx');
	const s1 = cli(home, d, 'ship', app); assert.equal(s1.status, 0, s1.stdout + s1.stderr); assert.match(s1.stdout, /type =acme-dashx/); assert.doesNotMatch(s1.stdout, /WARNING the chip changed/);
	const s2 = cli(home, d, 'ship', app); assert.equal(s2.status, 0); assert.doesNotMatch(s2.stdout, /WARNING the chip changed/, 're-shipping keeps the chip, no warning');
	const yf = path.join(app, 'utilities', 'acme-dashx.yaml'); fs.writeFileSync(yf, fs.readFileSync(yf, 'utf8').replace(/^chip: .*$/m, 'chip: acmedashx'));
		const s3 = cli(home, d, 'ship', app); assert.notEqual(s3.status, 0, 'a chip that differs from the id is refused before anything is packed'); assert.match(s3.stdout + s3.stderr, /chip_not_id/);
	// the description rule follows the chip, hyphens included
	const l = cli(home, d, 'lint', path.join(d, 'cdp-tabs'), '--personal'); assert.doesNotMatch(l.stdout, /description_chip_mismatch/);
});

test('every public example has chip equal to id, and a chip different from the id is refused', () => {
	for (const n of examples) for (const y of fs.readdirSync(path.join(EX, n, 'utilities'))) {
		const s = fs.readFileSync(path.join(EX, n, 'utilities', y), 'utf8'); assert.equal(/^chip: (\S+)/m.exec(s)[1], /^id: (\S+)/m.exec(s)[1], `${n}/${y}`);
	}
	const d = tmp('ns-chipid-'), home = tmp('ns-home-');
	assert.equal(cli(home, d, 'new', 'script-template', 'chipcase', '--dir', d).status, 0);
	const yf = path.join(d, 'chipcase', 'utilities', 'chipcase.yaml'); fs.writeFileSync(yf, fs.readFileSync(yf, 'utf8').replace(/^chip: .*$/m, 'chip: other'));
	for (const a of [['lint', path.join(d, 'chipcase'), '--personal'], ['verify', path.join(d, 'chipcase')], ['pack', path.join(d, 'chipcase'), '--personal', '--key', KEY]]) { const r = cli(home, d, ...a); assert.notEqual(r.status, 0, a[0]); assert.match(r.stdout + r.stderr, /chip_not_id/, a[0]); }
});

test('on_missing_key: sample shows the labelled data and a key hint; setup shows only the setup row; ship says the start mode', () => {
	const d = tmp('ns-mode-'), home = tmp('ns-home-');
	assert.equal(cli(home, d, 'new', 'portal-template', 'modeapp', '--dir', d, '--full').status, 0);
	const app = path.join(d, 'modeapp'), cfgp = path.join(app, 'scripts', 'modeapp__config.json'), cfg = JSON.parse(fs.readFileSync(cfgp, 'utf8'));
	assert.equal(cfg.api.on_missing_key, 'sample');
	const run = (env) => spawnPython(['-X', 'utf8', '-I', path.join(app, 'scripts', 'modeapp__engine.py'), 'overview'], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, ...env } });
	let rows = JSON.parse(run({}).stdout);
	// the overview is an entity_preview pane (a tile above only for a row with a number), so the label and the key hint are rows with a body, and a row with a number keeps its tile
	assert.ok(rows.some((r) => /^SAMPLE DATA/.test(r.title) && /sample data/i.test(r.body || '')), 'a SAMPLE DATA row whose pane says so');
	assert.ok(rows.some((r) => /^Add your/.test(r.title) && r.body), 'a key hint row with its steps in the pane');
	assert.ok(rows.length > 3, 'the sample data is shown');
	for (const r of rows) if (/^(SAMPLE DATA|Add your)/.test(r.title)) assert.ok(r.kpi_value === undefined || r.kpi_value === '', 'a label row carries no tile');
	cfg.api.on_missing_key = 'setup'; fs.writeFileSync(cfgp, JSON.stringify(cfg, null, 2) + '\n');
	rows = JSON.parse(run({}).stdout); assert.equal(rows.length, 1); assert.match(rows[0].title, /^Add your .* API key$/); assert.ok(!rows[0].pane && !rows[0].kpi_label);
	rows = JSON.parse(run({ BOLT_APP_FIXTURE: '0' }).stdout); assert.equal(rows.length, 1);
	const s = cli(home, d, 'doctor', app); assert.match(s.stdout, /Start mode: live when your key is found; with no key it shows only a row/);
	cfg.api.on_missing_key = 'sample'; fs.writeFileSync(cfgp, JSON.stringify(cfg, null, 2) + '\n');
	assert.match(cli(home, d, 'doctor', app).stdout, /labelled SAMPLE DATA/);
});

test('check refuses what the launcher cannot draw in the right pane: row panes that name no preview, list_data or unsuitable views, and empty or oversized tile grids', async () => {
	const { paneProblems, presentationOf } = await import('../lib/check.mjs');
	const W = (kind, mode) => ({ kind, mode });
	const pres = (top, views) => ({ top, views: new Map(Object.entries(views)), viewArg: 'view' });
	const codes = (p, rows, v = 'overview') => paneProblems(p, rows, v).map((x) => x.code).sort();
	const tiles = { kind: 'cards', mode: 'list_data', layout: 'tiles', valueField: 'kpi_value' }, prev = W('entity_preview', 'selected_row');
	assert.deepEqual(codes(pres(tiles, { overview: null, a: prev }), [{ title: 't', kpi_value: 1, kpi_label: 'x', pane: 'a' }]), []);
	assert.deepEqual(codes(pres(tiles, { overview: null, a: null }), [{ title: 't', pane: 'a' }]), ['pane_no_widget']);
	assert.deepEqual(codes(pres(tiles, { overview: null, a: tiles }), [{ title: 't', pane: 'a' }]), ['pane_list_data']);
	assert.deepEqual(codes(pres(tiles, { overview: null, a: W('diff', 'selected_row') }), [{ title: 't', pane: 'a' }]), ['pane_kind']);
	assert.deepEqual(codes(pres(tiles, { overview: null }), [{ title: 't', pane: 'nope' }]), ['pane_no_view']);
	assert.deepEqual(codes(pres(tiles, { overview: null }), [{ title: 't', pane: 'overview', kpi_value: 1 }]), [], 'a pane naming the view the run is on is drawn by that view');
	const stories = Array.from({ length: 30 }, (_, i) => ({ title: `s${i}` }));
	assert.deepEqual(codes(pres(tiles, { overview: null }), stories), ['empty_tile_grid', 'tile_cap']);
	const grid = { kind: 'cards', mode: 'list_data', layout: 'grid', valueField: 'kpi_value' };
	assert.deepEqual(codes(pres(grid, { overview: null }), stories), [], 'a grid layout is not a tiles layout: 30 rows and no numbers are fine');
	const custom = { ...tiles, valueField: 'count' };
	assert.deepEqual(codes(pres(custom, { overview: null }), Array.from({ length: 10 }, (_, i) => ({ title: `r${i}`, count: i }))), [], 'the bound value field is the one tested');
	assert.deepEqual(codes(pres(custom, { overview: null }), Array.from({ length: 10 }, (_, i) => ({ title: `r${i}`, kpi_value: i }))), ['empty_tile_grid']);
	assert.deepEqual(codes(pres(null, { overview: prev }), stories), [], 'a selected_row preview takes any number of rows');
	// the shipped pulse-feed declares a preview for every view that lists stories
	const p = presentationOf(path.join(EX, 'pulse-feed'));
	for (const v of ['overview', 'topic', 'stories']) assert.deepEqual([p.views.get(v).kind, p.views.get(v).mode], ['entity_preview', 'selected_row'], v);
	assert.equal(p.top, null);
});

test('a row action that chains must name the app\'s own id (chain_target_not_self); pulse-feed chains to itself', async () => {
	const { chainProblems } = await import('../lib/check.mjs');
	const chain = (t) => ({ title: 'x', actions: [{ id: 'n', label: 'Narrow', kind: 'utility', target_chip: t, query: 'rust' }] });
	assert.deepEqual(chainProblems([chain('pulse-feed')], 'pulse-feed'), []);
	const bad = chainProblems([chain('pulse')], 'pulse-feed'); assert.equal(bad.length, 1); assert.equal(bad[0].code, 'chain_target_not_self'); assert.match(bad[0].message, /Use target_chip: pulse-feed/);
	for (const g of fs.readdirSync(path.join(EX, 'pulse-feed', 'golden'))) for (const m of fs.readFileSync(path.join(EX, 'pulse-feed', 'golden', g), 'utf8').matchAll(/"target_chip": "([^"]+)"/g)) assert.equal(m[1], 'pulse-feed', g);
	const d = tmp('ns-chain-'), home = tmp('ns-home-');
	assert.equal(cli(home, d, 'new', 'pulse-feed', 'my-pulse', '--dir', d).status, 0);
	const c = cli(home, d, 'check', path.join(d, 'my-pulse')); assert.equal(c.status, 0, c.stdout);
});

test('on_missing_key: a loose key file keeps its setup row, an unknown value is a config error, chart views carry no label row', () => {
	const d = tmp('ns-omk-'), home = tmp('ns-home-');
	assert.equal(cli(home, d, 'new', 'portal-template', 'omkapp', '--dir', d, '--full').status, 0);
	const app = path.join(d, 'omkapp'), cfgp = path.join(app, 'scripts', 'omkapp__config.json'), cfg = JSON.parse(fs.readFileSync(cfgp, 'utf8'));
	const run = (args, env = {}) => spawnPython(['-X', 'utf8', '-I', path.join(app, 'scripts', 'omkapp__engine.py'), ...args], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, ...env } });
	let rows;
	if (process.platform !== 'win32') {
		const envf = path.join(home, 'loose.env'); fs.writeFileSync(envf, `${cfg.api.key_env}=abc\n`, { mode: 0o644 }); fs.chmodSync(envf, 0o644);
		cfg.api.env_file = envf; fs.writeFileSync(cfgp, JSON.stringify(cfg, null, 2) + '\n');
		rows = JSON.parse(run(['overview']).stdout);
		assert.match(rows[0].title, /Tighten the permissions/); assert.ok(!rows.some((r) => /SAMPLE DATA/.test(r.title)));
	}
	delete cfg.api.env_file; cfg.api.on_missing_key = 'maybe'; fs.writeFileSync(cfgp, JSON.stringify(cfg, null, 2) + '\n');
	rows = JSON.parse(run(['overview']).stdout); assert.match(rows[0].title, /not set up correctly/); assert.match(rows[0].subtitle, /on_missing_key must be setup or sample/);
	// a chart or table data view gets no label row (it would be a plotted point); the overview does
	const ct = path.join(EX, 'chart-template'), fx = path.join(ct, 'scripts', 'chart-template__engine.py');
	const rn = (a) => JSON.parse(spawnPython(['-X', 'utf8', '-I', fx, ...a], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, BOLT_APPS_ENGINE_FILE: path.join(REPO, 'kit/python/bolt_app_engine.py') } }).stdout);   // the example is thin: the toolkit hands its entry the engine
	assert.ok(rn(['overview']).some((r) => /sample data: add your/.test(r.kpi_foot || '')));
	const cj = JSON.parse(fs.readFileSync(path.join(ct, 'scripts', 'chart-template__config.json'), 'utf8')), dv = cj.views.find((v) => v.widget && v.widget.kind === 'chart');
	assert.ok(dv, 'chart-template has a chart view'); assert.ok(!rn([dv.id]).some((r) => /SAMPLE DATA/.test(r.title)));
});

test('tile_row_without_value: the old sample behaviour (label rows in a tiles view) fails, the fixed rows pass, a lone state is allowed, a waiver no longer exists', async () => {
	const { paneProblems } = await import('../lib/check.mjs');
	const pres = { top: { kind: 'cards', mode: 'list_data', layout: 'tiles', valueField: 'kpi_value' }, views: new Map([['overview', null]]), viewArg: 'view' };
	const tile = (n) => ({ title: `T${n}`, kpi_label: 'x', kpi_value: n });
	const old = [{ title: 'SAMPLE DATA: add your X API key to see live data', badge: 'SAMPLE' }, { title: 'Add your X API key' }, tile(1), tile(2)];
	const codes = (rows, o) => paneProblems(pres, rows, 'overview', o).map((x) => `${x.level}:${x.code}`);
	assert.deepEqual(codes(old), ['error:tile_row_without_value']);
	assert.deepEqual(codes(old, { waiveEmptyTiles: true }), ['error:tile_row_without_value'], 'the old option does nothing');
	const fixed = [{ ...tile(1), kpi_badge: 'SAMPLE', kpi_foot: 'sample data: add your X API key for live data' }, tile(2)];
	assert.deepEqual(codes(fixed), []);
	assert.deepEqual(codes([{ title: 'Add your X API key' }]), [], 'a lone setup row');
	assert.deepEqual(codes([{ title: 'Could not reach X' }, { title: 'Try again', nav: { view: 'overview', arg: 'refresh' } }]), [], 'a run with no data row at all');
	assert.deepEqual(codes([tile(1), { title: 'Check again', nav: { view: 'overview', arg: 'refresh' } }]), ['error:tile_row_without_value'], 'Bolt draws a tile for a refresh row: it is an empty tile unless it has a number');
	assert.deepEqual(codes([tile(1), { title: 'Check again', nav: { view: 'overview', arg: 'refresh' }, kpi_label: 'Data age', kpi_value: 0, kpi_unit: 's' }]), [], 'a refresh row with a number is a real tile');
	assert.deepEqual(codes([tile(1), { title: 'Back', nav: { back: true } }]), ['error:tile_row_without_value'], 'Bolt draws a tile for a Back row too: a tiles view has no exempt row kind');
	assert.deepEqual(codes([tile(1), { title: 'Back', nav: { back: true }, kpi_label: 'Back', kpi_value: 0 }]), [], 'a Back row with a number is a real tile');
	// the shipped demos: every check case passes with no waiver except the four named in their check.json
	for (const n of examples) { const cj = path.join(EX, n, 'check.json'); if (!fs.existsSync(cj)) continue; const c = JSON.parse(fs.readFileSync(cj, 'utf8')); assert.ok(!('known_empty_tiles' in c), n); }
});

test('tile_row_without_value mutants: no row kind is exempt (refresh and Back rows are tiles in Bolt), and "n/a" or "-" is not a number', async () => {
	const { paneProblems, widgetNumber, sampleVisibleProblems } = await import('../lib/check.mjs');
	const pres = { top: { kind: 'cards', mode: 'list_data', layout: 'tiles', valueField: 'kpi_value' }, views: new Map([['overview', null]]), viewArg: 'view' };
	const tile = (n) => ({ title: `T${n}`, kpi_label: 'x', kpi_value: n });
	const codes = (rows) => paneProblems(pres, rows, 'overview').map((x) => x.code);
	assert.deepEqual(codes([tile(1), { title: 'Refresh', nav: { view: 'overview', arg: 'refresh' } }, { title: 'Again', nav: { view: 'overview', arg: 'refresh.x' } }, { title: 'Back to the overview', nav: { back: true } }]), ['tile_row_without_value'], 'three empty tiles, one finding');
	assert.deepEqual(codes([tile(1), { title: 'Refreshments 12', nav: { view: 'overview', arg: 'refreshments' } }]), ['tile_row_without_value'], 'a word that merely starts with refresh is data');
	assert.deepEqual(codes([tile(1), { title: 'Total', nav: { back: true } }]), ['tile_row_without_value'], 'a data row with back:true is not the Back row');
	assert.deepEqual(codes([tile(1), { title: 'Back', nav: { back: true, view: 'x' } }]), ['tile_row_without_value'], 'the Back row has only nav.back');
	assert.deepEqual(codes([tile(1), { title: 'Open', kpi_label: 'x', kpi_value: 'n/a' }]), ['tile_row_without_value'], 'n/a is not a number');
	assert.deepEqual(codes([tile(1), { title: 'Open', kpi_label: 'x', kpi_value: '-' }]), ['tile_row_without_value']);
	assert.deepEqual([widgetNumber('1,234.5'), widgetNumber('-3%'), widgetNumber('$4'), widgetNumber('1e3'), widgetNumber(7), widgetNumber(true), widgetNumber('12 apples'), widgetNumber(NaN), widgetNumber(2e15)], [1234.5, -3, 4, 1000, 7, null, null, null, null]);
	// a visible label: a list view needs a row that says sample, a tiles grid a badge, footer or note
	const list = { top: null, views: new Map([['overview', { kind: 'entity_preview', mode: 'selected_row' }]]), viewArg: 'view' };
	assert.equal(sampleVisibleProblems(list, [{ title: 'a' }, { title: 'b' }], 'overview')[0].code, 'sample_not_visible');
	assert.deepEqual(sampleVisibleProblems(list, [{ title: 'SAMPLE DATA: add your key' }, { title: 'b' }], 'overview'), []);
	assert.equal(sampleVisibleProblems(pres, [tile(1), tile(2)], 'overview')[0].code, 'sample_not_visible');
	assert.deepEqual(sampleVisibleProblems(pres, [{ ...tile(1), kpi_badge: 'SAMPLE' }, tile(2)], 'overview'), []);
	const chart = { ...pres, top: { kind: 'chart', mode: 'list_data' } };
	assert.equal(sampleVisibleProblems(chart, [tile(1), tile(2)], 'overview')[0].code, 'sample_not_visible', 'a plotted view says it in the first row subtitle');
	assert.deepEqual(sampleVisibleProblems(chart, [{ ...tile(1), subtitle: '3 ms - sample data' }, tile(2)], 'overview'), []);
});

test('no example carries a known_empty_tiles waiver any more (all were redesigned); every demo has a visible-label case per list view', () => {
	const waived = examples.filter((n) => fs.existsSync(path.join(EX, n, 'check.json')) && JSON.parse(fs.readFileSync(path.join(EX, n, 'check.json'), 'utf8')).known_empty_tiles).sort();
	assert.deepEqual(waived, [], 'a waiver is a redesign still pending: none is left');
	const acme = JSON.parse(fs.readFileSync(path.join(EX, 'acme-dash', 'check.json'), 'utf8')).cases.filter((c) => c.fixture === 'unset').map((c) => c.args[0]);
	for (const v of ['tasks', 'policies', 'controls', 'risks', 'vendors', 'devices', 'people']) assert.ok(acme.includes(v), `acme-dash ${v}`);
});

test('a first word that is not a view is drawn by the APP-LEVEL widget: a tiles grid there with value-less rows fails, the entity_preview the examples now use passes', async () => {
	const { paneProblems, presentationOf, blankPaneProblems } = await import('../lib/check.mjs');
	const rows = [{ title: 'Sample verdict', kpi_value: 71, kpi_label: 'Score' }, { title: 'Weather', subtitle: 'x' }, { title: 'Bikes', subtitle: 'y' }, { title: 'Places', subtitle: 'z' }];
	const old = { top: { kind: 'cards', mode: 'list_data', layout: 'tiles', valueField: 'kpi_value' }, views: new Map([['overview', { kind: 'entity_preview', mode: 'selected_row' }], ['places', null]]), viewArg: 'view' };
	assert.deepEqual(paneProblems(old, rows, '94087').map((x) => x.code), ['tile_row_without_value'], 'the old around.yaml: the overview was fixed but the fallback was not');
	assert.deepEqual(paneProblems(old, rows, 'overview').map((x) => x.code), [], 'a declared view word is drawn by that view');
	const fixed = { ...old, top: { kind: 'entity_preview', mode: 'selected_row', fields: ['title'] } };
	assert.deepEqual(paneProblems(fixed, rows, '94087'), []);
	for (const n of ['around', 'repo-radar', 'cli-wrapper-template', 'file-insights-template']) { const p = presentationOf(path.join(EX, n)); assert.equal(p.top.kind, 'entity_preview', n); assert.equal(p.top.mode, 'selected_row', n); }
	// every selectable row must give its pane a field to draw (the old pipeline-board changes: a key-hint row in a diff view)
	const diff = { top: null, views: new Map([['changes', { kind: 'diff', mode: 'selected_row', fields: ['left', 'right'] }]]), viewArg: 'view' };
	assert.equal(blankPaneProblems(diff, [{ title: 'Back', nav: { back: true } }, { title: 'Add your key' }, { title: 'Run 303', left: 'a', right: 'b' }], 'changes')[0].code, 'pane_blank_row');
	assert.equal(blankPaneProblems(diff, [{ title: 'Back', nav: { back: true } }, { title: 'Run 303', left: 'a', right: 'b' }], 'changes')[0].code, 'pane_blank_row', 'a bare Back is the first row selected in a drilled list: it is no longer exempt');
	assert.deepEqual(blankPaneProblems(diff, [{ title: 'Back', nav: { back: true }, left: 'Back', right: 'to the overview' }, { title: 'Run 303', left: 'a', right: 'b' }], 'changes'), []);
	assert.deepEqual(blankPaneProblems(diff, [{ title: 'Not found' }], 'changes'), [], 'a run with no data row at all');
});

test('goldens never say "1 <plural>", the unit-convert pane title is a sentence, and a count filter says 1 point', () => {
	for (const n of examples) { const g = path.join(EX, n, 'golden'); if (!fs.existsSync(g)) continue; for (const f of fs.readdirSync(g)) for (const m of fs.readFileSync(path.join(g, f), 'utf8').matchAll(/"([^"]*)"/g)) assert.ok(!/(?<![\d.,-])\b1 [a-z]{3,}s\b/.test(m[1]), `${n}/${f}: ${m[1].slice(0, 80)}`); }
	const y = fs.readFileSync(path.join(EX, 'unit-convert', 'utilities', 'unit-convert.yaml'), 'utf8');
	assert.match(y, /title: "Conversion"/); assert.match(y, /subtitle: "\{\{row\.title\}\}"/);
});

// The first row of a drilled list is selected on arrival: a Back row that binds none of a detail pane's fields draws a blank title and a dash for every field.
test('a Back or refresh row is not exempt from pane_blank_row: around landmarks with a bare Back fails, with the note pane it passes (mutation of the old exemption)', async () => {
	const { blankPaneProblems, presentationOf } = await import('../lib/check.mjs');
	const pres = presentationOf(path.join(EX, 'around'));
	assert.equal(pres.views.get('landmarks').kind, 'detail');
	assert.equal(pres.views.get('note').kind, 'markdown', 'the note view the Back rows point at is declared');
	const data = { title: 'Bryant Park', subtitle: '1 m north', pname: 'Bryant Park', dist: '1 m', src: 'Wikipedia (CC BY-SA)' };
	const bare = { title: 'Back', subtitle: 'Back to the overview', nav: { back: true } };
	const bad = blankPaneProblems(pres, [bare, data], 'landmarks');
	assert.deepEqual(bad.map((x) => x.code), ['pane_blank_row'], 'the old rule exempted every Back row, which is the bug the founder saw');
	assert.match(bad[0].message, /Back or refresh row is selected first/);
	assert.deepEqual(blankPaneProblems(pres, [{ ...bare, pane: 'note', body: 'x' }, data], 'landmarks'), []);
	assert.equal(blankPaneProblems(pres, [{ ...bare, pane: 'nope' }, data], 'landmarks')[0].code, 'pane_blank_row', 'a pane that is not a declared view does not count');
	assert.equal(blankPaneProblems(pres, [{ title: 'Check again', nav: { view: 'landmarks', arg: 'refresh' } }, data], 'landmarks')[0].code, 'pane_blank_row', 'refresh is not exempt either');
	assert.deepEqual(blankPaneProblems(pres, [bare, { title: 'Not found' }], 'landmarks'), [], 'a run with no data row at all has nothing to draw');
});

test('every example run in sample mode: a Back or Refresh row is selectable only with a pane text or a bound field (no example ships the bare Back)', () => {
	for (const n of examples.filter((x) => fs.existsSync(path.join(EX, x, 'check.json')))) {
		const r = cli(tmp('home-'), REPO, 'check', path.join(EX, n), '--json'); const o = JSON.parse(r.stdout);
		const blank = JSON.stringify(o).match(/pane_blank_row/g);
		assert.equal(blank, null, `${n}: pane_blank_row`);
	}
});

test('a row that names another pane must carry a field THAT view binds: Back naming keys fails, the around keys row without fields fails, the fixed rows pass', async () => {
	const { blankPaneProblems, presentationOf } = await import('../lib/check.mjs');
	const pres = presentationOf(path.join(EX, 'around'));
	const data = { title: 'Bryant Park', subtitle: '1 m north', pname: 'Bryant Park', dist: '1 m', src: 'x' };
	const back = { title: 'Back', subtitle: 'Back to the overview', nav: { back: true } };
	const named = blankPaneProblems(pres, [{ ...back, pane: 'keys' }, data], 'landmarks');
	assert.ok(named.some((x) => x.code === 'pane_blank_row' && /pane "keys"/.test(x.message)), 'Back naming pane keys binds none of the keys fields');
	const keysRow = { title: 'Keys and sign-in styles', subtitle: 'how each API asks', nav: { view: 'keys' }, pane: 'keys' };
	assert.equal(blankPaneProblems(pres, [keysRow, { title: 'Other', subtitle: 'y' }], 'overview')[0].code, 'pane_blank_row', 'the old around overview row drew an all-dash detail pane while check passed');
	assert.deepEqual(blankPaneProblems(pres, [{ ...keysRow, pane: undefined }, { title: 'Other', subtitle: 'y' }], 'overview'), []);
	assert.deepEqual(blankPaneProblems(pres, [{ ...keysRow, pane: 'keys', mode: 'm', state: 's' }], 'overview'), [], 'a row carrying the keys fields is fine');
	assert.deepEqual(blankPaneProblems(pres, [{ ...back, pane: 'note', body: 'x' }, data], 'landmarks'), []);
});

test('the pane_blank_row advice does not tell the author to add a note view they cannot add', async () => {
	const { blankPaneProblems } = await import('../lib/check.mjs');
	const detail = { kind: 'detail', mode: 'selected_row', fields: ['pname', 'dist'] }, md = { kind: 'markdown', mode: 'selected_row', fields: ['title', 'subtitle', 'body'] };
	const back = { title: 'Back', nav: { back: true } }, data = { title: 'a', pname: 'a', dist: '1' };
	const room = { top: null, views: new Map([['places', detail]]), viewArg: 'view' };
	assert.match(blankPaneProblems(room, [back, data], 'places')[0].message, /small markdown view \(named "note"/, 'room: say how to add it');
	assert.doesNotMatch(blankPaneProblems(room, [back, data], 'places')[0].message, /entity_preview/);
	const taken = { ...room, views: new Map([['places', detail], ['note', { kind: 'detail', mode: 'selected_row', fields: ['x'] }]]) };
	assert.match(blankPaneProblems(taken, [back, data], 'places')[0].message, /rename it/, 'an author view named note');
	const full = { ...room, views: new Map([['places', detail], ...Array.from({ length: 7 }, (_, i) => [`v${i}`, { kind: 'chart', mode: 'list_data', fields: [] }])]) };
	assert.match(blankPaneProblems(full, [back, data], 'places')[0].message, /8 views.*drop a view/, '8 views and no reusable markdown view');
	const reuse = { ...full, views: new Map([...[...full.views].slice(0, 7), ['m', md]]) };
	assert.doesNotMatch(blankPaneProblems(reuse, [back, data], 'places')[0].message, /8 views/, 'a markdown view that binds title, subtitle and body is reusable');
});

// Mirror of Bolt's trust.rs scan_scripts: a curl or wget line names a host the app file does not declare.
test('the install-prompt scan says which curl or wget host is not declared, as Bolt does', () => {
	const f = (text) => [{ name: 'a.sh', text }];
	assert.deepEqual(scanMentions(f('curl https://api.example.com/x')), ['curl or wget to api.example.com, which it does not declare (in a.sh)']);
	assert.deepEqual(scanMentions(f('curl https://api.example.com/x'), ['api.example.com']), []);
	assert.deepEqual(scanMentions(f('wget https://v1.API.example.com:8443/x'), ['example.com']), []);
	assert.deepEqual(scanMentions(f('curl https://evilexample.com/x'), ['example.com']), ['curl or wget to evilexample.com, which it does not declare (in a.sh)']);
	assert.deepEqual(scanMentions(f('curl https://$HOST/x https://ok.example.com'), ['ok.example.com']), ['curl or wget with an address not written out here (in a.sh)']);
	assert.deepEqual(scanMentions(f('curl localhost')), ['curl or wget with an address not written out here (in a.sh)']);
	assert.ok(scanMentions(f('curl https://u:p@ok.example.com/x'), ['ok.example.com']).some((m) => /user name or a backslash/.test(m)));
	// Bolt's app data folder rule names its own folder only
	assert.deepEqual(scanMentions(f('ls app.sparcle.bolt/x')), ["Bolt's app data folder (in a.sh)"]);
	assert.deepEqual(scanMentions(f('ls app.other.bolt/x')), []);
});

test('declaredHostsOf reads permissions.network in the app file', () => {
	const y = 'id: h\nname: H\nruntime: bridge\nchip: h\npermissions:\n  network:\n    - host: api.example.com\n    - host: "b.example.org"\n';
	assert.deepEqual(declaredHostsOf(assessYaml(y, 'h').tree), ['api.example.com', 'b.example.org']);
	assert.deepEqual(declaredHostsOf(assessYaml('id: h\nruntime: bridge\n', 'h').tree), []);
});

test('verify lists a curl host the app file does not declare, with Bolt\'s sentence', () => {
	const d = tmp('ns-host-'), home = tmp('ns-home-');
	assert.equal(cli(home, d, 'new', 'script-template', 'hosty', '--dir', d).status, 0);
	const fx = path.join(d, 'hosty', 'scripts', 'hosty__fixtures.json'), j = JSON.parse(fs.readFileSync(fx, 'utf8'));
	j.note = 'curl https://api.undeclared.example.org/x'; fs.writeFileSync(fx, JSON.stringify(j));
	const v = JSON.parse(cli(home, d, 'verify', path.join(d, 'hosty'), '--json').stdout);
	const m = v.findings.filter((f) => f.code === 'script_mentions').map((f) => f.message).join('\n');
	assert.match(m, /curl or wget to api\.undeclared\.example\.org, which it does not declare \(in hosty__fixtures\.json\)/);
});
