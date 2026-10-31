"""Running commands the way the launcher does: argv only, one shared deadline, never a faked value."""
import os
import signal
import subprocess
import sys
import threading
import time

DEFAULT_BUDGET = 14.0   # seconds: the bridge limit is 20 s, this leaves room to print
MAX_BYTES = 1024 * 1024


def os_name():
    """macos, linux, windows or other. The one place that reads sys.platform."""
    p = sys.platform
    if p == "darwin":
        return "macos"
    if p.startswith("linux"):
        return "linux"
    if p in ("win32", "cygwin", "msys"):
        return "windows"
    return "other"


def which(name, dirs=None, os_=None):
    """Absolute path of an executable, or None. Searches `dirs` when given (and ignores PATH), else PATH.
    On Windows also tries .exe .cmd .bat .com."""
    osn = os_ or os_name()
    if os.path.isabs(name):
        cands = [name]
    else:
        search = list(dirs) if dirs is not None else [d for d in os.environ.get("PATH", "").split(os.pathsep) if d]
        cands = [os.path.join(d, name) for d in search]
    exts = [""] if osn != "windows" else ["", ".exe", ".cmd", ".bat", ".com"]
    for c in cands:
        for e in exts:
            p = c + e
            if os.path.isfile(p) and os.access(p, os.X_OK):
                return os.path.abspath(p)
    return None


class Deadline(object):
    """One time budget shared by every command in a run. `clock` is injectable for tests."""

    def __init__(self, seconds=DEFAULT_BUDGET, clock=time.monotonic):
        self._clock = clock
        self._end = clock() + float(seconds)

    def remaining(self):
        return max(0.0, self._end - self._clock())

    def expired(self):
        return self.remaining() <= 0.0

    def cap(self, seconds=None):
        r = self.remaining()
        return r if seconds is None else min(r, float(seconds))


class RunResult(object):
    """(ok, rc, out) when unpacked. Also .timed_out, .missing, .reason."""
    __slots__ = ("ok", "rc", "out", "timed_out", "missing", "reason")

    def __init__(self, ok, rc, out, timed_out=False, missing=False, reason=""):
        self.ok, self.rc, self.out = ok, rc, out
        self.timed_out, self.missing, self.reason = timed_out, missing, reason

    def __iter__(self):
        return iter((self.ok, self.rc, self.out))

    def __repr__(self):
        return "RunResult(ok=%r, rc=%r, timed_out=%r, missing=%r)" % (self.ok, self.rc, self.timed_out, self.missing)


def _kill_tree(proc, os_):
    """Kill the process and everything it started. POSIX: the whole process group (the child is a session
    leader). Windows: taskkill /T /F, then proc.kill() as a fallback."""
    try:
        if os_ == "windows":
            tk = which("taskkill", os_="windows")
            if tk:
                try:
                    subprocess.run([tk, "/PID", str(proc.pid), "/T", "/F"], stdin=subprocess.DEVNULL,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
                except Exception:
                    pass
        if os.name != "nt":  # a real POSIX host (also when a test pretends to be Windows): kill the group
            try:
                os.killpg(proc.pid, signal.SIGKILL)
                return
            except Exception:
                pass
        proc.kill()
    except Exception:
        pass


def run(cmd, deadline=None, timeout=None, dirs=None, cwd=None, env=None, ok_rcs=(0,), empty_ok_rcs=(),
        max_bytes=MAX_BYTES, os_=None, encoding="utf-8", locale_c=True):
    """Run one command. Returns (ok, rc, out) and never raises for a missing program, a bad exit or a timeout.

    cmd        list of strings. A string is a programming error (TypeError): there is no shell here.
    deadline   a shared Deadline; the command gets what is left, capped by `timeout`. Expired: not started.
    dirs       resolve cmd[0] only in these directories (absolute-path option), ignoring PATH.
    ok_rcs     exit codes that count as success. Any other code is ok=False, even with output.
    empty_ok_rcs  exit codes that mean "nothing to list" (lsof 1, defaults read of an unset key): ok=True
               only when the output is empty. With output they are failures.
    env        the child environment, exactly as given ({} is empty). Default: the parent's with LC_ALL=C and LANG=C
               (locale_c=False keeps the user's locale), so output is not translated or decimal-comma'd.
    out        stdout as text (UTF-8, undecodable bytes replaced), cut at max_bytes. stderr is discarded.
    """
    if isinstance(cmd, (str, bytes)) or not cmd:
        raise TypeError("run() takes an argv list, not a string")
    osn = os_ or os_name()
    exe = which(cmd[0], dirs, osn)
    if exe is None:
        return RunResult(False, None, "", missing=True, reason="not found: %s" % cmd[0])
    budget = deadline.cap(timeout) if deadline is not None else (None if timeout is None else float(timeout))
    if budget is not None and budget <= 0.0:
        return RunResult(False, None, "", timed_out=True, reason="no time left")
    kw = dict(stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, cwd=cwd)
    if env is not None:
        kw["env"] = dict(env)
    elif locale_c:
        e = dict(os.environ)  # the whole parent environment, unchanged except for the locale
        e.update({"LC_ALL": "C", "LANG": "C"})
        kw["env"] = e
    if os.name == "nt":  # a real capability test, so a fixture run that pretends to be Windows still starts
        kw["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) | getattr(subprocess, "CREATE_NO_WINDOW", 0)
    else:
        kw["start_new_session"] = True
    try:
        proc = subprocess.Popen([exe] + [str(a) for a in cmd[1:]], **kw)
    except (OSError, ValueError) as e:
        return RunResult(False, None, "", reason="could not start: %s" % e.__class__.__name__)
    try:
        raw, _ = proc.communicate(timeout=budget)
    except subprocess.TimeoutExpired:
        _kill_tree(proc, osn)
        try:
            raw, _ = proc.communicate(timeout=2)
        except Exception:
            raw = b""
        return RunResult(False, None, (raw or b"")[:max_bytes].decode(encoding, "replace"), timed_out=True, reason="timed out")
    out = (raw or b"")[:max_bytes].decode(encoding, "replace")
    rc = proc.returncode
    if rc in ok_rcs:
        return RunResult(True, rc, out)
    if rc in empty_ok_rcs and not out.strip():
        return RunResult(True, rc, "")
    return RunResult(False, rc, out, reason="exit %s" % rc)


class Probe(object):
    """The outcome of reading one thing. `value` is meaningful only when ok. A probe that failed, timed out
    or could not be parsed is unread: it is never turned into 0, "" or an empty list."""
    __slots__ = ("name", "ok", "value", "reason", "timed_out")

    def __init__(self, name, ok, value=None, reason="", timed_out=False):
        self.name, self.ok, self.value, self.reason, self.timed_out = name, bool(ok), value if ok else None, reason, timed_out

    @property
    def unread(self):
        return not self.ok

    def get(self, default=None):
        return self.value if self.ok else default

    def __repr__(self):
        return "Probe(%r, ok=%r)" % (self.name, self.ok)


def probe(name, cmd=None, parse=None, fn=None, deadline=None, require_output=False, **run_kw):
    """Read one thing. Give `cmd` (argv) and an optional `parse(text)`, or `fn()` returning the value.
    parse returning None, or raising, means unread. require_output makes empty output unread."""
    try:
        if fn is not None:
            v = fn()
            return Probe(name, v is not None, v, "no value" if v is None else "")
        r = run(cmd, deadline=deadline, **run_kw)
        if not r.ok:
            return Probe(name, False, reason=r.reason, timed_out=r.timed_out)
        if require_output and not r.out.strip():
            return Probe(name, False, reason="empty output")
        v = parse(r.out) if parse else r.out
        if v is None:
            return Probe(name, False, reason="could not parse")
        return Probe(name, True, v)
    except TypeError:
        raise
    except Exception as e:  # a parser bug must not become a clean zero
        return Probe(name, False, reason="error: %s" % e.__class__.__name__)


def run_parallel(tasks, deadline):
    """Run {name: callable returning a Probe} on threads inside the shared deadline. A task still running
    when time is up is unread (timed out), and its thread is abandoned: emit() exits without waiting."""
    results = {}
    lock = threading.Lock()

    def work(n, f):
        try:
            p = f()
        except Exception as e:
            p = Probe(n, False, reason="error: %s" % e.__class__.__name__)
        with lock:
            results[n] = p

    threads = []
    for n, f in tasks.items():
        t = threading.Thread(target=work, args=(n, f))
        t.daemon = True
        t.start()
        threads.append(t)
    for t in threads:
        t.join(deadline.remaining())
    with lock:
        return dict((n, results.get(n) or Probe(n, False, reason="timed out", timed_out=True)) for n in tasks)
