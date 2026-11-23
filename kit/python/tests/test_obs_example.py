"""Tests for the obs example (kit/examples/obs): joining by service name, URL and auth rules, keys from the keychain or a private file,
and the aws CLI lane against a STUB aws (not real AWS). The checks run in a child Python with a temporary HOME so nothing real is read or written.
Synthetic data stands in where the public demos share no service names; the stub stands in for the aws CLI."""
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
EX = os.path.abspath(os.path.join(HERE, "..", "..", "examples", "obs"))

CHECKS = r'''import importlib.util, sys, os, json, tempfile, stat
P = os.path.join(os.environ['OBS_EXAMPLE_DIR'], 'scripts', 'obs__app.py')
spec = importlib.util.spec_from_file_location('obs__app', P); m = importlib.util.module_from_spec(spec); sys.modules['obs__app'] = m; spec.loader.exec_module(m)
cfg = m.load_json('config.json')
now = 1_800_000_000
def R(name, services, alerts):
    return {'name': name, 'type': 'x', 'ok': True, 'err': '', 'kind': '', 'ms': 1, 'stale': None, 'services': services, 'alerts': alerts, 'demo': False}
S = lambda n, st, d='': {'name': n, 'status': st, 'detail': d}
A = lambda n, svc, sev, since, state='firing': {'name': n, 'service': svc, 'severity': sev, 'since': since, 'summary': 'x', 'state': state}
# 1. names: spellings of one service join; suffixes stripped
assert m.norm('Checkout_API', cfg) == 'checkoutapi' == m.norm('checkout-api', cfg)
assert m.norm('checkout-deployment', cfg) == 'checkout'
# 2. two tools agree and their alerts start inside the window: TOGETHER
g = m.join([R('dd', [S('checkout-api', 'crit')], [A('HighErr', 'checkout-api', 'crit', now)]), R('coroot', [S('Checkout_API', 'warn')], [A('SLO incident', 'checkout-api', 'crit', now + 600)])], cfg, {})
assert len(g) == 1 and g[0]['flag'] == 'TOGETHER' and g[0]['status'] == 'crit' and g[0]['bad_sources'] == ['coroot', 'dd'], g
# 3. same, but alerts hours apart: AGREE only
g = m.join([R('dd', [S('web', 'ok')], [A('a', 'web', 'warn', now)]), R('c', [S('web', 'warn')], [A('b', 'web', 'warn', now + 99999)])], cfg, {})
assert g[0]['flag'] == 'AGREE', g[0]['flag']
# 4. one says ok, another warn: DISAGREE
g = m.join([R('dd', [S('api', 'ok')], []), R('c', [S('api', 'warn')], [])], cfg, {})
assert g[0]['flag'] == 'DISAGREE'
# 5. resolved alerts do not count; a pending one does not make a service red
g = m.join([R('dd', [S('db', 'ok')], [A('a', 'db', 'crit', now, 'resolved'), A('p', 'db', 'crit', now, 'pending')])], cfg, {})
assert g[0]['status'] == 'ok' and not g[0]['firing']
# 6. aliases join different names
g = m.join([R('dd', [S('payments', 'ok')], []), R('prom', [S('pay-svc', 'crit')], [])], cfg, {m.norm('pay-svc', cfg): m.norm('payments', cfg)})
assert len(g) == 1 and g[0]['flag'] == 'DISAGREE'
# 7. an alert for a service no tool lists still shows
g = m.join([R('prom', [], [A('a', 'ghost', 'crit', now)])], cfg, {})
assert g[0]['name'] == 'ghost' and g[0]['status'] == 'crit'
# 8. urls: https ok, http only loopback, userinfo/query/path refused
for u, ok in [('https://x.example.com', 1), ('http://x.example.com', 0), ('http://localhost:9090', 1), ('http://[::1]:9090', 1), ('https://u:p@x.example.com', 0), ('https://x.example.com/a', 0), ('https://x.example.com?k=1', 0), ('ftp://x', 0)]:
    assert bool(m._url_ok(u)) == bool(ok), u
# 9. auth: files and keys. A temp HOME so nothing real is touched.
import base64
home = tempfile.mkdtemp(); os.environ['HOME'] = home; d = os.path.join(home, '.config', 'obs'); os.makedirs(d)
def write(name, text, mode):
    p = os.path.join(d, name); open(p, 'w').write(text); os.chmod(p, mode); return p
N1, N2, N3 = 'PROM' + '_TOKEN', 'COROOT' + '_KEY', 'P2' + '_PASS'
V1, V2, V3 = 'tok_' + 'x1y2z3' * 4, 'key_' + 'q9w8e7' * 4, 'pw_' + 'm5n4b3' * 4
cfg2 = json.loads(json.dumps(cfg))
def src(name, typ, url, auth): return {'name': name, 'type': typ, 'url': url, 'auth': auth}
write('sources.json', json.dumps({'sources': [src('prod-prom', 'prometheus', 'https://prom.example.com', {'kind': 'bearer', 'secret': N1}),
                                              src('cr', 'coroot', 'https://coroot.example.com', {'kind': 'header', 'header': 'X-API-Key', 'secret': N2}),
                                              src('basic', 'prometheus', 'https://p2.example.com', {'kind': 'basic', 'user': 'bob', 'secret': N3})],
                                  'aliases': {'pay-svc': 'payments'}}), 0o644)
srcs, al = m.read_sources(cfg2)
assert [s['name'] for s in srcs] == ['prod-prom', 'cr', 'basic'] and al == {m.norm('pay-svc', cfg): m.norm('payments', cfg)}
ENV_TEXT = '\n'.join('%s=%s' % kv for kv in ((N1, V1), (N2, V2), (N3, V3))) + '\n'
env = write('.env', ENV_TEXT, 0o600)
for k in (N1, N2, N3): os.environ.pop(k, None)
h, pr = m.credentials(cfg2, srcs[0]); assert h == {'Authorization': 'Bearer ' + V1} and not pr, (h, pr)
h, pr = m.credentials(cfg2, srcs[1]); assert h == {'X-API-Key': V2}, h
h, pr = m.credentials(cfg2, srcs[2]); assert h == {'Authorization': 'Basic ' + base64.b64encode(('bob:' + V3).encode()).decode()}, h
# 10. a missing key: a setup hint, never a value; a group-readable .env is not used
os.remove(env); h, pr = m.credentials(cfg2, srcs[0]); assert h == {} and N1 in pr and V1 not in pr, pr
write('.env', ENV_TEXT, 0o644); h, pr = m.credentials(cfg2, srcs[0]); assert h == {}, 'a group-readable .env must not be used'
# 11. a bad sources file is refused with the reason
write('sources.json', json.dumps({'sources': [{'name': 'x', 'type': 'datadogX', 'url': 'https://a.example.com'}]}), 0o600)
try: m.read_sources(cfg2); assert False
except m.Fail as e: assert 'type must be one of' in e.msg
write('sources.json', json.dumps({'sources': [{'name': 'x', 'type': 'coroot', 'url': 'http://coroot.example.com'}]}), 0o600)
try: m.read_sources(cfg2); assert False
except m.Fail as e: assert 'url must be https' in e.msg
write('sources.json', '[]', 0o666)
try: m.read_sources(cfg2); assert False
except m.Fail as e: assert 'writable by others' in e.msg
# 12. a key never reaches a row: run the whole app against a source that fails, with the key set, and look at the output

# 13. the aws CLI lane, against a STUB `aws` (not real AWS): arguments, parsing, sign-in failure, missing CLI, bad profile
stubdir = tempfile.mkdtemp(); argv_log = os.path.join(stubdir, 'argv.txt'); mode_file = os.path.join(stubdir, 'mode')
STUB = """#!/bin/sh
printf '%s\\n' "$@" > __LOG__
case "$(cat __MODE__)" in
  ok) cat <<'J'
{"MetricAlarms":[{"AlarmName":"checkout-CRITICAL-5xx","StateValue":"ALARM","StateUpdatedTimestamp":"2026-11-22T10:14:00.123000+00:00","AlarmDescription":"5xx above 5%","Namespace":"AWS/ApplicationELB","Dimensions":[{"Name":"LoadBalancer","Value":"app/checkout-alb/abc123"}]},
 {"AlarmName":"db-cpu-high","StateValue":"ALARM","StateUpdatedTimestamp":"2026-11-22T10:20:00+00:00","StateReason":"CPU 91","Namespace":"AWS/RDS","Dimensions":[{"Name":"DBInstanceIdentifier","Value":"orders-db"}]}],"CompositeAlarms":[]}
J
  ;;
  expired) echo "Error loading SSO Token: Token for prod does not exist" >&2; exit 255 ;;
  junk) echo "not json" ;;
esac
""".replace('__LOG__', argv_log).replace('__MODE__', mode_file)
stub = os.path.join(stubdir, 'aws'); open(stub, 'w').write(STUB); os.chmod(stub, 0o755)
os.environ['PATH'] = stubdir + os.pathsep + os.environ.get('PATH', '')
def setmode(x): open(mode_file, 'w').write(x)
setmode('ok')
srcd = {'name': 'aws-prod', 'type': 'aws-cloudwatch', 'url': 'cli:aws-cloudwatch', 'auth': {'kind': 'none'}, 'project': '', 'demo': False, 'profile': 'prod', 'region': 'us-east-1'}
data = m.aws_read(cfg, srcd, {}, 10)
argv = open(argv_log).read().split()
assert argv[:2] == ['cloudwatch', 'describe-alarms'] and '--profile' in argv and 'prod' in argv and '--region' in argv and 'us-east-1' in argv and '--state-value' in argv, argv
assert [a['service'] for a in data['alerts']] == ['checkout-alb', 'orders-db'] and data['alerts'][0]['severity'] == 'crit' and data['alerts'][1]['severity'] == 'warn', data
assert data['alerts'][0]['since'] and data['alerts'][1]['summary'] == 'CPU 91'
g = m.join([R('aws-prod', [], data['alerts']), R('prom', [S('checkout-alb', 'warn')], [])], cfg, {})
assert [x for x in g if x['name'] == 'checkout-alb'][0]['flag'] == 'AGREE'
setmode('expired')
try: m.aws_read(cfg, srcd, {}, 10); assert False
except m.Fail as e: assert e.kind == 'auth' and 'aws sso login' in e.msg, (e.kind, e.msg)
setmode('junk')
try: m.aws_read(cfg, srcd, {}, 10); assert False
except m.Fail as e: assert e.kind == 'fail'
os.environ['PATH'] = '/nonexistent'; saved = m.CLI_DIRS; m.CLI_DIRS = ()
try: m.aws_read(cfg, srcd, {}, 10); assert False
except m.Fail as e: assert e.kind == 'setup' and 'not installed' in e.msg
m.CLI_DIRS = saved
write('sources.json', json.dumps({'sources': [{'name': 'a', 'type': 'aws-cloudwatch', 'profile': 'x; rm -rf ~'}]}), 0o600)
try: m.read_sources(cfg2); assert False
except m.Fail as e: assert 'profile' in e.msg
write('sources.json', json.dumps({'sources': [{'name': 'a', 'type': 'aws-cloudwatch', 'profile': 'prod', 'region': 'eu-west-1'}]}), 0o600)
sr, _ = m.read_sources(cfg2); assert sr[0]['profile'] == 'prod' and sr[0]['region'] == 'eu-west-1' and sr[0]['auth'] == {'kind': 'none'}
print('CLI LANE OK')

# 14. links: only https (or loopback http), at most {service}; substitution is percent-encoded; links resolve from the sources that know the service
for tpl, ok in [('https://logs.example.com/search?q=service:{service}', 1), ('https://x.example.com/{service}/dash', 1), ('http://localhost:3000/d/x?var-service={service}', 1), ('http://x.example.com/{service}', 0),
                ('https://x.example.com/{host}', 0), ('javascript:alert(1)', 0), ('https://u:p@x.example.com/{service}', 0), ('https://x.example.com/' + 'a' * 600, 0), ('https://x.example.com/{service', 0)]:
    assert bool(m._link_ok(tpl)) == bool(ok), tpl
write('sources.json', json.dumps({'sources': [{'name': 'dd', 'type': 'prometheus', 'url': 'https://prom.example.com', 'links': {'logs': 'https://logs.example.com/s?q=service:{service}', 'open': 'https://dash.example.com/{service}'}}]}), 0o600)
sr, _ = m.read_sources(cfg2); assert sr[0]['links']['logs'].startswith('https://logs.example.com')
write('sources.json', json.dumps({'sources': [{'name': 'dd', 'type': 'prometheus', 'url': 'https://prom.example.com', 'links': {'logs': 'http://evil.example.com/{service}'}}]}), 0o600)
try: m.read_sources(cfg2); assert False
except m.Fail as e: assert 'links must use' in e.msg
write('sources.json', json.dumps({'sources': [{'name': 'dd', 'type': 'prometheus', 'url': 'https://prom.example.com', 'links': {'shell': 'https://x.example.com/{service}'}}]}), 0o600)
try: m.read_sources(cfg2); assert False
except m.Fail as e: assert 'links must use' in e.msg
S2 = {'dd': {'name': 'dd', 'links': {'logs': 'https://logs.example.com/s?q=service:{service}', 'open': 'https://dash.example.com/{service}'}}, 'cr': {'name': 'cr', 'links': {'traces': 'https://t.example.com/{service}'}}}
g = m.join([R('dd', [S('checkout api', 'crit')], []), R('cr', [S('checkout api', 'warn')], [])], cfg, {})
lk = m.links_for(g[0], S2)
assert lk['logs'] == 'https://logs.example.com/s?q=service:checkout%20api' and lk['open'] == 'https://dash.example.com/checkout%20api' and lk['traces'] == 'https://t.example.com/checkout%20api', lk
g = m.join([R('dd', [S('a/b?c=d', 'ok')], [])], cfg, {})
assert m.links_for(g[0], S2)['open'] == 'https://dash.example.com/a%2Fb%3Fc%3Dd'
# 15. trend: names go into PromQL only when plain; a quote or brace never gets in; the answer is parsed defensively
assert m.trend_points(cfg, {'type': 'prometheus'}, {}, 'bad"name}', 5, fx={'range': {}}) == []
assert m.trend_points(cfg, {'type': 'coroot'}, {}, 'ok', 5, fx={'range': {}}) == []
good = {'data': {'result': [{'values': [[1795400000, '1'], [1795400300, '0.5']]}]}}
assert m.trend_points(cfg, {'type': 'prometheus'}, {}, 'checkout', 5, fx={'range': good}) == [(1795400000, 1.0), (1795400300, 0.5)]
assert m.trend_points(cfg, {'type': 'prometheus'}, {}, 'checkout', 5, fx={'range': {'data': {'result': [{'values': [['x', 'y']]}]}}}) == []
# 16. the nav arg for the drill is a plain token even for odd service names
assert all(m.TOKEN.match(x['key']) for x in m.join([R('a', [S('Checkout_API', 'ok'), S('a/b c', 'ok')], [])], cfg, {})), 'nav token'
print('LINKS AND TREND OK')

# 17. the new adapters, on small synthetic answers shaped like the real ones
SPD = {'page': {'name': 'Acme'}, 'status': {'indicator': 'minor', 'description': 'Partially Degraded Service'},
       'components': [{'name': 'API', 'status': 'operational', 'group': False, 'group_id': None}, {'name': 'Core', 'status': 'operational', 'group': True, 'group_id': None},
                      {'name': 'Core: EU', 'status': 'major_outage', 'group': False, 'group_id': 'g1'}, {'name': 'Core: US', 'status': 'operational', 'group': False, 'group_id': 'g1'},
                      {'name': 'Search', 'status': 'degraded_performance', 'group': False, 'group_id': None}],
       'incidents': [{'name': 'EU outage', 'impact': 'critical', 'status': 'investigating', 'created_at': '2026-11-23T01:00:00.000Z', 'incident_updates': [{'body': 'We are looking into it.'}], 'components': [{'name': 'Core: EU'}]},
                     {'name': 'Slow search', 'impact': 'minor', 'status': 'identified', 'created_at': '2026-11-23T02:00:00.000Z', 'incident_updates': [], 'components': []}]}
r = m.statuspage_read(cfg, {'name': 'acme', 'url': 'https://x.example.com'}, {}, 5, fx={'summary': SPD})
names = {x['name']: x['status'] for x in r['services']}
assert names == {'Acme': 'warn', 'API': 'ok', 'Core': 'ok', 'Core: EU': 'crit', 'Search': 'warn'}, names   # a healthy child (Core: US) is left out
assert [(a['name'], a['service'], a['severity']) for a in r['alerts']] == [('EU outage', 'Core: EU', 'crit'), ('Slow search', 'Acme', 'warn')], r['alerts']
assert r['alerts'][0]['since'] and r['alerts'][0]['summary'] == 'We are looking into it.'
# an incident.io style page with no incidents key still reads
r = m.statuspage_read(cfg, {'name': 'x', 'url': 'https://x.example.com'}, {}, 5, fx={'summary': {'page': {'name': 'Y'}, 'status': {'indicator': 'none', 'description': 'ok'}, 'components': [{'name': 'Chat', 'status': 'operational'}]}})
assert r['alerts'] == [] and [x['name'] for x in r['services']] == ['Y', 'Chat']
try: m.statuspage_read(cfg, {'name': 'x', 'url': 'https://x.example.com'}, {}, 5, fx={'summary': {'nope': 1}}); assert False
except m.Fail as e: assert e.kind == 'fail'
ND = {'hostname': 'h1.example.com', 'alarms': {'a.b': {'name': 'disk_full', 'chart': 'disk.sda', 'status': 'CRITICAL', 'value': 97.5, 'units': '%', 'last_status_change': 1795400000, 'info': 'disk almost full'},
                                           'c.d': {'name': 'cpu', 'chart': 'system.cpu', 'status': 'WARNING', 'value': 81, 'units': '%'}, 'e.f': {'name': 'ok_one', 'chart': 'x', 'status': 'CLEAR'}}}
r = m.netdata_read(cfg, {'name': 'nd', 'url': 'https://x.example.com'}, {}, 5, fx={'alarms': ND})
assert r['services'] == [{'name': 'h1.example.com', 'status': 'crit', 'detail': '2 active alarms'}], r['services']
assert sorted((a['name'], a['severity']) for a in r['alerts']) == [('cpu (system.cpu)', 'warn'), ('disk_full (disk.sda)', 'crit')]
assert [a for a in r['alerts'] if a['severity'] == 'warn'][0]['summary'].startswith('cpu on system.cpu: 81')
GR = {'data': {'groups': [{'name': 'g', 'file': 'Payments', 'rules': [{'name': 'High errors', 'state': 'firing', 'labels': {'severity': 'critical', 'service_name': 'checkout'}, 'annotations': {'summary': 'errors up'}, 'alerts': [{'activeAt': '2026-11-23T00:00:00Z'}]},
                                                                      {'name': 'Slow', 'state': 'pending', 'labels': {}, 'annotations': {}, 'alerts': []}, {'name': 'Fine', 'state': 'inactive', 'labels': {}}]},
                                         {'name': 'g2', 'file': 'Search', 'rules': [{'name': 'Fine', 'state': 'inactive', 'labels': {}}]}]}}
r = m.grafana_read(cfg, {'name': 'gf', 'url': 'https://x.example.com'}, {}, 5, fx={'rules': GR})
assert {x['name']: x['status'] for x in r['services']} == {'Payments': 'crit', 'Search': 'ok'}, r['services']
assert [(a['name'], a['service'], a['state']) for a in r['alerts']] == [('High errors', 'checkout', 'firing'), ('Slow', 'Payments', 'pending')], r['alerts']
# pending alerts do not make a service red by themselves in the join, and resolved ones are not firing
g = m.join([R('gf', [S('Payments', 'ok')], [dict(A('Slow', 'Payments', 'warn', now), state='pending')])], cfg, {})
assert g[0]['status'] == 'ok' and not g[0]['firing']
# 18. a Prometheus-compatible server on a path prefix; a server with no alerts endpoint still gives its services
write('sources.json', json.dumps({'sources': [{'name': 'vm', 'type': 'prometheus', 'url': 'https://vm.example.com', 'path': '/select/0/prometheus'}]}), 0o600)
sr, _ = m.read_sources(cfg2); assert sr[0]['prefix'] == '/select/0/prometheus'
for bad in ('/a/../b', 'noslash', '/trail/', '/x y', '/' + 'a' * 120):
    write('sources.json', json.dumps({'sources': [{'name': 'vm', 'type': 'prometheus', 'url': 'https://vm.example.com', 'path': bad}]}), 0o600)
    try: m.read_sources(cfg2); assert False, bad
    except m.Fail as e: assert 'path must look like' in e.msg
UPQ = {'status': 'success', 'data': {'result': [{'metric': {'job': 'api'}, 'value': [1, '1']}, {'metric': {'job': 'api'}, 'value': [1, '0']}]}}
calls = []
def fake(cfg_, src_, hdr_, path, budget):
    calls.append(path)
    if path.endswith('/api/v1/alerts'): raise m.Fail('notfound', 'answered 404')
    return UPQ
orig = m.http_json; m.http_json = fake
try:
    r = m.prom_read(cfg, {'name': 'vm', 'prefix': '/select/0/prometheus', 'url': 'https://vm.example.com'}, {}, 5)
finally: m.http_json = orig
assert calls[0].startswith('/select/0/prometheus/api/v1/query') and calls[1] == '/select/0/prometheus/api/v1/alerts', calls
assert r['services'] == [{'name': 'api', 'status': 'warn', 'detail': '1 of 2 targets up'}] and r['alerts'] == []
def fake_auth(cfg_, src_, hdr_, path, budget): raise m.Fail('auth', 'answered 401')
m.http_json = fake_auth
try: m.prom_read(cfg, {'name': 'vm', 'prefix': '', 'url': 'https://vm.example.com'}, {}, 5); assert False
except m.Fail as e: assert e.kind == 'auth'
finally: m.http_json = orig
# 19. sample mode never writes the real cache
home2 = tempfile.mkdtemp(); os.environ['HOME'] = home2
fxs = m.load_json('fixtures.json'); hub = m.Hub(cfg, True, fxs, [])
srcs_ = [dict(x, auth={'kind': 'none'}, project='', demo=True, links={}, trend_query=None, prefix=x.get('path', '')) for x in cfg['default_sources']]
for s_ in srcs_: assert hub.read(s_, False)['ok'], s_['name']
assert not os.path.exists(os.path.join(home2, 'Library', 'Caches')) or not any(f for _, _, fs in os.walk(os.path.join(home2, 'Library', 'Caches')) for f in fs if 'obs' in f), 'sample wrote a cache'
print('NEW ADAPTERS OK')

# 20. text charts: sparkline and bars
assert m.spark([]) == '' and m.spark([5, 5, 5]) == m.BLOCKS[0] * 3
sp = m.spark([0, 1, 2, 3, 4, 5, 6, 7]); assert sp == m.BLOCKS and len(sp) == 8
assert m.spark([1, 9])[0] == m.BLOCKS[0] and m.spark([1, 9])[-1] == m.BLOCKS[-1]
assert m.bars(0, 5) == '' and m.bars(5, 5, 12) == chr(0x2588) * 12 and len(m.bars(1, 100)) == 1
# 21. pick_trend: a source's own query wins; otherwise the first candidate that varies; a flat series is the last resort
def mkpts(vals): return {'data': {'result': [{'values': [[1795400000 + i * 300, str(v)] for i, v in enumerate(vals)]}]}}
seen = []
def fake_range(cfg_, src_, hdr_, path, budget):
    q = urllib.parse.unquote(path.split('query=')[1].split('&')[0]); seen.append(q)
    if 'http_requests_total' in q: return {'data': {'result': []}}
    if 'process_cpu' in q: return mkpts([3, 3, 3, 3, 3, 3])
    if 'up{' in q: return mkpts([1, 1, 1, 1, 1, 1])
    return mkpts([1, 2, 3, 4, 5, 6])
import urllib.parse
orig = m.http_json; m.http_json = fake_range
try:
    lab, pts = m.pick_trend(cfg, {'type': 'prometheus', 'trend_query': None, 'prefix': ''}, {}, 'api', 5)
    assert lab == 'CPU seconds per second' and len(pts) == 6 and len(seen) == 3, (lab, seen)   # every candidate was flat or empty: the first non-empty one is kept
    seen.clear()
    lab, pts = m.pick_trend(cfg, {'type': 'prometheus', 'trend_query': 'my_metric{job="{service}"}', 'trend_label': 'my metric', 'prefix': ''}, {}, 'api', 5)
    assert lab == 'my metric' and [v for _, v in pts] == [1, 2, 3, 4, 5, 6] and len(seen) == 1 and 'my_metric{job="api"}' in seen[0], (lab, seen)
    assert m.pick_trend(cfg, {'type': 'prometheus', 'trend_query': None, 'prefix': ''}, {}, 'bad"name', 5) == ('', [])   # an unsafe name never reaches a query
finally: m.http_json = orig
# 22. history: one point per run at least a minute apart, capped, and reset when the set of sources changes
os.environ['HOME'] = tempfile.mkdtemp()
h = m.History(cfg, 'a,b')
p1 = h.add({'t': 1000, 'firing': 3, 'crit': 1, 'services': 9, 'ok': 8, 'up': 2}); assert len(p1) == 1
assert len(h.add({'t': 1030, 'firing': 4, 'crit': 1, 'services': 9, 'ok': 8, 'up': 2})) == 1   # too soon
assert len(h.add({'t': 1100, 'firing': 5, 'crit': 2, 'services': 9, 'ok': 7, 'up': 2})) == 2
for i in range(80): h.add({'t': 2000 + i * 100, 'firing': i, 'crit': 0, 'services': 9, 'ok': 9, 'up': 2})
assert len(m.History(cfg, 'a,b').add({'t': 99999, 'firing': 1, 'crit': 0, 'services': 9, 'ok': 9, 'up': 2})) == cfg['history']['keep']
assert len(m.History(cfg, 'a,b,c').add({'t': 100000, 'firing': 1, 'crit': 0, 'services': 9, 'ok': 9, 'up': 2})) == 1   # a different source list starts fresh
# 23. chart, health, table and raw views
res = [R('p', [S('a', 'crit'), S('b', 'ok')], [A('x', 'a', 'crit', now), A('y', 'a', 'warn', now), A('r', 'a', 'warn', now, 'resolved')]), R('q', [S('c', 'warn')], [])]
grp = m.join(res, cfg, {})
rows = m.build('chart', '', res, grp, False, {}, {}); assert [(r['src'], r['n']) for r in rows] == [('p', 2), ('q', 0)], rows
rows = m.build('chart', 'unhealthy', res, grp, False, {}, {}); assert [(r['src'], r['n']) for r in rows] == [('p', 1), ('q', 1)], rows
rows = m.build('table', '', res, grp, False, {}, {}); assert [r['sev'] for r in rows] == ['CRIT', 'WARN'] and rows[0]['alert'] == 'x' and rows[0]['source'] == 'p', rows
# the drill lives in services: arg key.<name>
dr = m.build('services', 'key.a', res, grp, False, {}, {}); assert dr[1]['title'].startswith('a') and any(r['title'] == 'p: CRIT' for r in dr), [r['title'] for r in dr]
assert m.build('services', 'key.nope', res, grp, False, {}, {})[-1]['title'] == 'Service not found'
lst = m.build('services', '', res, grp, False, {}, {}); assert all(r['nav']['view'] == 'services' and r['nav']['arg'].startswith('key.') and m.TOKEN.match(r['nav']['arg']) for r in lst if r.get('nav') and 'view' in r['nav']), lst
# the overview: tiles carry a trend only once there are 3 points
ov = m.overview_rows(res, grp, False, False, [{'t': 1, 'firing': 1, 'crit': 0, 'services': 3, 'ok': 2, 'up': 2}] * 2); assert 'trend' not in ov[2]
ov = m.overview_rows(res, grp, False, False, [{'t': i, 'firing': i, 'crit': 0, 'services': 3, 'ok': 3 - i, 'up': 2} for i in range(4)])
assert ov[2]['kpi_value'] is not None and ov[2]['trend'] == [0, 1, 2, 3] and ov[2]['delta'] == 3 and ov[1]['trend'] == [3, 2, 1, 0], (ov[2].get('trend'), ov[2].get('delta'))
assert [r['nav']['view'] for r in ov if r.get('nav')][-4:] == ['chart', 'chart', 'table', 'overview']   # the last row is Check again
print('RICH PANELS OK')

# 24. Coroot's own Alerts and Risks pages
RAL = [{'rule_name': 'Log errors', 'application_id': 'p:default:Deployment:front-end', 'severity': 'warning', 'summary': 'new error in the logs (35 messages)', 'opened_at': 1795415624000, 'resolved_at': None, 'manually_resolved_at': None, 'suppressed': False},
       {'rule_name': 'Low disk space', 'application_id': 'p:default:StatefulSet:db', 'severity': 'critical', 'summary': '2 volumes over 80%', 'opened_at': '1795283195000', 'resolved_at': None},
       {'rule_name': 'Old', 'application_id': 'p:default:Deployment:x', 'severity': 'warning', 'summary': 'resolved one', 'opened_at': 1795000000000, 'resolved_at': 1795000100000},
       {'rule_name': 'Quiet', 'application_id': 'p:default:Deployment:y', 'severity': 'warning', 'summary': 'suppressed', 'opened_at': 1795000000000, 'suppressed': True}, {'nope': 1}]
RRK = [{'key': {'category': 'Availability', 'type': 'unreplicated-database'}, 'application_id': 'p:default:StatefulSet:cart-db', 'severity': 'critical', 'availability': {'description': 'Redis is not replicated'}},
       {'key': {'type': 'single-instance'}, 'application_id': 'p:default:Deployment:cart', 'severity': 'warning', 'availability': {'description': 'Single instance'}}, {'bad': 1}]
ex = m.coroot_extras(RAL, RRK)
assert [(a['name'], a['service'], a['severity'], a['state']) for a in ex if a['state'] == 'firing'] == [('Log errors', 'front-end', 'warn', 'firing'), ('Low disk space', 'db', 'crit', 'firing')], ex
assert ex[0]['since'] == 1795415624 and ex[1]['since'] == 1795283195 and ex[0]['summary'].startswith('new error')
rk = [a for a in ex if a['state'] == 'risk']
assert [(a['name'], a['service'], a['severity'], a['summary']) for a in rk] == [('Risk: unreplicated database', 'cart-db', 'crit', 'Redis is not replicated'), ('Risk: single instance', 'cart', 'warn', 'Single instance')], rk
# a risk never counts as firing and never turns a service red; the group keeps it apart
g = m.join([R('cr', [S('cart-db', 'ok')], rk)], cfg, {})
cd = [x for x in g if x['name'] == 'cart-db'][0]
assert cd['status'] == 'ok' and not cd['firing'] and len(cd['risks']) == 1
row = m.service_row(cd, {}); assert 'Risks' in row['body'] and 'Redis is not replicated' in row['body'] and '1 risk' in row['subtitle'], row['subtitle']
# the alerts view does not list risks; the drill and the risk filter do
res2 = [R('cr', [S('cart-db', 'ok'), S('front-end', 'warn')], ex)]; g2 = m.join(res2, cfg, {})
assert all(a['state'] != 'risk' for a in [x for x in m.build('alerts', '', res2, g2, False, {}, {}) if False]) 
al_rows = m.build('alerts', '', res2, g2, False, {}, {}); assert not any('Risk:' in r['title'] for r in al_rows), [r['title'] for r in al_rows]
rl = m.build('services', 'risk', res2, g2, False, {}, {}); assert [r['title'] for r in rl if r.get('nav') and 'view' in r['nav']] == ['cart-db'] or 'cart-db' in [r['title'] for r in rl], [r['title'] for r in rl]
dr = m.build('services', 'key.cartdb', res2, g2, False, {}, {}); assert any('Risk: unreplicated database' in r['title'] for r in dr), [r['title'] for r in dr]
# an older Coroot without these endpoints: the adapter keeps working
calls = []
def fake_cr(cfg_, src_, hdr_, path, budget):
    calls.append(path)
    if path.endswith('/api/user'): return {'projects': [{'id': 'abc'}]}
    if path.endswith('overview/applications'): return {'data': {'applications': [{'id': 'abc:default:Deployment:web', 'status': 'ok'}]}}
    if path.endswith('/incidents'): return {'data': []}
    raise m.Fail('notfound', 'answered 404')
orig = m.http_json; m.http_json = fake_cr
try: r = m.coroot_read(cfg, {'name': 'c', 'url': 'https://c.example.com', 'project': ''}, {}, 5)
finally: m.http_json = orig
assert [x['name'] for x in r['services']] == ['web'] and r['alerts'] == [] and any(c.endswith('/alerts') for c in calls) and any(c.endswith('overview/risks') for c in calls), calls
def fake_cr_auth(cfg_, src_, hdr_, path, budget):
    if path.endswith('/alerts'): raise m.Fail('auth', 'answered 401')
    return fake_cr(cfg_, src_, hdr_, path, budget)
m.http_json = fake_cr_auth
try: m.coroot_read(cfg, {'name': 'c', 'url': 'https://c.example.com', 'project': ''}, {}, 5); assert False
except m.Fail as e: assert e.kind == 'auth'
finally: m.http_json = orig
print('COROOT EXTRAS OK')
print('ALL OK')
'''


class ObsExample(unittest.TestCase):
    def test_join_auth_urls_and_cli_lane(self):
        d = tempfile.mkdtemp()
        f = os.path.join(d, "checks.py")
        with open(f, "w", encoding="utf-8") as h:
            h.write(CHECKS)
        env = dict(os.environ, OBS_EXAMPLE_DIR=EX)
        for k in ("PROM_TOKEN", "COROOT_KEY", "P2_PASS"):
            env.pop(k, None)
        r = subprocess.run([sys.executable, "-I", f], env=env, capture_output=True, text=True, timeout=120)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("ALL OK", r.stdout)


if __name__ == "__main__":
    unittest.main()
