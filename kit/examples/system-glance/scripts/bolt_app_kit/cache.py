"""A small file cache for probe results. Shape-checked on read, symlink-safe, pruned, and it never stores a failure."""
import hashlib
import json
import os
import re
import stat
import time

_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
_MAX_FILE = 1024 * 1024


def default_root(app):
    return os.path.join(os.path.expanduser("~"), ".bolt-apps", "cache", str(app))


class Cache(object):
    """Cache(app, ttl, shape=callable, root=None, max_entries=64).

    shape(value) -> bool is required: a cached value that does not pass it is a miss. get() returns None for
    a miss. put() refuses (returns False) a None value or ok=False, so a failed or unread probe is never
    cached as if it were an answer. If the directory is not safe (a symlink, not ours, writable by others),
    the cache switches itself off: get() misses and put() is a no-op."""

    def __init__(self, app, ttl, shape, root=None, max_entries=64, clock=time.time):
        if not callable(shape):
            raise TypeError("Cache needs a shape(value) check")
        self.ttl, self.shape, self.max_entries, self._clock = float(ttl), shape, int(max_entries), clock
        if root is None and (not isinstance(app, str) or not re.match(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\Z", app) or ".." in app):
            raise ValueError("cache app name must be a plain name")
        self.root = root or default_root(app)
        self.enabled = self._prepare()

    def _prepare(self):
        try:
            parent = os.path.dirname(self.root)
            os.makedirs(parent, 0o700, exist_ok=True)
            if not os.path.lexists(self.root):
                os.mkdir(self.root, 0o700)
            for d in (parent, self.root):
                st = os.lstat(d)
                if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode):
                    return False
                if hasattr(os, "getuid") and (st.st_uid != os.getuid() or st.st_mode & 0o022):
                    return False
            return True
        except OSError:
            return False

    def _path(self, key):
        return os.path.join(self.root, hashlib.sha256(str(key).encode("utf-8")).hexdigest()[:40] + ".json")

    def get(self, key):
        if not self.enabled:
            return None
        try:
            fd = os.open(self._path(key), os.O_RDONLY | _NOFOLLOW)
            try:
                st = os.fstat(fd)
                if not stat.S_ISREG(st.st_mode) or st.st_size > _MAX_FILE:
                    return None
                data = os.read(fd, _MAX_FILE)
            finally:
                os.close(fd)
            doc = json.loads(data.decode("utf-8"))
            if not isinstance(doc, dict) or doc.get("v") != 1 or doc.get("key") != str(key):
                return None
            ts = doc.get("ts")
            if isinstance(ts, bool) or not isinstance(ts, (int, float)):
                return None
            now = self._clock()
            if ts > now + 1 or now - ts > self.ttl:
                return None
            val = doc.get("value")
            return val if val is not None and self.shape(val) else None
        except Exception:  # a stale or hostile file (or a shape check that trips on it) is a miss
            return None

    def age(self, key):
        """Seconds since the entry was stored, or None."""
        if self.get(key) is None:
            return None
        try:
            with open(self._path(key), "rb") as f:
                return max(0.0, self._clock() - json.loads(f.read().decode("utf-8"))["ts"])
        except Exception:
            return None

    def put(self, key, value, ok=True):
        if not self.enabled or not ok or value is None:
            return False
        try:
            if not self.shape(value):
                return False
            blob = json.dumps({"v": 1, "key": str(key), "ts": self._clock(), "value": value}).encode("utf-8")
            if len(blob) > _MAX_FILE:
                return False
            tmp = os.path.join(self.root, ".tmp-%d-%s" % (os.getpid(), os.urandom(6).hex()))
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | _NOFOLLOW, 0o600)
            try:
                view = memoryview(blob)
                while view:
                    view = view[os.write(fd, view):]
            finally:
                os.close(fd)
            os.replace(tmp, self._path(key))
            self.prune()
            return True
        except Exception:
            return False

    def prune(self):
        """Remove expired entries, stray temp files, and the oldest beyond max_entries. Regular files only."""
        try:
            now, keep = self._clock(), []
            for name in os.listdir(self.root):
                p = os.path.join(self.root, name)
                st = os.lstat(p)
                if not stat.S_ISREG(st.st_mode):
                    continue
                stale = now - st.st_mtime > max(self.ttl * 4, 60)
                if name.startswith(".tmp-") and now - st.st_mtime > 60 or (name.endswith(".json") and stale):
                    os.unlink(p)
                elif name.endswith(".json"):
                    keep.append((st.st_mtime, p))
            for _, p in sorted(keep)[: max(0, len(keep) - self.max_entries)]:
                os.unlink(p)
        except OSError:
            pass
