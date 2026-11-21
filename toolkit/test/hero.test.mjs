// Run: node --test toolkit/test/hero.test.mjs
// entity_preview `hero` (Bolt 182): accepted only on entity_preview, src required, caps from the rules file, a src that is neither a {{row.*}} reference nor
// a data: URI warns, more than 16 references is an error, and an app that uses it without min_bolt_version 0.1.182 fails with a message that a 181 refuses the pack.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessYaml } from '../lib/assess.mjs';
import { RULES } from '../lib/boltrules.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const CLI = path.resolve(HERE, '../bin/bolt-apps.mjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bolt-hero-'));
const cp = (from, to) => fs.cpSync(from, to, { recursive: true });
const run = (cwd, ...a) => spawnSync(process.execPath, [CLI, ...a], { cwd, encoding: 'utf8', env: { ...process.env, HOME: cwd, USERPROFILE: cwd } });

const app = (kind, heroLines, schemaVersion = 1) => ['schema_version: ' + schemaVersion, 'runtime: bridge', 'id: demo', 'chip: demo', 'title: "Demo"', 'icon: globe', 'description: "Demo"', 'emits: Generic',
	'bridge:', '  command:', '    macos: "python3 {{scripts_dir}}/demo__run.py"', '    linux: "python3 {{scripts_dir}}/demo__run.py"', '    windows: "python {{scripts_dir}}/demo__run.py"', '  parse: json', '  timeout_seconds: 20',
	'presentation:', '  widget: list', '  title_field: title', '  right_widget:', `    kind: ${kind}`, '    mode: selected_row', '    bind:', '      title: "{{row.title}}"', ...heroLines.map((l) => '      ' + l)].join('\n') + '\n';
const hero = (...l) => ['hero:', ...l.map((x) => '  ' + x)];
const P = (y, opts) => assessYaml(y, 'demo', { minBoltKnown: true, minBolt: '0.1.182', ...opts }).problems;
const codes = (y, opts) => P(y, opts).map((p) => p.code).sort();

test('rules: hero is a map under entity_preview with the caps, and a gate of 182', () => {
	const h = RULES.right_widget.bind.entity_preview.hero;
	assert.equal(h.t, 'map'); assert.equal(h.since, '0.1.182');
	assert.deepEqual(Object.keys(h.keys), ['src', 'alt', 'caption', 'credit']);
	assert.deepEqual([h.keys.src.max, h.keys.src.max_refs, h.keys.src.required], [4096, 16, true]);
	for (const k of ['alt', 'caption', 'credit']) assert.equal(h.keys[k].max, 200);
	for (const [k, v] of Object.entries(RULES.right_widget.bind)) if (k !== 'entity_preview') assert.ok(!('hero' in v), `${k} must not take hero`);
});

test('a well-formed hero on entity_preview with min_bolt_version 0.1.182 has no problems', () => {
	assert.deepEqual(codes(app('entity_preview', hero('src: "{{row.img1}}{{row.img2}}"', 'alt: "{{row.hero_alt}}"', 'caption: "x"', 'credit: "y"'))), []);
	assert.deepEqual(codes(app('entity_preview', hero('src: "data:image/png;base64,AAAA"'))), []);
	assert.deepEqual(codes(app('entity_preview', hero('src: "{{row.img1}}"'), 2), { pack: true }), []);
});

test('hero is accepted only on entity_preview', () => {
	for (const kind of ['card', 'markdown', 'cards', 'detail', 'table']) {
		const bad = P(app(kind, hero('src: "{{row.img1}}"')), { pack: true }).filter((p) => /hero/.test(p.message));
		assert.ok(bad.length, `${kind}: hero should be refused`);
		assert.ok(bad.every((p) => p.level === 'error'), kind);
	}
});

test('src is required, and the caps hold', () => {
	assert.ok(P(app('entity_preview', hero('alt: "a"')), { pack: true }).some((p) => /hero\.src: is required/.test(p.message) && p.level === 'error'));
	assert.ok(P(app('entity_preview', hero('src: "{{row.a}}"', 'caption: "' + 'x'.repeat(201) + '"')), { pack: true }).some((p) => /hero\.caption: is longer than 200/.test(p.message)));
	assert.ok(P(app('entity_preview', hero('src: "{{row.a}}"', 'credit: "' + 'x'.repeat(201) + '"')), { pack: true }).some((p) => /hero\.credit/.test(p.message)));
	assert.ok(P(app('entity_preview', hero('src: "{{row.a}}"', 'alt: "' + 'x'.repeat(201) + '"')), { pack: true }).some((p) => /hero\.alt/.test(p.message)));
	assert.ok(P(app('entity_preview', hero('src: "{{row.a}}' + 'x'.repeat(4100) + '"')), { pack: true }).some((p) => /hero\.src: is longer than 4096/.test(p.message)));
	assert.ok(P(app('entity_preview', hero('src: "{{row.a}}"', 'extra: "x"')), { pack: true }).some((p) => /hero\.extra: not a key/.test(p.message)));
});

test('a src that is neither a {{row.*}} reference nor a data: URI warns (a web address is blocked)', () => {
	const w = P(app('entity_preview', hero('src: "https://example.com/a.png"')));
	assert.deepEqual(w.map((p) => [p.code, p.level]), [['hero_src_not_picture', 'warning']]);
	assert.match(w[0].message, /never loads a web address/);
	assert.deepEqual(codes(app('entity_preview', hero('src: "{{row.img1}}"'))), []);
});

test('more than 16 references is an error; exactly 16 passes', () => {
	const refs = (n) => Array.from({ length: n }, (_, i) => `{{row.img${i + 1}}}`).join('');
	assert.deepEqual(codes(app('entity_preview', hero(`src: "${refs(16)}"`))), []);
	for (const opts of [{}, { pack: true }]) {   // lint (schema 1, no pack) and pack both give this code, not right_widget_bind_unread
		const all = P(app('entity_preview', hero(`src: "${refs(17)}"`)), opts);
		assert.deepEqual(all.map((p) => p.code), ['bind_too_many_refs']);
		assert.equal(all[0].level, 'error'); assert.match(all[0].message, /17 \{\{ \}\} references, at most 16/); assert.match(all[0].message, /smaller one/);
	}
	// references are counted the way the pane does: one per {{ ... }}, so a stray "{{" with no close is not a reference
	assert.deepEqual(codes(app('entity_preview', hero(`src: "${refs(16)}{{"`))), []);
});

test('the version gate: undeclared or below 182 is an error that says a 181 refuses the whole pack', () => {
	const y = app('entity_preview', hero('src: "{{row.img1}}"'));
	for (const minBolt of [undefined, '0.1.181', '0.1.0']) {
		const g = P(y, { minBolt }).filter((p) => p.code === 'bind_needs_newer_bolt');
		assert.equal(g.length, 1, String(minBolt)); assert.equal(g[0].level, 'error');
		assert.match(g[0].message, /needs Bolt 182/); assert.match(g[0].message, /0\.1\.181 REFUSES THE WHOLE PACK/);
	}
	for (const minBolt of ['0.1.182', '0.1.183', '0.2.0', '1.0.0']) assert.deepEqual(codes(y, { minBolt }), [], minBolt);
	assert.equal(P(y, { minBolt: 'junk' }).filter((p) => p.code === 'bind_needs_newer_bolt').length, 1);
});

test('the gate is not softened by schema_version 1 or a plain lint; a pack with no listing (verify) only warns', () => {
	const y = app('entity_preview', hero('src: "{{row.img1}}"'), 1);
	assert.equal(P(y, { minBolt: undefined, pack: false })[0].level, 'error');
	assert.equal(P(y, { minBolt: undefined, minBoltKnown: false, pack: true })[0].level, 'warning');
});

test('other bind keys are not gated', () => {
	assert.deepEqual(codes(app('entity_preview', ['subtitle: "{{row.subtitle}}"', 'body: "{{row.body}}"']), { minBolt: undefined }), []);
});

// ---- the CLI: lint --personal, check, pack and verify on a copy of the example ----
const copyExample = (mut) => {
	const d = tmp(), dir = path.join(d, 'hero-gallery'); cp(path.join(REPO, 'kit/examples/hero-gallery'), dir);
	if (mut) mut(dir); return { d, dir };
};
const setMin = (v) => (dir) => { const f = path.join(dir, 'bolt-app.json'), j = JSON.parse(fs.readFileSync(f, 'utf8')); if (v === undefined) delete j.min_bolt_version; else j.min_bolt_version = v; fs.writeFileSync(f, JSON.stringify(j, null, 2)); };

test('check, lint --personal and pack FAIL when the example drops min_bolt_version, naming Bolt 182', () => {
	for (const v of [undefined, '0.1.181']) {
		const { d, dir } = copyExample(setMin(v));
		const lint = run(d, 'lint', dir, '--personal');
		assert.notEqual(lint.status, 0, 'lint ' + v); assert.match(lint.stdout + lint.stderr, /needs Bolt 182/);
		const chk = run(d, 'check', dir);
		assert.notEqual(chk.status, 0, 'check ' + v); assert.match(chk.stdout + chk.stderr, /needs Bolt 182/); assert.match(chk.stdout + chk.stderr, /REFUSES THE WHOLE PACK/);
		fs.mkdirSync(path.join(d, '.bolt-apps'), { recursive: true });
		const k = run(d, 'keygen'); assert.equal(k.status, 0, k.stderr);
		const pk = run(d, 'pack', dir, '--personal', '--version', '1.0.0', '--out', path.join(d, 'x.boltpack'));
		assert.notEqual(pk.status, 0, 'pack ' + v); assert.match(pk.stdout + pk.stderr, /needs Bolt 182/); assert.ok(!fs.existsSync(path.join(d, 'x.boltpack')));
	}
});

test('check and lint pass for the example as shipped, and a bad min_bolt_version is refused', () => {
	const { d, dir } = copyExample();
	assert.equal(run(d, 'lint', dir, '--personal').status, 0);
	const c = run(d, 'check', dir); assert.equal(c.status, 0, c.stdout + c.stderr);
	const b = copyExample(setMin('182'));
	const r = run(b.d, 'lint', b.dir, '--personal'); assert.notEqual(r.status, 0); assert.match(r.stdout + r.stderr, /min_bolt_version must be a dotted version/);
});

test('a data:image src is checked without regard to case and for every mime the pane takes', () => {
	for (const m of ['PNG', 'png', 'jpeg', 'jpg', 'gif', 'webp', 'avif', 'bmp']) assert.deepEqual(codes(app('entity_preview', hero(`src: "DATA:IMAGE/${m};base64,AAAA"`))), [], m);
	assert.deepEqual(codes(app('entity_preview', hero('src: "data:text/html;base64,AAAA"'))), ['hero_src_not_picture']);
});

test('verify of a pack with a listing at 0.1.182 or newer has no needs-Bolt-182 warning; with less or nothing it warns, never errors', () => {
	const y = app('entity_preview', hero('src: "{{row.img1}}"'));
	for (const minBolt of ['0.1.182', '0.1.190']) assert.deepEqual(codes(y, { minBolt, minBoltKnown: false }), [], minBolt);
	for (const minBolt of [undefined, '0.1.181']) {
		const g = P(y, { minBolt, minBoltKnown: false });
		assert.deepEqual(g.map((p) => [p.code, p.level]), [['bind_needs_newer_bolt', 'warning']], String(minBolt));
		assert.match(g[0].message, /pack's listing/);
	}
});

test('verify of a built pack reads min_bolt_version from the signed listing: no needs-Bolt-182 warning, and the pack still passes', () => {
	const { d, dir } = copyExample();
	assert.equal(run(d, 'keygen').status, 0);
	const out = path.join(d, 'h.boltpack');
	const pk = run(d, 'pack', dir, '--personal', '--version', '1.0.0', '--out', out); assert.equal(pk.status, 0, pk.stdout + pk.stderr);
	const v = run(d, 'verify', out); assert.equal(v.status, 0, v.stdout + v.stderr);
	assert.doesNotMatch(v.stdout, /bind_needs_newer_bolt/);
});
