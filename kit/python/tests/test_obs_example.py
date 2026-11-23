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
