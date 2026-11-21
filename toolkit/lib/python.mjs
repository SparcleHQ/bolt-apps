// Find a working Python 3.9+ once. `python3` is not the name everywhere: on Windows it is often a Microsoft Store stub or missing while
// `python` or `py -3` works. Each candidate is resolved to an ABSOLUTE path by walking the parent process PATH (never the spawn cwd, where
// Windows would look first: a downloaded app folder holding a python.exe must not win), proven by running `--version`, and the first that
// reports 3.9 or newer is cached. Everything then spawns that absolute path.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const PYTHON_MISSING = 'Python 3.9 or newer was not found: install it from python.org and re-run';

export function candidates(platform = process.platform) {
	const c = [['python3'], ['python']];
	if (platform === 'win32') c.push(['py', '-3']);
	return c;
}

const versionOk = (text) => { const m = /Python\s+(\d+)\.(\d+)/i.exec(text || ''); return !!m && (Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 9)); };
// Compare folders by realpath (falling back to the plain path when it does not exist), lowercased on win32 where paths are case-insensitive.
const norm = (p, win) => { let r; try { r = fs.realpathSync(p); } catch { r = (win ? path.win32.resolve : path.posix.resolve)(p); } return win ? r.toLowerCase() : r; };

// Every executable file called `name` on PATH, in order. On win32 only .exe and .com are accepted (never .bat or .cmd, which run through cmd.exe).
// Skipped: empty and relative entries, UNC entries (\\server\share), and any folder in `skip` (the cwd, the app folder). Quotes around an entry are stripped first.
export function resolveAllOnPath(name, { env = process.env, platform = process.platform, skip = [], isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } } } = {}) {
	const win = platform === 'win32';
	const exts = win ? (env.PATHEXT || '.COM;.EXE').split(';').filter((x) => /^\.(exe|com)$/i.test(x)) : [''];
	const join = win ? path.win32.join : path.posix.join;
	const skipN = skip.map((s) => norm(s, win));
	const out = [];
	for (const raw of (env.PATH || env.Path || '').split(win ? ';' : ':')) {
		const d = raw.trim().replace(/^"(.*)"$/, '$1');
		if (!d || (win && /^[\\/]{2}/.test(d))) continue;
		if (!(win ? path.win32.isAbsolute(d) : path.posix.isAbsolute(d))) continue;   // a relative entry means "the cwd" by another name
		if (skipN.includes(norm(d, win))) continue;
		for (const x of exts) { const p = join(d, name + x); if (isFile(p)) out.push(p); }
	}
	return out;
}
export const resolveOnPath = (name, o) => resolveAllOnPath(name, o)[0] || null;

// True when the file starts with `#!`: a version-manager shim (pyenv, asdf, mise) rather than the interpreter itself.
export function isShebangScript(p) {
	let fd; try { fd = fs.openSync(p, 'r'); const b = Buffer.alloc(2); return fs.readSync(fd, b, 0, 2, 0) === 2 && b.toString('latin1') === '#!'; } catch { return false; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

// A shim such as ~/.pyenv/shims/python3 is `#!/usr/bin/env bash`: it works from a shell, but `check` runs scripts with a PATH that holds
// only its stubs, so the shim cannot find bash and every case exits 127. Ask the shim for the interpreter it runs (sys.executable) and use
// that instead, but only when it is an absolute file outside the skipped folders, is not itself a script, and answers --version with an
// empty PATH. Anything else keeps the shim, as before.
function realInterpreter(cmd, args, { spawn, platform, skip, isFile, isScript }) {
	if (platform === 'win32' || !isScript(cmd)) return null;
	let r; try { r = spawn(cmd, [...args, '-c', 'import sys; print(sys.executable)'], { encoding: 'utf8', timeout: 10000, cwd: path.dirname(cmd) }); } catch { return null; }
	if (!r || r.error || r.status !== 0) return null;
	const real = String(r.stdout || '').trim();
	if (!real || real === cmd || !path.isAbsolute(real) || !isFile(real) || isScript(real)) return null;
	if (skip.map((s) => norm(s, false)).includes(norm(path.dirname(real), false))) return null;
	let v; try { v = spawn(real, ['--version'], { encoding: 'utf8', timeout: 10000, cwd: path.dirname(real), env: { PATH: '' } }); } catch { return null; }
	return v && !v.error && v.status === 0 && versionOk(`${v.stdout || ''} ${v.stderr || ''}`) ? real : null;
}

// Returns { cmd (absolute path), args (leading arguments, such as ['-3'] for `py -3`), label } or null when none works.
// `spawn`, `resolve`, `env`, `platform`, `skip`, `isFile` and `isScript` are injectable for tests.
export function findPython({ spawn = spawnSync, platform = process.platform, env = process.env, skip = [process.cwd()], resolve = resolveAllOnPath, isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }, isScript = isShebangScript } = {}) {
	for (const [name, ...args] of candidates(platform)) {
		for (const cmd of resolve(name, { env, platform, skip })) {   // every hit: a Store stub first must not hide a real python behind it
			let r; try { r = spawn(cmd, [...args, '--version'], { encoding: 'utf8', timeout: 10000, cwd: path.dirname(cmd) }); } catch { continue; }
			if (r && !r.error && r.status === 0 && versionOk(`${r.stdout || ''} ${r.stderr || ''}`)) {
				const real = realInterpreter(cmd, args, { spawn, platform, skip, isFile, isScript });
				return { cmd: real || cmd, args: real ? [] : args, label: [name, ...args].join(' ') };
			}
		}
	}
	return null;
}

let cached;
// Cached for the process. Extra `skip` folders (the app folder) are honoured on the first call and when the cached answer lives inside one.
export function pythonCmd({ skip = [] } = {}) {
	if (cached === undefined || (cached && skip.some((s) => norm(s, process.platform === 'win32') === norm(path.dirname(cached.cmd), process.platform === 'win32')))) cached = findPython({ skip: [process.cwd(), ...skip] });
	return cached;
}
export function resetPythonCache() { cached = undefined; }
// Run Python with the interpreter found above. When none works the result is a spawnSync-shaped failure carrying the clear message.
export function spawnPython(args, opts = {}, spawn = spawnSync) {
	const p = pythonCmd();
	if (!p) return { status: null, stdout: '', stderr: '', error: new Error(PYTHON_MISSING) };
	return spawn(p.cmd, [...p.args, ...args], opts);
}
