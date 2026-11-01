from . import text, fmt, util, hosts, cache, errors


def build(q, when):
    errors.check(q)
    return [{"title": fmt.line(text.clean(q), when), "host": hosts.first(), "n": util.count(cache.get(q))}]
