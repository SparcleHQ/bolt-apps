// Run: node --test toolkit/test/dup-guard.test.mjs
// Duplication ratchet. Many example apps carry byte-identical copies of the same helper functions (the engine is copied into
// each app instead of shared). This test measures that and fails when it GROWS; it may fall, never rise. When a change
// removes duplication (the engine moves into the shared kit), lower dup-baseline.json to the new numbers in the same change.
// What counts: a top-level def or class in kit/examples/<app>/scripts/*.py (the shared kit files are skipped) whose exact text
// appears in 4 or more different apps. Near-duplicates are not counted, so the numbers are a floor.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EXAMPLES = path.join(REPO, 'kit/examples');
const MIN_APPS = 4;

/** Split a Python file into its top-level def and class blocks: [{ name, text }]. */
export function topLevelBlocks(src) {
	const starts = [];
	const re = /^(?:def|class) (\w+)/gm;
	for (let m; (m = re.exec(src));) starts.push({ name: m[1], at: m.index });
	return starts.map((s, i) => ({ name: s.name, text: src.slice(s.at, i + 1 < starts.length ? starts[i + 1].at : src.length) }));
}

const lineCount = (t) => t.split('\n').length - 1 || 1;

/** { apps, totalLines, distinctFunctions, redundantLines, worst: [{ name, apps, lines }] } over the example apps. */
export function measure(examplesDir = EXAMPLES) {
	const seen = new Map(); // key -> { name, lines, apps:Set }
	let totalLines = 0;
	const apps = new Set();
	for (const app of fs.readdirSync(examplesDir)) {
		const scripts = path.join(examplesDir, app, 'scripts');
		if (!fs.existsSync(scripts) || !fs.statSync(scripts).isDirectory()) continue;
		for (const f of fs.readdirSync(scripts)) {
			if (!f.endsWith('.py') || f.includes('bolt_app_kit')) continue;
			const src = fs.readFileSync(path.join(scripts, f), 'utf8');
			apps.add(app);
			totalLines += src.split('\n').length - 1;
			for (const b of topLevelBlocks(src)) {
				const key = b.name + ':' + crypto.createHash('sha1').update(b.text).digest('hex');
				const e = seen.get(key) || { name: b.name, lines: lineCount(b.text), apps: new Set() };
				e.apps.add(app);
				seen.set(key, e);
			}
		}
	}
	const dup = [...seen.values()].filter((e) => e.apps.size >= MIN_APPS);
	const redundantLines = dup.reduce((n, e) => n + e.lines * (e.apps.size - 1), 0);
	const worst = dup.map((e) => ({ name: e.name, apps: e.apps.size, lines: e.lines })).sort((a, b) => b.lines * (b.apps - 1) - a.lines * (a.apps - 1)).slice(0, 5);
	return { apps: apps.size, totalLines, distinctFunctions: dup.length, redundantLines, worst };
}

const BASE = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'dup-baseline.json'), 'utf8'));

test('example apps do not carry more copied helper code than the baseline', () => {
	const m = measure();
	const msg = `functions identical in ${MIN_APPS}+ apps: ${m.distinctFunctions} (baseline ${BASE.distinctFunctions}); redundant copied lines: ${m.redundantLines} (baseline ${BASE.redundantLines}); `
		+ `worst: ${m.worst.map((w) => `${w.name} x${w.apps} (${w.lines} lines)`).join(', ')}. `
		+ 'Do not copy a helper into another app: put it once in the shared kit or the shared engine. If your change REMOVED duplication, lower toolkit/test/dup-baseline.json to the numbers above.';
	assert.ok(m.distinctFunctions <= BASE.distinctFunctions, msg);
	assert.ok(m.redundantLines <= BASE.redundantLines, msg);
});

test('the baseline is not stale in the loose direction by more than a rounding margin', () => {
	// A ratchet that is never lowered stops protecting: when duplication falls, the baseline must follow it down.
	const m = measure();
	assert.ok(BASE.redundantLines - m.redundantLines <= BASE.slack, `duplication fell from ${BASE.redundantLines} to ${m.redundantLines} redundant lines: lower toolkit/test/dup-baseline.json so the gain cannot be lost`);
});

test('the measure sees what it is meant to see', () => {
	const sample = 'def a():\n    return 1\n\ndef b():\n    return 2\n';
	assert.deepEqual(topLevelBlocks(sample).map((b) => b.name), ['a', 'b']);
	assert.ok(measure().apps > 0, 'no example apps found: the scan path is wrong');
});
