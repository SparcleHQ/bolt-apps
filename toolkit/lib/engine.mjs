// The shared engine, kept once at kit/python/bolt_app_engine.py. A thin app (scripts/<id>__engine.py that only loads it) has no copy of
// the engine in its folder; Bolt installs every script into one folder and Bolt 181 has no shared engine, so the PACK must carry it:
// lint counts it as the app's script and pack writes it into the pack as scripts/<id>__bolt_app_engine.py. One copy per pack, none in the app folder.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'kit');   // not imported from check.mjs: that module imports this one

export const ENGINE_SRC = path.join(KIT_ROOT, 'python', 'bolt_app_engine.py');
export const ENTRY_SRC = path.join(KIT_ROOT, 'python', 'bolt_app_engine_entry.py');
/** Env a toolkit-run thin entry finds the shared engine by (check, run, emit-yaml): the app folder may be anywhere. */
export const engineEnv = () => ({ BOLT_APPS_ENGINE_FILE: ENGINE_SRC });
export const engineName = (id) => `${id}__bolt_app_engine.py`;

/** The name of the engine file a pack of this app must carry, or null: only a thin entry that loads it and has no copy beside it. */
export function thinEngineName(dir, id) {
	if (typeof id !== 'string' || !id) return null;
	try {
		if (!fs.readFileSync(path.join(dir, 'scripts', `${id}__engine.py`), 'utf8').slice(0, 4000).includes('bolt_app_engine.py')) return null;
		return fs.existsSync(path.join(dir, 'scripts', engineName(id))) ? null : engineName(id);
	} catch { return null; }
}

/** Reads scripts/<name> of an app folder; the shared engine stands in for the one file a thin app does not keep. */
export function readScript(dir, name, id, enc) {
	const p = path.join(dir, 'scripts', name);
	if (name === engineName(id) && !fs.existsSync(p) && thinEngineName(dir, id)) return enc ? fs.readFileSync(ENGINE_SRC, enc) : fs.readFileSync(ENGINE_SRC);
	return enc ? fs.readFileSync(p, enc) : fs.readFileSync(p);
}

const FILE_WORDS = /^FILE_WORDS = .*$/m;
/** `new` copies a template that still carries its own engine. When that copy is the shared engine (only the FILE_WORDS line may differ), swap it for the thin entry: a new app starts without a private copy. Returns true when swapped. */
export function thinIfShared(dir, id) {
	const p = path.join(dir, 'scripts', `${id}__engine.py`);
	try {
		const have = fs.readFileSync(p, 'utf8');
		if (have.replace(FILE_WORDS, '') !== fs.readFileSync(ENGINE_SRC, 'utf8').replace(FILE_WORDS, '')) return false;
		fs.writeFileSync(p, fs.readFileSync(ENTRY_SRC));
		return true;
	} catch { return false; }
}

/** A template that is itself thin (acme-dash) is copied by `new` as a full engine unless --thin: the hand-run `python3 scripts/<id>__engine.py --emit-yaml` of the docs works for a plain copy. Returns true when expanded. */
export function expandThin(dir, id) {
	const p = path.join(dir, 'scripts', `${id}__engine.py`);
	try {
		if (!fs.readFileSync(p, 'utf8').slice(0, 4000).includes('bolt_app_engine.py')) return false;
		fs.writeFileSync(p, fs.readFileSync(ENGINE_SRC));
		return true;
	} catch { return false; }
}
