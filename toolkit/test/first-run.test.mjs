// Run: node --test toolkit/test/first-run.test.mjs
// First impressions: someone runs `new <template> my-tool`, ships it untouched, drops the pack and types =my-tool. A template whose API address is a
// placeholder (api.example.com) must show labelled SAMPLE data on that first run, never "Could not reach" or another error row. Templates that call a
// real public API stay live, and keyless local templates never show an error row either.
// Each unmodified `new` copy is run WITHOUT --sample, in a scratch HOME with no key; HTTPS_PROXY points at a dead port in case a script honours it.
// (script-template is excluded: it is being rebuilt as a working keyless live app elsewhere.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const CLI = path.resolve(HERE, '../bin/bolt-apps.mjs');
const EX = path.join(REPO, 'kit', 'examples');
const EXCLUDED = new Set(['script-template']);
const templates = fs.readdirSync(EX, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(EX, e.name, 'bolt-app.json'))).map((e) => e.name).filter((n) => !EXCLUDED.has(n));
const PLACEHOLDER = /(^|\.)example\.(com|org|net)$|\.invalid$/;
const ERRORISH = /could not reach|could not connect|not set up correctly|could not run|try again|offline|not available on this system/i;
const run = (home, ...a) => spawnSync(process.execPath, [CLI, ...a], { encoding: 'utf8', timeout: 120000, env: { ...process.env, HOME: home, USERPROFILE: home, HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', http_proxy: 'http://127.0.0.1:9' } });
const say = (r) => /sample/i.test([r.title, r.subtitle, r.kpi_badge, r.kpi_foot, r.kpi_note, r.body].join(' '));

test('every template: an unmodified `new` copy never opens on an error row; placeholder-API templates open on labelled sample data', () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'first-run-home-')), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'first-run-apps-'));
	const sampleFirst = [], liveByDesign = [], local = [];
	for (const t of templates) {
		const id = `my-${t}`.slice(0, 40), made = run(home, 'new', t, id, '--dir', dir);
		assert.equal(made.status, 0, `${t}: new failed\n${made.stdout}${made.stderr}`);
		const appDir = path.join(dir, id), cfgPath = path.join(appDir, 'scripts', `${id}__config.json`);
		if (!fs.existsSync(path.join(appDir, 'scripts'))) { local.push(t); continue; }   // a yaml-only template (local-service-template) has no script to run
		const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {}, api = cfg.api || {};
		let host = ''; try { host = new URL(api.base_url).hostname; } catch { /* no base_url */ }
		const placeholder = PLACEHOLDER.test(host);
		if (placeholder) {
			const r = run(home, 'run', appDir, '--json');
			assert.equal(r.status, 0, `${t}: run failed\n${r.stdout}${r.stderr}`);
			const rows = JSON.parse(r.stdout);
			assert.ok(rows.length > 0, `${t}: no rows`);
			for (const x of rows) assert.ok(!ERRORISH.test(`${x.title} ${x.kpi_badge || ''}`), `${t}: the first run shows an error row: "${x.title}" (${x.subtitle})`);
			assert.ok(rows.some(say), `${t}: nothing on the first run says it is sample data. Rows: ${rows.slice(0, 4).map((x) => x.title).join(' | ')}`);
			assert.ok(api.fixture_default === true || api.on_missing_key === 'sample', `${t}: a placeholder address needs on_missing_key sample (or fixture_default true)`);
			assert.match(made.stdout, /connect your API/, `${t}: new's Next steps say how to connect the real API`);
			sampleFirst.push(t);
		} else if (api.base_url || (cfg.hosts || api.hosts || []).length) {   // a real public API (a base_url, or a host list for a script that joins several)
			assert.ok(!PLACEHOLDER.test(host), `${t}: live by design means a real host`);
			assert.doesNotMatch(made.stdout, /placeholder/, `${t}: a template on a real API does not tell you to replace the address`);
			liveByDesign.push(t);
		} else {   // no network at all: a form, a probe, a typed converter, a file reader, a command wrapper
			const r = run(home, 'run', appDir, '--json');
			if (r.status === 0) for (const x of JSON.parse(r.stdout)) assert.ok(!ERRORISH.test(x.title), `${t}: the first run shows an error row: "${x.title}"`);
			local.push(t);
		}
	}
	assert.ok(sampleFirst.length >= 9, `placeholder-API templates found: ${sampleFirst.join(', ')}`);
	for (const t of ['portal-template', 'table-template', 'chart-template', 'widget-gallery', 'widget-gallery-2', 'acme-dash']) assert.ok(sampleFirst.includes(t), `${t} is a placeholder-API template`);
	assert.ok(liveByDesign.includes('lookup-template') && liveByDesign.includes('around') && liveByDesign.includes('repo-radar'), `real-API templates stay live: ${liveByDesign.join(', ')}`);
});
