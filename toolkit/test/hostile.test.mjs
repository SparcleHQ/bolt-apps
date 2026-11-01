// Run: node --test toolkit/test/hostile.test.mjs
// A pack is untrusted input. verify must not let it forge output, must not under-report what it can do, and must not exhaust memory.
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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '../bin/bolt-apps.mjs');
const CASES = JSON.parse(fs.readFileSync(path.resolve(HERE, '../../conformance/verify-cases.json'), 'utf8'));
const run = (cwd, ...a) => spawnSync(process.execPath, [CLI, ...a], { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bolt-hostile-'));
const BASE = CASES.base['utilities/eagle-info.yaml'];
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
function signed(d, manifests, over = {}, entriesOver) {
	const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
	const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
	const entries = entriesOver || [...manifests].map(([p, c]) => ({ path: `manifests/${p}`, kind: p.startsWith('utilities/') ? 'user_utility' : 'script', id: path.basename(p), sha256: sha(c), requires_min_schema: 1 }));
	const meta = { schema_version: 1, bundle_version: '1.0.0', signed_by: 'T', signed_at: '2026-11-01T00:00:00Z', min_bolt_api_version: '0.1.0', content_sha256: contentHash(manifests), manifest_count: manifests.size, entries, release_notes: '', bundle_kind: 'util_pack', pack: { pack_id: 'x', name: 'X', author: { name: 'T', kind: 'user' } }, signer_pubkey: pub, ...over };
	const bundle = Buffer.from(JSON.stringify(meta)), sig = crypto.sign(null, bundle, privateKey);
	const f = path.join(d, 'p.boltpack');
	fs.writeFileSync(f, zlib.gzipSync(Buffer.concat([tarFile('bundle.json', bundle), tarFile('signature.bin', sig), ...[...manifests].map(([p, c]) => tarFile(`manifests/${p}`, c)), Buffer.alloc(1024)])));
	return f;
}
const withYaml = (y) => new Map([['utilities/eagle-info.yaml', Buffer.from(y)], ['scripts/eagle.py', Buffer.from('#!/usr/bin/env python3\n')]]);

test('(1) a bad signer_pubkey is refused with a signature code', () => {
	const d = tmp(); const f = signed(d, withYaml(BASE), { signer_pubkey: 'zz' });
	const j = JSON.parse(run(d, 'verify', f, '--json').stdout);
	assert.equal(j.ok, false); assert.ok(j.findings.some((x) => x.code === 'signature_mismatch'));
});

test('(1) control characters from a pack never reach the terminal in text mode; --json stays structured', () => {
	const d = tmp(), ESC = String.fromCharCode(27);
	const y = BASE.replace('presentation:', `actions:\n  - { id: o, kind: url, label: Open, url_template: "https://evil${ESC}[2Jhost.example/{{q}}" }\npresentation:`);
	const m = withYaml(y); m.set(`scripts/a${ESC}[31mb.py`, Buffer.from('x\n'));
	const f = signed(d, m);
	const t = run(d, 'verify', f); const all = t.stdout + t.stderr;
	assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f‪-‮]/.test(all), JSON.stringify(all));
	assert.match(all, /\\u001b|\\x1b/i);
	const j = JSON.parse(run(d, 'verify', f, '--json').stdout); assert.ok(Array.isArray(j.findings));
});

const UNREADABLE = {
	anchor: BASE.replace('timeout_seconds: 20', 'timeout_seconds: &t 20'),
	alias: BASE.replace('title_field: title', 'title_field: *t'),
	tag: BASE.replace('emits: Generic', 'emits: !!str Generic'),
	'block scalar in a command': BASE.replace('    macos: "python3 {{scripts_dir}}/eagle.py {{view}}"', '    macos: |\n      python3 {{scripts_dir}}/eagle.py {{view}}'),
	'quoted key': BASE.replace('\nruntime: bridge', '\n"runtime": bridge'),
	'escape sequence': BASE.replace('title: "Eagle info"', 'title: "Eagle \\u0041 info"'),
	'flow-style document': '{ schema_version: 1, runtime: bridge, id: eagle-info, chip: eagle, title: T, emits: Generic, bridge: { command: { macos: "python3 {{scripts_dir}}/eagle.py" }, parse: json }, presentation: { widget: list }, detect: { binary: git } }\n',
	'duplicate key': BASE + 'runtime: transform\n',
	'merge key': BASE + '<<: *x\n',
	'second document': BASE + '---\nruntime: bridge\n',
};
for (const [name, y] of Object.entries(UNREADABLE)) {
	test(`(2) fail closed: ${name} -> yaml_unreadable_here, tier unknown, never low`, () => {
		const d = tmp(); const f = signed(d, withYaml(y));
		const r = run(d, 'verify', f, '--json'), j = JSON.parse(r.stdout);
		assert.ok(j.findings.some((x) => x.code === 'yaml_unreadable_here' && x.level === 'error'), JSON.stringify(j.findings.map((x) => x.code)));
		assert.equal(r.status, 1); assert.equal(j.confirm.tier, 'unknown'); assert.equal(j.confirm.risk, 'unknown');
		assert.ok(j.findings.find((x) => x.code === 'yaml_unreadable_here').fix);
	});
}

test('(2) flow-style actions: a loose link in the second item still makes it tier 3', () => {
	const y = BASE.replace('runtime: bridge', 'runtime: bridge').replace('presentation:', 'actions: [ { id: a, kind: url, label: A, url_template: "https://ok.example/x" }, { id: b, kind: url, label: B, url_template: "{{link}}" } ]\npresentation:');
	const d = tmp(); const j = JSON.parse(run(d, 'verify', signed(d, withYaml(y)), '--json').stdout);
	assert.ok(j.confirm.permissions.some((p) => p.id === 'opens_any_link'), JSON.stringify(j.confirm.permissions));
});

test('(2) the output is labelled an estimate and never promises what Bolt will show', () => {
	const d = tmp(); const f = signed(d, withYaml(BASE));
	const t = run(d, 'verify', f).stdout;
	assert.doesNotMatch(t, /What Bolt will show/); assert.match(t, /Estimate, Bolt checks again at install/);
	assert.doesNotMatch(t, /\bsafe\b/i);
});

test('(3) a gzip bomb is refused as pack_too_large without being inflated', () => {
	const d = tmp(), f = path.join(d, 'bomb.boltpack');
	const gz = zlib.createGzip({ level: 9 }); const out = fs.createWriteStream(f);
	const chunk = Buffer.alloc(1 << 20);
	return new Promise((res) => { gz.pipe(out); let n = 0; const w = () => { while (n < 300) { n++; if (!gz.write(chunk)) return gz.once('drain', w); } gz.end(); }; w(); out.on('finish', res); }).then(() => {
		const t0 = Date.now(), r = run(d, 'verify', f, '--json'); const j = JSON.parse(r.stdout);
		assert.ok(j.findings.some((x) => x.code === 'pack_too_large'), r.stdout.slice(0, 300)); assert.ok(Date.now() - t0 < 10000);
	});
});

const tarBytes = (parts) => zlib.gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
test('(3) too many tar headers, duplicate names and bad sizes are refused', () => {
	const d = tmp(), f = path.join(d, 'x.boltpack');
	fs.writeFileSync(f, tarBytes(Array.from({ length: 1500 }, (_, i) => tarFile(`manifests/scripts/f${i}.sh`, Buffer.alloc(0)))));
	assert.ok(JSON.parse(run(d, 'verify', f, '--json').stdout).findings.some((x) => x.code === 'too_many_files'));
	fs.writeFileSync(f, tarBytes([tarFile('bundle.json', Buffer.from('{}')), tarFile('bundle.json', Buffer.from('{"a":1}'))]));
	assert.ok(JSON.parse(run(d, 'verify', f, '--json').stdout).findings.some((x) => x.code === 'pack_duplicate_entry'));
	for (const bad of ['-0000000001\0', 'zzzzzzzzzzz\0', '77777777777\0']) {
		const h = tarFile('bundle.json', Buffer.from('{}')); h.write(bad, 124);
		fs.writeFileSync(f, tarBytes([h]));
		assert.ok(JSON.parse(run(d, 'verify', f, '--json').stdout).findings.some((x) => ['pack_malformed', 'pack_too_large'].includes(x.code)), bad);
	}
});

test('(2) a space before the colon cannot hide a detect block or a run action', () => {
	for (const y of [BASE + 'detect : { binary: git }\n', BASE.replace('presentation:', 'actions:\n  - { id: a, kind : run, label: A }\npresentation:')]) {
		const d = tmp(); const j = JSON.parse(run(d, 'verify', signed(d, withYaml(y)), '--json').stdout);
		assert.ok(j.findings.some((x) => x.code === 'yaml_unreadable_here') && j.confirm.tier === 'unknown');
	}
});

test('a script name too long for a pack is a finding before pack, not a crash after', () => {
	const d = tmp(), dir = path.join(d, 'apps', 'eagle-info');
	fs.mkdirSync(path.join(dir, 'utilities'), { recursive: true }); fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
	fs.writeFileSync(path.join(dir, 'bolt-app.json'), JSON.stringify({ schema_version: 1, id: 'eagle-info', title: 'E', role: 'r', saves: 's', author: { name: 'T' }, tier: 3, permissions: [] }));
	fs.writeFileSync(path.join(dir, 'utilities', 'eagle-info.yaml'), BASE); fs.writeFileSync(path.join(dir, 'scripts', 'a'.repeat(95) + '.py'), 'x');
	const j = JSON.parse(run(d, 'verify', 'apps/eagle-info', '--json').stdout);
	assert.ok(j.findings.some((x) => x.code === 'app_file_name' && /at most 100/.test(x.message)));
});

// ---- tar entries are fail-closed ----
const hdr = (name, over = {}) => {
	const h = tarFile('x', Buffer.alloc(0)); h.fill(0, 0, 100); h.write(name, 0);
	if (over.type) h.write(over.type, 156);
	h.write('        ', 148); h.write(h.reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148);
	return h;
};
test('(c) non-canonical, unexpected and non-regular tar entries are refused', () => {
	const d = tmp(), f = path.join(d, 'x.boltpack');
	const cases = { 'dot-dot': 'manifests/../evil.sh', absolute: '/etc/passwd', 'empty segment': 'manifests//a.sh', 'dot segment': 'manifests/./a.sh', backslash: 'manifests\\a.sh', 'unexpected root name': 'evil.txt', 'leading dot-dot': '../bundle.json' };
	for (const [name, n] of Object.entries(cases)) {
		fs.writeFileSync(f, tarBytes([hdr(n)]));
		const j = JSON.parse(run(d, 'verify', f, '--json').stdout);
		assert.ok(j.findings.some((x) => x.code === 'pack_malformed'), `${name}: ${JSON.stringify(j.findings.map((x) => x.code))}`);
	}
	for (const type of ['2', '1', '3', '4', '6', 'x', 'g', 'L']) {
		fs.writeFileSync(f, tarBytes([hdr('manifests/a.sh', { type })]));
		assert.ok(JSON.parse(run(d, 'verify', f, '--json').stdout).findings.some((x) => x.code === 'pack_malformed'), `type ${type}`);
	}
	const bad = hdr('bundle.json'); bad.write('0000001\0', 148);
	fs.writeFileSync(f, tarBytes([bad]));
	assert.ok(JSON.parse(run(d, 'verify', f, '--json').stdout).findings.some((x) => x.code === 'pack_malformed' && /checksum/.test(x.message)));
});
test('(c) a folder entry under manifests/ is accepted and a duplicate stays refused', () => {
	const d = tmp(), f = path.join(d, 'x.boltpack');
	fs.writeFileSync(f, tarBytes([hdr('manifests/scripts/', { type: '5' }), tarFile('manifests/scripts/a.sh', Buffer.from('x')), tarFile('manifests/scripts/a.sh', Buffer.from('y'))]));
	assert.ok(JSON.parse(run(d, 'verify', f, '--json').stdout).findings.some((x) => x.code === 'pack_duplicate_entry'));
});

test('one cause is reported once: a bad runtime and an anchor in a folder', () => {
	const mk = (y) => { const d = tmp(), dir = path.join(d, 'apps', 'eagle-info'); fs.mkdirSync(path.join(dir, 'utilities'), { recursive: true }); fs.mkdirSync(path.join(dir, 'scripts'));
		fs.writeFileSync(path.join(dir, 'bolt-app.json'), JSON.stringify({ schema_version: 1, id: 'eagle-info', title: 'E', role: 'r', saves: 's', author: { name: 'T' }, tier: 3, permissions: [] }));
		fs.writeFileSync(path.join(dir, 'utilities', 'eagle-info.yaml'), y); fs.writeFileSync(path.join(dir, 'scripts', 'eagle.py'), '#!x\n');
		return JSON.parse(run(d, 'verify', 'apps/eagle-info', '--json').stdout); };
	assert.equal(mk(BASE.replace('runtime: bridge', 'runtime: shell')).findings.filter((x) => x.code === 'runtime_not_allowed').length, 1);
	assert.equal(mk(BASE.replace('timeout_seconds: 20', 'timeout_seconds: &t 20')).findings.filter((x) => x.code === 'yaml_unreadable_here').length, 1);
});

test('a signed pack with a malformed bundle.json is a finding, never a stack trace', () => {
	for (const over of [{ entries: 5 }, { entries: [null] }, { entries: [{ path: 3 }] }]) {
		const d = tmp(); const r = run(d, 'verify', signed(d, withYaml(BASE), over), '--json');
		assert.equal(r.status, 1); assert.ok(!r.stderr.includes('TypeError'), r.stderr); assert.ok(JSON.parse(r.stdout).findings.some((x) => x.code === 'bundle_not_json'));
	}
});
test('a Windows command with a backslash after scripts_dir is not a relative script path', () => {
	const y = BASE.replace('    macos:', '    windows: "python {{scripts_dir}}\\\\eagle.py {{view}}"\n    macos:');
	const d = tmp(); const j = JSON.parse(run(d, 'verify', signed(d, withYaml(y)), '--json').stdout);
	assert.ok(!j.findings.some((x) => ['script_path_relative', 'yaml_unreadable_here', 'script_missing'].includes(x.code)), JSON.stringify(j.findings.map((x) => x.code)));
});

test('pack --personal refuses what verify refuses (no pack Bolt would reject is written)', () => {
	for (const [y, code] of [[BASE.replace('eagle.py {{view}}"', 'eagle.py {{view}} | head"'), 'command_shell_operator'], [BASE.replace('timeout_seconds: 20', 'timeout_seconds: 300'), 'timeout_out_of_range'], [BASE + 'bogus: 1\n', 'yaml_key_unknown']]) {
		const d = tmp(), dir = path.join(d, 'apps', 'eagle-info'); fs.mkdirSync(path.join(dir, 'utilities'), { recursive: true }); fs.mkdirSync(path.join(dir, 'scripts'));
		fs.writeFileSync(path.join(dir, 'bolt-app.json'), JSON.stringify({ schema_version: 1, id: 'eagle-info', title: 'E', role: 'r', saves: 's', author: { name: 'T' }, tier: 3, permissions: [] }));
		fs.writeFileSync(path.join(dir, 'utilities', 'eagle-info.yaml'), y); fs.writeFileSync(path.join(dir, 'scripts', 'eagle.py'), '#!x\n');
		run(d, 'keygen', '--out', path.join(d, 'k.pem'));
		const r = run(d, 'pack', 'apps/eagle-info', '--personal', '--key', path.join(d, 'k.pem'));
		assert.equal(r.status, 1); assert.match(r.stderr, new RegExp(code)); assert.ok(!fs.existsSync(path.join(d, 'eagle-info.boltpack')));
	}
});
test('a script name that is only an argument is not a relative script path', () => {
	const y = BASE.replace('eagle.py {{view}}"', 'eagle.py --template page.sh {{view}}"');
	const d = tmp(); const j = JSON.parse(run(d, 'verify', signed(d, withYaml(y)), '--json').stdout);
	assert.ok(!j.findings.some((x) => x.code === 'script_path_relative'));
});

test('a missing id or runtime in a folder is reported once, as yaml_key_missing', () => {
	for (const [re, key] of [[/^id:.*\n/m, 'id'], [/^runtime:.*\n/m, 'runtime']]) {
		const d = tmp(), dir = path.join(d, 'apps', 'eagle-info'); fs.mkdirSync(path.join(dir, 'utilities'), { recursive: true }); fs.mkdirSync(path.join(dir, 'scripts'));
		fs.writeFileSync(path.join(dir, 'bolt-app.json'), JSON.stringify({ schema_version: 1, id: 'eagle-info', title: 'E', role: 'r', saves: 's', author: { name: 'T' }, tier: 3, permissions: [] }));
		fs.writeFileSync(path.join(dir, 'utilities', 'eagle-info.yaml'), BASE.replace(re, '')); fs.writeFileSync(path.join(dir, 'scripts', 'eagle.py'), '#!x\n');
		const j = JSON.parse(run(d, 'verify', 'apps/eagle-info', '--json').stdout);
		const hits = j.findings.filter((x) => (x.code === 'field_missing' || x.code === 'yaml_key_missing') && x.message.includes(key));
		assert.equal(hits.length, 1, JSON.stringify(hits)); assert.equal(hits[0].code, 'yaml_key_missing');
	}
});

test('a Windows-only script app without a #! line is fine; the same on macOS is not', () => {
	const w = BASE.replace('    macos: "python3 {{scripts_dir}}/eagle.py {{view}}"', '    windows: "{{scripts_dir}}\\\\eagle.py {{view}}"');
	const bare = (y) => { const d = tmp(); return JSON.parse(run(d, 'verify', signed(d, new Map([['utilities/eagle-info.yaml', Buffer.from(y)], ['scripts/eagle.py', Buffer.from('print(1)\n')]])), '--json').stdout); };
	assert.ok(!bare(w).findings.some((x) => x.code === 'script_no_shebang'), JSON.stringify(bare(w).findings.map((x) => x.code)));
	assert.ok(bare(BASE.replace('python3 {{scripts_dir}}', '{{scripts_dir}}')).findings.some((x) => x.code === 'script_no_shebang'));
});
