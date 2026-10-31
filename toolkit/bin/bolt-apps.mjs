#!/usr/bin/env node
// bolt-apps: the Bolt Apps author toolkit. Zero dependencies, Node 18 or newer.
//   new <id> [--type snippet|search|transform|recognizer]   start an app from a working template
//   lint [path]                                             offline shape checks (not the full checker)
//   keygen [--out file]                                     make your signing key
//   pack <app-folder> [--key file] [--out file]             build and self-sign a .boltpack
//   verify <file.boltpack>                                  check a pack's hash and signature
// The pack layout and hash are Bolt's own (bolt-manifest-verify). Bolt checks every pack again at install.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { checkApp, formatReport, reportOk, platformFindings, vendorKit, OSES } from '../lib/check.mjs';

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/, KEY = /^[a-z][a-z0-9_-]{0,23}$/, PREFIX = /^[a-z][a-z0-9]{0,11}$/;
const PERMS = ['reads_clipboard', 'reads_launcher_input', 'copies_to_clipboard', 'runs_commands', 'network', 'files', 'agent_tools'];
const DEFAULT_KEY = path.join(os.homedir(), '.bolt-apps', 'key.pem');
const die = (m, code = 2) => { console.error(`bolt-apps: ${m}`); process.exit(code); };
const rd = (f) => fs.readFileSync(f, 'utf8');
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

// ---------- lint ----------
export function lintApp(dir) {
	const out = [], add = (level, code, message, p) => out.push({ level, code, message, path: p });
	const E = (c, m, p) => add('error', c, m, p), W = (c, m, p) => add('warning', c, m, p);
	const id = path.basename(path.resolve(dir));
	let app;
	try { app = JSON.parse(rd(path.join(dir, 'bolt-app.json'))); } catch (e) { E('listing_unreadable', `bolt-app.json is missing or not JSON: ${e.message}`, 'bolt-app.json'); return { id, out, app: null, files: {} }; }
	if (!isObj(app)) { E('listing_unreadable', 'bolt-app.json must be a JSON object', 'bolt-app.json'); return { id, out, app: null, files: {} }; }
	if (app.schema_version !== 1) E('schema_version', 'schema_version must be 1', 'bolt-app.json');
	if (app.id !== id || !ID.test(String(app.id))) E('id_mismatch', `id must match ${ID} and equal the folder name "${id}"`, 'bolt-app.json');
	for (const k of ['title', 'role', 'saves']) if (typeof app[k] !== 'string' || !app[k].trim()) E('field_missing', `${k} is required`, 'bolt-app.json');
	if (!app.author || typeof app.author.name !== 'string' || !app.author.name.trim()) E('field_missing', 'author.name is required', 'bolt-app.json');
	if (app.author?.link && !String(app.author.link).startsWith('https://')) E('author_link', 'author.link must start with https://', 'bolt-app.json');
	// files
	const files = { snippets: [], search_engines: [], utilities: [] };
	for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
		if (ent.isFile() && (ent.name === 'bolt-app.json' || ent.name === 'README.md')) continue;
		if (ent.isDirectory() && Object.hasOwn(files, ent.name)) {
			for (const f of fs.readdirSync(path.join(dir, ent.name))) {
				const okExt = ent.name === 'utilities' ? /\.ya?ml$/.test(f) : f.endsWith('.json');
				if (okExt) files[ent.name].push(f); else E('unknown_file', 'not an allowed file here', `${ent.name}/${f}`);
			}
		} else E('unknown_file', 'only bolt-app.json, README.md, snippets/, search_engines/ and utilities/ are allowed', ent.name);
	}
	const targets = new Set(), perms = new Set(); let tier = 0;
	const need = (...p) => p.forEach((x) => perms.add(x));
	for (const f of files.snippets) {
		const p = `snippets/${f}`; tier = Math.max(tier, 1);
		let s; try { s = JSON.parse(rd(path.join(dir, p))); } catch (e) { E('bad_json', e.message, p); continue; }
		if (!isObj(s)) { E('bad_json', 'must be a JSON object', p); continue; }
		if (!KEY.test(s.key || '')) E('snippet_key', `key must match ${KEY}`, p);
		if (!s.label) E('field_missing', 'label is required', p);
		if (typeof s.content !== 'string' || !s.content || s.content.length > 10000) E('snippet_content', 'content must be 1 to 10,000 characters', p);
		else if (/\{clipboard[|}]/.test(s.content)) need('reads_clipboard');
		need('copies_to_clipboard'); targets.add(`snippet:${s.key}`);
	}
	for (const f of files.search_engines) {
		const p = `search_engines/${f}`; tier = Math.max(tier, 1);
		let s; try { s = JSON.parse(rd(path.join(dir, p))); } catch (e) { E('bad_json', e.message, p); continue; }
		if (!isObj(s)) { E('bad_json', 'must be a JSON object', p); continue; }
		if (!PREFIX.test(s.id || '')) E('search_prefix', `id (the prefix) must match ${PREFIX}`, p);
		if (!s.name) E('field_missing', 'name is required', p);
		const u = String(s.urlTemplate || '');
		if (!u.startsWith('https://')) E('search_url', 'urlTemplate must start with https://', p);
		else { if (u.split('{q}').length > 2) E('search_url', 'at most one {q}', p); try { need(`opens_links:${new URL(u.replace('{q}', 'x')).hostname}`); } catch { E('search_url', 'urlTemplate is not a URL', p); } }
		targets.add(`search:${s.id}`);
	}
	for (const f of files.utilities) {
		const p = `utilities/${f}`; const y = rd(path.join(dir, p));
		const rt = /^runtime:\s*(\S+)/m.exec(y)?.[1]?.replace(/["']/g, '');
		const yid = /^id:\s*(\S+)/m.exec(y)?.[1]?.replace(/["']/g, '');
		if (rt !== 'transform') { tier = 3; E('tier3_not_accepted', `runtime "${rt}" runs commands or the network; only runtime: transform is allowed here`, p); continue; }
		tier = Math.max(tier, 2); need('reads_launcher_input', 'copies_to_clipboard');
		if (!yid) E('field_missing', 'id is required', p); else targets.add(`transform:${yid}`), targets.add(`recognizer:${yid}`);
	}
	if (!tier) E('empty_app', 'the app holds no snippet, search engine or User App', '.');
	if (!Number.isInteger(app.tier) || app.tier < 1 || app.tier > 3) E('field_missing', 'tier must be 1, 2 or 3', 'bolt-app.json');
	else if (app.tier < tier) E('tier_understated', `declares tier ${app.tier} but the content needs tier ${tier}`, 'bolt-app.json');
	for (const x of platformFindings(app)) out.push(x);
	if (!Array.isArray(app.permissions)) E('field_missing', 'permissions must be an array', 'bolt-app.json');
	const declared = new Set((Array.isArray(app.permissions) ? app.permissions : []).filter((x) => typeof x === 'string'));
	for (const x of declared) if (!PERMS.includes(x) && !/^opens_links:[a-z0-9.-]+$/.test(x)) E('permission_unknown', `unknown permission "${x}"`, 'bolt-app.json');
	for (const x of perms) if (!declared.has(x)) E('permission_undeclared', `content needs "${x}" but bolt-app.json does not declare it`, 'bolt-app.json');
	for (const x of declared) if (!perms.has(x) && PERMS.includes(x) && tier < 3) W('permission_unused', `"${x}" is declared but nothing uses it`, 'bolt-app.json');
	// tests
	const tests = (Array.isArray(app.tests) ? app.tests : []).filter(isObj);
	if (!tests.length) E('no_tests', 'every content file needs at least one test in bolt-app.json', 'bolt-app.json');
	const covered = new Set();
	for (const t of tests) {
		covered.add(`${t.kind}:${t.target}`);
		if (t.kind === 'recognizer' && !(Array.isArray(t.negative) && t.negative.length)) E('recognizer_no_negative', 'a recognizer test needs at least one negative sample', 'bolt-app.json');
		if (!['snippet', 'search', 'transform', 'recognizer'].includes(t.kind)) E('test_kind', `unknown test kind "${t.kind}"`, 'bolt-app.json');
	}
	for (const t of targets) if (!covered.has(t)) { const [k, n] = t.split(':'); if (k === 'snippet' || k === 'search' || ![...covered].some((c) => /^(transform|recognizer):/.test(c) && c.endsWith(`:${n}`))) { if (k !== 'recognizer') E('no_test_for', `no ${k} test targets "${n}"`, 'bolt-app.json'); } }
	return { id, out, app, files, tier, perms: [...perms] };
}
function appDirs(target) {
	if (fs.existsSync(path.join(target, 'bolt-app.json'))) return [target];
	const root = fs.existsSync(path.join(target, 'apps')) ? path.join(target, 'apps') : target;
	return fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(root, e.name, 'bolt-app.json'))).map((e) => path.join(root, e.name));
}
function cmdLint(args) {
	const json = args.includes('--json'), target = args.find((a) => !a.startsWith('--')) || '.';
	if (!fs.existsSync(target)) die(`no such folder: ${target}`);
	const dirs = appDirs(target); if (!dirs.length) die(`no Bolt Apps under ${target} (an app folder has a bolt-app.json)`);
	let bad = 0; const reports = [];
	for (const d of dirs) {
		const r = lintApp(d), errs = r.out.filter((x) => x.level === 'error'); if (errs.length) bad++;
		reports.push({ app: r.id, ok: !errs.length, findings: r.out });
		if (!json) { console.log(`${errs.length ? 'FAIL' : 'ok  '} ${r.id}`); for (const f of r.out) console.log(`     ${f.level} ${f.code}: ${f.message} (${f.path})`); }
	}
	if (json) console.log(JSON.stringify({ ok: !bad, reports }, null, 2));
	else console.log(`\n${dirs.length - bad} of ${dirs.length} passed offline shape checks. This is not the full check: tests are not run. Bolt runs them when you add the app.`);
	process.exit(bad ? 1 : 0);
}

// ---------- new ----------
const TEMPLATES = {
	snippet: (id) => { const key = keyOf(id); return { tier: 1, perms: ['copies_to_clipboard'], summary: `Type ;${key}, fill in a name, get a greeting. Replace this with your text.`, files: { [`snippets/${key}.json`]: { key, label: id, content: 'Hello {input:Name=world}' } }, tests: [{ kind: 'snippet', name: 'fills the name', target: key, fields: { Name: 'Bolt' }, expect: 'Hello Bolt' }] }; },
	search: (id) => { const p = prefixOf(id); return { tier: 1, perms: ['opens_links:example.com'], summary: `Type ${p} and a query to search example.com. Replace the site.`, files: { [`search_engines/${p}.json`]: { id: p, name: id, urlTemplate: 'https://example.com/search?q={q}' } }, tests: [{ kind: 'search', name: 'builds the link', target: p, query: 'hello', expect: 'https://example.com/search?q=hello' }] }; },
	transform: (id) => ({ tier: 2, perms: ['copies_to_clipboard', 'reads_launcher_input'], summary: `Type =${keyOf(id)}, paste text, get it upper-cased. Replace the pipe steps.`, files: { [`utilities/${id}.yaml`]: `schema_version: 1\nruntime: transform\nid: "${id}"\nchip: ${keyOf(id)}\ntitle: "${id}"\nicon: wand\ndescription: Trim and upper-case what you paste\nemits: Generic\n\npresentation:\n  widget: detail\n\ntransform:\n  pipe:\n    - trim\n    - upper\n` }, tests: [{ kind: 'transform', name: 'trims and upper-cases', target: id, input: '  hello  ', expect: 'HELLO' }] }),
	recognizer: (id) => ({ tier: 2, perms: ['copies_to_clipboard', 'reads_launcher_input'], summary: 'Paste a ticket key like TKT-123 and get its link. Replace the pattern and links.', files: { [`utilities/${id}.yaml`]: `schema_version: 1\nruntime: transform\nid: "${id}"\nchip: ${keyOf(id)}\ntitle: "${id}"\nicon: link\ndescription: Recognize a ticket key and copy its link\nemits: Generic\nplaceholder_examples:\n  - "TKT-123"\n\npresentation:\n  widget: detail\n\ntransform:\n  pipe:\n    - trim\n    - upper\n\nrecognize:\n  patterns:\n    - regex: "(TKT-\\\\d{1,6})"\n  reps:\n    - label: Link\n      template: "https://example.com/tickets/{1}"\n` }, tests: [{ kind: 'recognizer', name: 'recognizes ticket keys and nothing else', target: id, positive: ['TKT-123'], negative: ['TKT', 'TKT-', 'see TKT-123 here'], expect_rep: [{ input: 'TKT-123', label: 'Link', value: 'https://example.com/tickets/TKT-123' }] }] }),
};
const keyOf = (id) => { let k = id.replace(/[^a-z0-9_-]/g, '').slice(0, 24); return /^[a-z]/.test(k) ? k : `a${k}`.slice(0, 24); };
const prefixOf = (id) => { let k = id.replace(/[^a-z0-9]/g, '').slice(0, 12); return /^[a-z]/.test(k) ? k : `a${k}`.slice(0, 12); };
function flag(args, name, dflt) { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; }
function cmdNew(args) {
	const id = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--type' && args[args.indexOf(a) - 1] !== '--dir' && args[args.indexOf(a) - 1] !== '--author');
	const type = flag(args, '--type', 'snippet'), root = flag(args, '--dir', 'apps'), author = flag(args, '--author', os.userInfo().username);
	if (!id || !ID.test(id)) die(`usage: bolt-apps new <id> [--type ${Object.keys(TEMPLATES).join('|')}] [--dir apps] [--author "Your name"]\n  id: lowercase letters, digits and hyphens`);
	if (!TEMPLATES[type]) die(`unknown --type "${type}". Types: ${Object.keys(TEMPLATES).join(', ')}`);
	const dir = path.join(root, id); if (fs.existsSync(dir)) die(`${dir} already exists`);
	const t = TEMPLATES[type](id);
	for (const [f, c] of Object.entries(t.files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), typeof c === 'string' ? c : JSON.stringify(c, null, 2) + '\n'); }
	const listing = { schema_version: 1, id, title: id, role: 'Who this is for. Replace me.', saves: 'What it saves them. Replace me.', summary: t.summary, author: { name: author }, tier: t.tier, permissions: t.perms, tests: t.tests };
	fs.writeFileSync(path.join(dir, 'bolt-app.json'), JSON.stringify(listing, null, 2) + '\n');
	fs.writeFileSync(path.join(dir, 'README.md'), `# ${id}\n\n${t.summary}\n\n## Who it is for\n\n## What it saves\n\n## Permissions\n\n${t.perms.map((p) => `- \`${p}\``).join('\n')}\n\n## Sample\n\nShow one real input and output.\n`);
	console.log(`created ${dir} (${type}, tier ${t.tier})\nnext: edit it, then  bolt-apps lint ${dir}  and  bolt-apps pack ${dir}`);
}

// ---------- keys, tar, pack, verify ----------
function cmdKeygen(args) {
	const out = flag(args, '--out', DEFAULT_KEY);
	if (fs.existsSync(out)) die(`${out} already exists; refusing to overwrite a signing key`);
	if (path.resolve(out).startsWith(process.cwd() + path.sep)) console.error('warning: that key file is inside the current folder; keep signing keys out of any git repo.');
	const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
	fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
	fs.writeFileSync(out, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
	console.log(`key written to ${out} (private, mode 600)\npublic key: ${rawPub(publicKey)}\nKeep the file private. Anyone with it can sign as you.`);
}
const rawPub = (pub) => pub.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
function tarFile(name, data) {
	const nb = Buffer.from(name); if (nb.length > 100) die(`path too long for a pack: ${name}`);
	const h = Buffer.alloc(512); nb.copy(h, 0);
	h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
	h.write(data.length.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136);
	h.write('        ', 148); h.write('0', 156); h.write('ustar  \0', 257);
	h.write(h.reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148);
	return Buffer.concat([h, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}
function untar(buf) {
	const files = new Map(); let off = 0;
	while (off + 512 <= buf.length) {
		const h = buf.subarray(off, off + 512); if (h.every((b) => b === 0)) break;
		const s = (a, b) => h.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
		const name = (s(345, 500) ? s(345, 500) + '/' : '') + s(0, 100), size = parseInt(s(124, 136).trim() || '0', 8), type = String.fromCharCode(h[156] || 48);
		off += 512; if (type === '0' || type === '\0') files.set(name, buf.subarray(off, off + size)); off += Math.ceil(size / 512) * 512;
	}
	return files;
}
function contentHash(manifests) {
	const h = crypto.createHash('sha256');
	for (const [p, c] of [...manifests].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
		const pb = Buffer.from(p), pl = Buffer.alloc(4), cl = Buffer.alloc(8); pl.writeUInt32LE(pb.length); cl.writeBigUInt64LE(BigInt(c.length)); h.update(pl).update(pb).update(cl).update(c);
	}
	return h.digest('hex');
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const KINDS = { snippets: 'snippet', search_engines: 'search_engine', utilities: 'user_utility' };
function cmdPack(args) {
	const dir = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--key' && args[args.indexOf(a) - 1] !== '--out' && args[args.indexOf(a) - 1] !== '--version' && args[args.indexOf(a) - 1] !== '--notes');
	if (!dir || !fs.existsSync(path.join(dir, 'bolt-app.json'))) die('usage: bolt-apps pack <app-folder> [--key file] [--out file.boltpack] [--version 1.0.0] [--notes "text"]');
	const r = lintApp(dir), errs = r.out.filter((x) => x.level === 'error');
	if (errs.length) { errs.forEach((e) => console.error(`  ${e.code}: ${e.message} (${e.path})`)); die('fix the findings above first (bolt-apps lint shows them)', 1); }
	if (r.tier >= 3) die('tier 3 apps cannot be packed with this toolkit', 1);
	const keyFile = flag(args, '--key', DEFAULT_KEY);
	if (!fs.existsSync(keyFile)) die(`no signing key at ${keyFile}. Make one with: bolt-apps keygen`);
	const priv = crypto.createPrivateKey(rd(keyFile)), pub = rawPub(crypto.createPublicKey(priv));
	const manifests = new Map();
	for (const [folder, names] of Object.entries(r.files)) for (const n of names) manifests.set(`${folder}/${n}`, fs.readFileSync(path.join(dir, folder, n)));
	const app = r.app, version = flag(args, '--version', '1.0.0');
	const entries = [...manifests].sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, c]) => ({ path: `manifests/${p}`, kind: KINDS[p.split('/')[0]], id: path.basename(p).replace(/\.[^.]+$/, ''), sha256: sha(c), requires_min_schema: 1 }));
	const meta = {
		schema_version: 1, bundle_version: version, signed_by: app.author.name, signed_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
		min_bolt_api_version: '0.1.0', content_sha256: contentHash(manifests), manifest_count: manifests.size, entries, release_notes: flag(args, '--notes', ''),
		bundle_kind: 'util_pack', pack: { pack_id: app.id, name: app.title, description: app.summary || undefined, author: { name: app.author.name, kind: 'user' } },
		risk: { level: r.tier >= 2 ? 'medium' : 'low', reasons: r.tier >= 2 ? ['Runs a launcher transform on what you paste'] : [] }, signer_pubkey: pub, listing: app,
	};
	const bundle = Buffer.from(JSON.stringify(meta, null, 2)), sig = crypto.sign(null, bundle, priv);
	const parts = [tarFile('bundle.json', bundle), tarFile('signature.bin', sig), ...[...manifests].sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, c]) => tarFile(`manifests/${p}`, c)), Buffer.alloc(1024)];
	const out = flag(args, '--out', `${app.id}.boltpack`), gz = zlib.gzipSync(Buffer.concat(parts), { level: 9 });
	if (gz.length > 50 * 1024 * 1024) die('pack is over the 50 MB limit', 1);
	fs.writeFileSync(out, gz);
	console.log(`packed ${out} (${manifests.size} file${manifests.size === 1 ? '' : 's'}, tier ${r.tier}, signed with key ${pub.slice(0, 16)}...)\nto install: drop it on the Bolt launcher. Bolt shows a review card, then asks again because it is self-signed.`);
}
export function readPack(file) {
	let e; try { e = untar(zlib.gunzipSync(fs.readFileSync(file))); } catch (x) { return { ok: false, reason: `not a gzip tar: ${x.message}` }; }
	const bj = e.get('bundle.json'), sig = e.get('signature.bin'); if (!bj) return { ok: false, reason: 'bundle.json is missing' };
	let meta; try { meta = JSON.parse(bj.toString()); } catch { return { ok: false, reason: 'bundle.json is not JSON' }; }
	const man = new Map([...e].filter(([p]) => p.startsWith('manifests/')).map(([p, c]) => [p.slice(10), c]));
	if (!sig || sig.length !== 64) return { ok: false, reason: 'signature.bin is missing or not 64 bytes', meta };
	if (!meta.signer_pubkey) return { ok: false, reason: 'signed by a Sparcle or company key; only Bolt can verify that', meta };
	let good = false; try { good = crypto.verify(null, bj, crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(meta.signer_pubkey, 'hex')]), format: 'der', type: 'spki' }), sig); } catch { /* bad key */ }
	if (!good) return { ok: false, reason: 'the signature does not match bundle.json', meta };
	if (contentHash(man) !== meta.content_sha256) return { ok: false, reason: 'files changed after signing (content hash mismatch)', meta };
	for (const en of meta.entries || []) { const c = man.get(en.path.replace(/^manifests\//, '')); if (!c || sha(c) !== en.sha256) return { ok: false, reason: `entry ${en.path} does not match its hash`, meta }; }
	return { ok: true, meta };
}
function cmdVerify(args) {
	const f = args[0]; if (!f || !fs.existsSync(f)) die('usage: bolt-apps verify <file.boltpack>');
	const r = readPack(f);
	if (!r.ok) { console.error(`NOT VALID: ${r.reason}`); process.exit(1); }
	const m = r.meta; console.log(`valid, self-signed\n  pack     ${m.pack?.pack_id} ${m.bundle_version} (${m.pack?.name})\n  signer   ${m.signer_pubkey}\n  signed   ${m.signed_at}\n  files    ${m.manifest_count}\nThis proves the files were not changed after signing. It does not prove who signed them.`);
}

// ---------- main ----------
const HELP = `bolt-apps: author toolkit for Bolt Apps\n\n  new <id> [--type snippet|search|transform|recognizer]   start from a working template\n  lint [path]                                             offline shape checks\n  keygen [--out file]                                     make your signing key (default ~/.bolt-apps/key.pem)\n  pack <app-folder> [--key file] [--out file]             build and self-sign a .boltpack\n  verify <file.boltpack>                                  check a pack's hash and signature\n\nDocs: https://sparcle.app/docs/extend/`;
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
	const [cmd, ...rest] = process.argv.slice(2);
	const cmdCheck = async (args) => {
		const target = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--os' && args[i - 1] !== '--case');
		if (target && fs.existsSync(path.join(target, 'check.json'))) {
			const osi = args.indexOf('--os'), osArg = osi >= 0 ? args[osi + 1] : undefined;
			if (osi >= 0 && !OSES.includes(osArg)) die(`--os must be one of ${OSES.join(', ')}`);
			const ci = args.indexOf('--case');
			const r = await checkApp(target, { os: osArg, only: ci >= 0 ? args[ci + 1] : undefined, updateGolden: args.includes('--update-golden') });
			console.log(args.includes('--json') ? JSON.stringify({ ok: reportOk(r), ...r }, null, 2) : formatReport(r));
			process.exit(reportOk(r) ? 0 : 1);
		}
		die('check for snippets, search engines and transforms runs through Bolt\'s own engines and is not published yet. Use lint for offline shape checks; Bolt runs the tests when you add the app. Script apps (a check.json in the folder) run here: see kit/examples/system-glance.');
	};
	const cmdKit = (args) => {
		if (args[0] !== 'vendor' || !args[1] || !fs.existsSync(path.join(args[1], 'check.json'))) die('usage: bolt-apps kit vendor <app-folder with check.json>');
		const { dest, lock } = vendorKit(args[1]);
		console.log(`vendored ${lock.name} ${lock.version} (sha256 ${lock.sha256.slice(0, 16)}...) into ${dest}`);
	};
	const cmds = { check: cmdCheck, kit: cmdKit, new: cmdNew, lint: cmdLint, keygen: cmdKeygen, pack: cmdPack, verify: cmdVerify };
	if (cmds[cmd]) await cmds[cmd](rest);
	else if (!cmd || cmd === 'help' || cmd === '--help') console.log(HELP);
	else die(`unknown command "${cmd}"\n\n${HELP}`);
}
