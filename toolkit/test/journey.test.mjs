// Run: node --test toolkit/test/journey.test.mjs
// The first hour of a person using the toolkit, start to finish, on an empty HOME: new A, ship A, new B, ship B, edit A, ship A twice more, doctor.
// A tiny model of Bolt's installer (ownership by path, newer-version-only, an upgrade removes the old version's files first) runs over every pack made.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPack } from '../bin/bolt-apps.mjs';
import { newer } from '../lib/workflow.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '../bin/bolt-apps.mjs');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// What Bolt does with a pack, as far as script files go (from its installer): a file already owned by ANOTHER pack and different is refused (owned_by_other);
// a pack is only replaced by a newer version; the files of the old version go away, then the new ones are written.
function bolt() {
	const installed = new Map();   // pack id -> { version, files: Map(path -> sha) }
	const low = (x) => x.toLowerCase();
	return {
		installed,
		install(file) {
			const r = readPack(file); assert.ok(r.ok, r.reason);
			const id = r.meta.pack.pack_id, version = r.meta.bundle_version;
			const prev = installed.get(id);
			if (prev && !newer(version, prev.version)) return { ok: false, code: 'same_or_older_version' };
			const mine = new Map(r.meta.entries.filter((e) => e.kind === 'script').map((e) => [e.path.replace(/^manifests\/scripts\//, ''), e.sha256]));
			for (const [other, o] of installed) { if (other === id) continue; for (const [p] of mine) for (const [q] of o.files) { const a = low(p), b = low(q); if (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) return { ok: false, code: 'owned_by_other', file: p }; } }
			installed.set(id, { version, files: mine });
			return { ok: true };
		},
		remove(id) { installed.delete(id); },
	};
}

test('first hour: new A, ship A, new B, ship B, edit A, ship A, ship A again, doctor; everything installs side by side', async () => {
	const home = tmp('journey-home-'), work = tmp('journey-work-');
	const env = { ...process.env, HOME: home, USERPROFILE: home };
	const cli = (...a) => spawnSync(process.execPath, [CLI, ...a], { cwd: work, encoding: 'utf8', env });
	const shipped = (r) => { assert.equal(r.status, 0, r.stdout + r.stderr); const m = /Shipped (\S+) (\S+): (\S+\.boltpack)/.exec(r.stdout); assert.ok(m, r.stdout); return { id: m[1], version: m[2], file: m[3] }; };
	const b = bolt();
	assert.equal(cli('new', 'script-template', 'hour-a', '--dir', work).status, 0);
	const a1 = shipped(cli('ship', path.join(work, 'hour-a')));
	assert.deepEqual(b.install(a1.file), { ok: true });
	assert.equal(cli('new', 'pulse-feed', 'hour-b', '--dir', work).status, 0);
	const b1 = shipped(cli('ship', path.join(work, 'hour-b')));
	assert.deepEqual(b.install(b1.file), { ok: true }, 'the second app must install beside the first');
	// edit A: change its sample data and add a new script file; ship again
	const cfg = path.join(work, 'hour-a', 'scripts', 'hour-a__config.json'), j = JSON.parse(fs.readFileSync(cfg, 'utf8')); j.app.description = 'I changed this'; fs.writeFileSync(cfg, JSON.stringify(j, null, 2) + '\n');
	await new Promise((r) => setTimeout(r, 1100));
	const a2 = shipped(cli('ship', path.join(work, 'hour-a')));
	assert.ok(newer(a2.version, a1.version), `${a2.version} must be higher than ${a1.version}`);
	assert.deepEqual(b.install(a2.file), { ok: true }, 'the upgrade replaces the old version');
	// the same pack again is refused by Bolt: ship must never hand out a same or older version
	assert.equal(b.install(a2.file).code, 'same_or_older_version');
	await new Promise((r) => setTimeout(r, 1100));
	const a3 = shipped(cli('ship', path.join(work, 'hour-a')));
	assert.ok(newer(a3.version, a2.version)); assert.deepEqual(b.install(a3.file), { ok: true });
	// the whole set side by side, and old versions of A never collide with B
	const files = (f) => readPack(f).meta.entries.filter((e) => e.kind === 'script').map((e) => e.path.replace(/^manifests\/scripts\//, '').toLowerCase());
	for (const old of [a1.file, a2.file, a3.file]) for (const x of files(old)) for (const y of files(b1.file)) assert.ok(x !== y && !x.startsWith(`${y}/`) && !y.startsWith(`${x}/`), `${x} vs ${y}`);
	assert.ok(files(a1.file).every((f) => f.startsWith('hour-a__')) && files(b1.file).every((f) => f.startsWith('hour-b__')));
	assert.deepEqual([...b.installed.keys()].sort(), ['hour-a', 'hour-b']);
	// removing one leaves the other whole
	b.remove('hour-a'); assert.ok(b.installed.get('hour-b').files.size > 0);
	// doctor is clean for both apps
	for (const id of ['hour-a', 'hour-b']) { const d = cli('doctor', path.join(work, id)); assert.equal(d.status, 0, d.stdout + d.stderr); assert.match(d.stdout, /All good/); }
});
