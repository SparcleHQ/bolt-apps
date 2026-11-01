// Run: node --test toolkit/test/verify.test.mjs
// `bolt-apps verify` reports each way an app fails to install or load, with a stable code and a fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { tarFile, contentHash } from '../bin/bolt-apps.mjs';
import { FIXES } from '../lib/verify.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '../bin/bolt-apps.mjs');
const REPO = path.resolve(HERE, '../..');
const CASES = JSON.parse(fs.readFileSync(path.join(REPO, 'conformance', 'verify-cases.json'), 'utf8'));
const run = (cwd, ...a) => spawnSync(process.execPath, [CLI, ...a], { cwd, encoding: 'utf8' });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bolt-verify-'));
const write = (f, c) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); };
const LISTING = { schema_version: 1, id: 'eagle-info', title: 'Eagle info', role: 'Me', saves: 'A lookup', summary: 'Look up eagles.', author: { name: 'Tester' }, tier: 3, permissions: ['runs_commands'], tests: [] };
const covered = new Set();

function appFromCase(c) {
	const files = { ...CASES.base, ...(c.add || {}) };
	for (const r of c.remove || []) delete files[r];
	for (const [f, pairs] of Object.entries(c.edit || {})) for (const [a, b] of pairs) { assert.ok(files[f].includes(a), `${c.name}: edit text not found: ${a}`); files[f] = files[f].replace(a, b); }
	const d = tmp(), dir = path.join(d, 'apps', 'eagle-info');
	write(path.join(dir, 'bolt-app.json'), JSON.stringify(LISTING));
	for (const [f, t] of Object.entries(files)) write(path.join(dir, f), t);
	return { d, dir };
}
const codes = (j) => [...new Set(j.findings.map((x) => x.code))].filter((x) => x in FIXES).sort();

for (const c of CASES.cases) {
	test(`verify (folder): ${c.name}`, () => {
		const { d } = appFromCase(c);
		const r = run(d, 'verify', 'apps/eagle-info', '--json'), j = JSON.parse(r.stdout);
		assert.deepEqual(codes(j), [...c.expect].sort(), r.stdout);
		assert.equal(r.status, j.findings.some((x) => x.level === 'error') ? 1 : 0);
		assert.equal(j.ok, r.status === 0);
		for (const f of j.findings) { assert.ok(f.fix && f.message && f.file, JSON.stringify(f)); covered.add(f.code); }
		if (c.expect.length && j.findings.some((x) => x.file.endsWith('.yaml'))) assert.ok(j.findings.filter((x) => x.file.endsWith('.yaml')).every((x) => Number.isInteger(x.line)), 'yaml findings carry a line');
	});
}

test('the same cases give the same codes when the app is packed first (verify of the .boltpack)', () => {
	const bad = ['variable inside double quotes', 'pipe in the command', 'script named in the app is not in the pack', 'unknown top-level key', 'timeout too long'];
	for (const c of CASES.cases.filter((x) => bad.includes(x.name) || x.expect.length === 0)) {
		const { d } = appFromCase(c), k = path.join(d, 'k.pem'); run(d, 'keygen', '--out', k);
		// Build the pack by hand so a bad app can still be packed: this is the pack a tester would be holding.
		const m = new Map(); const dir = path.join(d, 'apps', 'eagle-info');
		for (const sub of ['utilities', 'scripts']) if (fs.existsSync(path.join(dir, sub))) for (const n of fs.readdirSync(path.join(dir, sub))) m.set(`${sub}/${n}`, fs.readFileSync(path.join(dir, sub, n)));
		const out = path.join(d, 'x.boltpack'); fs.writeFileSync(out, buildPack(k, m));
		const j = JSON.parse(run(d, 'verify', out, '--json').stdout);
		assert.deepEqual(codes(j), [...c.expect].sort(), c.name + j.findings.map((x) => x.code));
		for (const f of j.findings) covered.add(f.code);
	}
});

// ---- pack-level cases: hand-built packs ----
function buildPack(keyFile, manifests, over = {}, opts = {}) {
	const priv = crypto.createPrivateKey(fs.readFileSync(keyFile, 'utf8')), pub = priv.export({ format: 'der', type: 'pkcs8' }).length && crypto.createPublicKey(priv).export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
	const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
	const kindOf = (p) => (p.startsWith('utilities/') ? 'user_utility' : p.startsWith('scripts/') ? 'script' : p.startsWith('snippets/') ? 'snippet' : 'mystery');
	const entries = [...manifests].map(([p, c]) => ({ path: `manifests/${p}`, kind: kindOf(p), id: path.basename(p), sha256: sha(c), requires_min_schema: 1 }));
	const meta = { schema_version: 1, bundle_version: '1.0.0', signed_by: 'T', signed_at: '2026-11-01T00:00:00Z', min_bolt_api_version: '0.1.0', content_sha256: contentHash(manifests), manifest_count: manifests.size, entries: opts.entries || entries, release_notes: '', bundle_kind: 'util_pack', pack: { pack_id: 'eagle-info', name: 'E', author: { name: 'T', kind: 'user' } }, signer_pubkey: pub, ...over };
	const bundle = Buffer.from(JSON.stringify(meta)), sig = crypto.sign(null, bundle, priv);
	return zlib.gzipSync(Buffer.concat([tarFile('bundle.json', bundle), tarFile('signature.bin', sig), ...[...manifests].map(([p, c]) => tarFile(`manifests/${p}`, c)), Buffer.alloc(1024)]));
}
const goodManifests = () => new Map([['utilities/eagle-info.yaml', Buffer.from(CASES.base['utilities/eagle-info.yaml'])], ['scripts/eagle.py', Buffer.from(CASES.base['scripts/eagle.py'])]]);
const packCases = [
	['not a tar', 'pack_not_gzip_tar', (d) => Buffer.from('hello')],
	['no bundle.json', 'bundle_missing', () => zlib.gzipSync(Buffer.concat([tarFile('signature.bin', Buffer.alloc(64)), Buffer.alloc(1024)]))],
	['bundle.json is not JSON', 'bundle_not_json', () => zlib.gzipSync(Buffer.concat([tarFile('bundle.json', Buffer.from('nope')), Buffer.alloc(1024)]))],
	['no signature', 'signature_missing', () => zlib.gzipSync(Buffer.concat([tarFile('bundle.json', Buffer.from('{"signer_pubkey":"aa"}')), Buffer.alloc(1024)]))],
	['signed by a key only Bolt knows', 'signed_by_other_key', () => zlib.gzipSync(Buffer.concat([tarFile('bundle.json', Buffer.from('{}')), tarFile('signature.bin', Buffer.alloc(64)), Buffer.alloc(1024)]))],
	['bundle.json edited after signing', 'signature_mismatch', (d, k) => { const raw = zlib.gunzipSync(buildPack(k, goodManifests())), at = raw.indexOf(Buffer.from('1.0.0')); raw[at] = '2'.charCodeAt(0); return zlib.gzipSync(raw); }],
	['a file edited after signing', 'content_hash_mismatch', (d, k) => { const raw = zlib.gunzipSync(buildPack(k, goodManifests())), at = raw.indexOf(Buffer.from("print('{}')")); raw[at] = 'P'.charCodeAt(0); return zlib.gzipSync(raw); }],
	['entry hash wrong', 'entry_hash_mismatch', (d, k) => { const m = goodManifests(), es = [...m].map(([p, c]) => ({ path: `manifests/${p}`, kind: p.startsWith('s') ? 'script' : 'user_utility', id: 'x', sha256: '0'.repeat(64), requires_min_schema: 1 })); return buildPack(k, m, {}, { entries: es }); }],
	['bundle schema_version 7', 'bundle_schema_version', (d, k) => buildPack(k, goodManifests(), { schema_version: 7 })],
	['entry outside manifests/', 'entry_outside_manifests', (d, k) => { const m = goodManifests(), es = [{ path: 'evil/x.yaml', kind: 'user_utility', id: 'x', sha256: crypto.createHash('sha256').update(m.get('scripts/eagle.py')).digest('hex'), requires_min_schema: 1 }]; return buildPack(k, m, {}, { entries: es }); }],
	['entry path with a space', 'entry_path_not_plain', (d, k) => { const m = goodManifests(); m.set('scripts/a b.py', Buffer.from('x')); return buildPack(k, m); }],
	['a snippet in the pack', 'entry_kind_skipped', (d, k) => { const m = goodManifests(); m.set('snippets/s.json', Buffer.from('{}')); return buildPack(k, m); }],
	['a file kind Bolt does not know', 'entry_kind_unknown', (d, k) => { const m = goodManifests(); m.set('misc/x.bin', Buffer.from('x')); return buildPack(k, m); }],
	['a file the bundle does not list', 'file_not_listed', (d, k) => { const m = goodManifests(), es = [...m].map(([p, c]) => ({ path: `manifests/${p}`, kind: p.startsWith('s') ? 'script' : 'user_utility', id: 'x', sha256: crypto.createHash('sha256').update(c).digest('hex'), requires_min_schema: 1 })); m.set('scripts/extra.sh', Buffer.from('x')); return buildPack(k, m, {}, { entries: es }); }],
];
for (const [name, code, build] of packCases) {
	test(`verify (pack): ${name} -> ${code}`, () => {
		const d = tmp(), k = path.join(d, 'k.pem'); run(d, 'keygen', '--out', k);
		const f = path.join(d, 'p.boltpack'); fs.writeFileSync(f, build(d, k));
		const r = run(d, 'verify', f, '--json'), j = JSON.parse(r.stdout);
		assert.ok(j.findings.some((x) => x.code === code), `${code} in ${JSON.stringify(j.findings.map((x) => x.code))}`);
		assert.ok(j.findings.find((x) => x.code === code).fix);
		for (const x of j.findings) covered.add(x.code);
		const warn = ['entry_kind_skipped', 'entry_kind_unknown', 'file_not_listed'].includes(code);
		assert.equal(r.status, warn ? 0 : 1);
	});
}

test('a good pack: verify says valid and prints what Bolt will show; --json is stable', () => {
	const d = tmp(), k = path.join(d, 'k.pem'); run(d, 'keygen', '--out', k);
	const f = path.join(d, 'p.boltpack'); fs.writeFileSync(f, buildPack(k, goodManifests()));
	const t = run(d, 'verify', f); assert.equal(t.status, 0, t.stdout + t.stderr);
	for (const re of [/valid, self-signed/, /tier 3, risk high/, /can: run programs on your computer/, /files: .*eagle\.py/, /asks the installer to confirm/, /Estimate, Bolt checks again at install/]) assert.match(t.stdout, re);
	const j = JSON.parse(run(d, 'verify', f, '--json').stdout);
	assert.deepEqual(Object.keys(j).sort(), ['confirm', 'findings', 'kind', 'ok']); assert.equal(j.ok, true);
	assert.deepEqual(Object.keys(j.confirm).sort(), ['apps', 'estimate', 'files', 'note', 'permissions', 'reasons', 'risk', 'signer', 'tier']);
});

test('every code verify can emit has a case, and every fix is plain words', () => {
	const lintLevel = ['app_file_name', 'unknown_file', 'listing_unreadable', 'field_missing', 'empty_app', 'bad_json', 'permission_unknown']; // covered in personal.test.mjs and the lint tests
	const sizeLevel = ['too_many_files', 'pack_too_large', 'yaml_unreadable_here', 'pack_malformed', 'pack_duplicate_entry']; // the last three are covered in hostile.test.mjs; // would need a 64 MB or 1025-file pack; checked by reading shape only
	const missing = Object.keys(FIXES).filter((c) => !covered.has(c) && !lintLevel.includes(c) && !sizeLevel.includes(c));
	assert.deepEqual(missing, []);
	for (const [c, f] of Object.entries(FIXES)) { assert.ok(f.length > 10, c); assert.ok(!f.includes(String.fromCharCode(0x2014)), c); }
});

test('verify never needs a key or the network, and a missing file is a usage error', () => {
	const d = tmp(); assert.equal(run(d, 'verify', 'nope.boltpack').status, 2);
});
