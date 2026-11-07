#!/usr/bin/env python3
"""
Tests for usbbootdrive/safekeep-print.py with a FAKE printer.

    python3 usbbootdrive/tests/test-print-helper.py

No hardware needed. A fake `usb1` package is generated in a temp dir and put
first on PYTHONPATH; the USB devices it shows are chosen per test via the
FAKE_USB env var, and whatever the helper sends to the printer is written to
FAKE_USB_OUT. The PCL sent is parsed back into a picture and checked square
by square against the SeedQR.
"""
import json, os, re, subprocess, sys, tempfile, importlib.util

HERE = os.path.dirname(os.path.abspath(__file__))
HELPER = os.path.join(HERE, '..', 'safekeep-print.py')

FAKE_USB1 = r'''
import json, os
_CONF = json.loads(os.environ.get('FAKE_USB', '{"devices": []}'))
class _EP:
    def __init__(s, a, at): s.a, s.at = a, at
    def getAddress(s): return s.a
    def getAttributes(s): return s.at
class _Setting:
    def __init__(s, d): s.d = d
    def getClass(s): return s.d.get('class', 7)
    def getSubClass(s): return s.d.get('sub', 1)
    def getProtocol(s): return s.d.get('proto', 2)
    def getNumber(s): return s.d.get('iface', 0)
    def getAlternateSetting(s): return s.d.get('alt', 0)
    def __iter__(s): return iter([_EP(0x81, 2), _EP(s.d.get('out_ep', 0x02), 2)] if s.d.get('out', True) else [_EP(0x81, 2)])
class _Iface:
    def __init__(s, d): s.d = d
    def __iter__(s): return iter([_Setting(s.d)])
class _Cfg:
    def __init__(s, d): s.d = d
    def __iter__(s): return iter([_Iface(s.d)])
class _Handle:
    def __init__(s, d): s.d = d
    def controlRead(s, rt, req, val, idx, length, timeout=0):
        assert rt == 0xA1 and req == 0, 'GET_DEVICE_ID only'
        t = s.d.get('devid', '').encode()
        if not t: raise IOError('stall')
        return bytes([(len(t) + 2) >> 8, (len(t) + 2) & 255]) + t
    def getManufacturer(s): return s.d.get('mfg', 'Acme')
    def getProduct(s): return s.d.get('product', 'Laser 1')
    def setAutoDetachKernelDriver(s, on): pass
    def claimInterface(s, n):
        if s.d.get('busy_claim'): raise IOError('busy')
        open(os.environ['FAKE_USB_OUT'] + '.claimed', 'a').write('%d\n' % n)
    def releaseInterface(s, n): pass
    def setInterfaceAltSetting(s, n, a): pass
    def bulkWrite(s, ep, data, timeout=0):
        if s.d.get('stuck'): return 0
        with open(os.environ['FAKE_USB_OUT'], 'ab') as f: f.write(bytes(data))
        return len(data)
    def close(s): pass
class _Dev:
    def __init__(s, d): s.d = d
    def iterConfigurations(s): return iter([_Cfg(s.d)])
    def open(s): return _Handle(s.d)
class USBContext:
    def __enter__(s): return s
    def __exit__(s, *a): return False
    def getDeviceIterator(s, skip_on_error=False):
        return iter([_Dev(d) for d in _CONF['devices']])
'''

passed = failed = 0
def ck(name, cond, extra=''):
    global passed, failed
    if cond: passed += 1
    else: failed += 1
    print('  [%s] %s%s' % ('PASS' if cond else 'FAIL', name, ('  -> ' + str(extra)) if (extra and not cond) else ''))

spec = importlib.util.spec_from_file_location('skprint', HELPER)
P = importlib.util.module_from_spec(spec)
spec.loader.exec_module(P)

# A real 21x21 SeedQR-like grid: finder patterns + a pseudo-random fill.
def sample_modules(n=21, seed=7):
    m = [[((r * 31 + c * 17 + seed) * 2654435761 >> 7) & 1 == 1 for c in range(n)] for r in range(n)]
    for (r0, c0) in ((0, 0), (0, n - 7), (n - 7, 0)):
        for r in range(7):
            for c in range(7):
                m[r0 + r][c0 + c] = r in (0, 6) or c in (0, 6) or (2 <= r <= 4 and 2 <= c <= 4)
    return m

def rows01(m):
    return [''.join('1' if v else '0' for v in r) for r in m]

# ---- a small PCL reader: raster rows at their position, and text at its position
def read_pcl(data):
    i, x, y = 0, 0, 0
    raster, texts, cmds, rects = None, [], [], []
    cw = ch = 0
    pjl = []
    width = None
    while i < len(data):
        b = data[i]
        if data.startswith(b'\x1b%-12345X', i):
            i += 9; cmds.append('UEL'); continue
        if data.startswith(b'@PJL', i):
            j = data.index(b'\n', i); pjl.append(data[i:j].decode().strip()); i = j + 1; continue
        if b == 0x1b:
            if data[i + 1] == ord('E'):
                cmds.append('E'); i += 2; continue
            par, grp = chr(data[i + 1]), chr(data[i + 2])
            j = i + 3
            while True:
                m = re.match(rb'([+-]?[0-9.]*)([a-zA-Z@])', data[j:j + 20])
                val, term = m.group(1).decode(), chr(m.group(2)[0])
                j += m.end()
                key = par + grp + term.upper()
                cmds.append(key + val)
                if key == '*pX': x = int(val)
                elif key == '*pY': y = int(val)
                elif key == '*rS': width = int(val)
                elif key == '*cA': cw = int(val)
                elif key == '*cB': ch = int(val)
                elif key == '*cP': rects.append((x, y, cw, ch, int(val)))
                elif key == '*rA': raster = {'x': x, 'y': y, 'rows': [], 'width': width}
                elif key == '*bW':
                    n = int(val); raster['rows'].append(data[j:j + n]); j += n
                if term.isupper(): break
            i = j
            continue
        if b == 0x0c:
            cmds.append('FF'); i += 1; continue
        j = i
        while j < len(data) and data[j] not in (0x1b, 0x0c):
            j += 1
        texts.append((data[i:j].decode('latin-1'), x, y))
        i = j
    return {'raster': raster, 'texts': texts, 'cmds': cmds, 'pjl': pjl, 'rects': rects}

def pixel(r, px, py):
    row = r['rows'][py]
    return bool(row[px >> 3] & (0x80 >> (px & 7)))

print('\n1. The page')
m = sample_modules()
page, lay = P.build_pcl(m, 85.68, '5436D724')
doc = read_pcl(page)
r = doc['raster']
ck('PCL job: UEL, PJL ENTER LANGUAGE=PCL only (no job name), reset, form feed, reset, UEL',
   doc['cmds'][0] == 'UEL' and doc['pjl'] == ['@PJL ENTER LANGUAGE=PCL'] and doc['cmds'][1] == 'E' and doc['cmds'][-3:] == ['FF', 'E', 'UEL'], doc['pjl'])
ck('600 dpi raster, positions in 1/600 inch', '*tR600' in doc['cmds'] and '&uD600' in doc['cmds'])
cell = lay['cell']
B = lay['bounds']
ck('85.68 mm asked → %.2f mm, exact to the dot; squares differ by at most one dot' % lay['actual_mm'], abs(lay['actual_mm'] - 85.68) < 0.05 and max(B[k + 1] - B[k] for k in range(21)) - min(B[k + 1] - B[k] for k in range(21)) <= 1)
ck('raster is the code\'s exact size', len(r['rows']) == lay['side'] and r['width'] == lay['side'] == P.mm(85.68))
mid_of = lambda k: (B[k] + B[k + 1]) // 2
ok = all(pixel(r, mid_of(c), mid_of(rr)) == m[rr][c] for rr in range(21) for c in range(21))
ck('every square matches the SeedQR (sampled at its centre)', ok)
ck('…even at the corners of each square (no grid lines)', all(pixel(r, B[c], B[rr]) == m[rr][c] and pixel(r, B[c + 1] - 1, B[rr + 1] - 1) == m[rr][c] for rr in range(21) for c in range(21)))
fp = [(s, x, y) for (s, x, y) in doc['texts'] if 'D724' in s]
ck('fingerprint printed under the code, centred', len(fp) == 1 and fp[0][0] == 'Fingerprint 5436D724' and fp[0][2] > r['y'] + lay['side'] and abs((fp[0][1] + P._text_width(fp[0][0], 10.0) / 2) - (r['x'] + lay['side'] / 2)) < 2, fp)
ck('code centred on the page line (105 mm), 30 mm down', abs(r['x'] + lay['side'] / 2 - P.mm(105 - 6.35)) <= 1 and r['y'] == P.mm(30))
ck('no other text on the page (no numbers, no job name)', [s for (s, _, _) in doc['texts']] == ['Fingerprint 5436D724'])

page2, lay2 = P.build_pcl(m, 85.68, '')
d2 = read_pcl(page2)
ck('without the fingerprint: no text at all', not d2['texts'])

page3, lay3 = P.build_pcl(m, 14, 'ABCDEF01')
d3 = read_pcl(page3)
B3 = lay3['bounds']
ck('14 mm (the owner\'s laptop camera reads it): every square matches', abs(lay3['actual_mm'] - 14) < 0.05 and all(pixel(d3['raster'], (B3[c] + B3[c + 1]) // 2, (B3[rr] + B3[rr + 1]) // 2) == m[rr][c] for rr in range(21) for c in range(21)))
fp3 = [s for (s, _, _) in d3['texts']]
ck('…the fingerprint shrinks or drops the word to fit', fp3 and fp3[0] in ('ABCDEF01', 'Fingerprint ABCDEF01'), fp3)
ck('size limits: 10–150 mm', P.field_size({'size_mm': 3}) == 10 and P.field_size({'size_mm': 999}) == 150)
lay4 = P.layout(29, 150, '')
ck('29×29 at 150 mm fits across A4 (and Letter)', P.mm(6.35) + lay4['x0'] + lay4['side'] <= P.mm(210 - 4))

print('\n1b. The cutting line')
def box_of(d):
    rs = d['rects']
    if len(rs) != 4: return None
    xs = [r[0] for r in rs] + [r[0] + r[2] for r in rs]
    ys = [r[1] for r in rs] + [r[1] + r[3] for r in rs]
    return min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)
ck('no cutting line unless asked', not read_pcl(P.build_pcl(m, 30, 'ABCDEF01')[0])['rects'])
for size, fpv in ((14, 'ABCDEF01'), (14, ''), (85.68, '5436D724'), (150, '5436D724')):
    pg, ly = P.build_pcl(m, size, fpv, True)
    dd = read_pcl(pg)
    bx = box_of(dd)
    rr = dd['raster']
    side = ly['side']
    ok_square = bx and bx[2] == bx[3] == ly['box']['size']
    ok_black = all(r[4] == 0 for r in dd['rects']) and all(min(r[2], r[3]) == P.mm(0.25) for r in dd['rects'])
    margin = ly['box']['margin']
    inside = bx and bx[0] + margin <= rr['x'] + 1 and rr['x'] + side <= bx[0] + bx[2] - margin + 1 and bx[1] + margin == rr['y'] and rr['y'] + side + margin <= bx[1] + bx[3]
    qz = margin >= min(4 * ly['cell'], P.mm(10)) - 1 and margin >= P.mm(2)
    fpt = [(s2, x2, y2) for (s2, x2, y2) in dd['texts']]
    fp_in = (not fpv and not fpt) or (fpt and bx and bx[0] < fpt[0][1] and fpt[0][1] + P._text_width(fpt[0][0], ly['fingerprint']['pt']) < bx[0] + bx[2] and rr['y'] + side + margin <= fpt[0][2] < bx[1] + bx[3])
    page_ok = bx and P.mm(6.35) + bx[0] + bx[2] <= P.mm(210 - 4) and bx[1] > 0
    ck('%s mm%s: a square %.1f mm line (0.25 mm, black) around code%s, a %.1f mm quiet zone inside, on the page' % (size, ' + fingerprint' if fpv else '', ly['box']['size_mm'], ' and fingerprint' if fpv else '', margin / P.DOTS_PER_MM),
       ok_square and ok_black and inside and qz and fp_in and page_ok, (bx, ly['box'], fpt))
B14 = P.layout(21, 14, 'ABCDEF01', True)['bounds']
pg14 = read_pcl(P.build_pcl(m, 14, 'ABCDEF01', True)[0])
ck('…and the code itself is unchanged', all(pixel(pg14['raster'], (B14[c] + B14[c + 1]) // 2, (B14[rr2] + B14[rr2 + 1]) // 2) == m[rr2][c] for rr2 in range(21) for c in range(21)))

print('\n2. Requests are checked')
def bad(d):
    try:
        P.field_modules(d); return False
    except P.Fail:
        return True
ck('grid must be 21, 25 or 29 rows of 0/1 of the same length', bad({'modules': ['01'] * 20}) and bad({'modules': ['0' * 21] * 20 + ['0' * 20]}) and bad({'modules': ['0' * 20 + 'x'] * 21}) and bad({'modules': 'nope'}))
def bad_f(fn, d):
    try:
        fn(d); return False
    except P.Fail:
        return True
ck('there is no style any more (code only)', not hasattr(P, 'field_style'))
ck('cut_box must be true or false', P.field_cut_box({}) is False and P.field_cut_box({'cut_box': True}) is True and bad_f(P.field_cut_box, {'cut_box': 'yes'}))
ck('fingerprint: 8 hex digits or nothing', P.field_fingerprint({'fingerprint': 'abcdef01'}) == 'ABCDEF01' and P.field_fingerprint({}) == '' and bad_f(P.field_fingerprint, {'fingerprint': 'ABC;rm'}))
ck('size must be a number', bad_f(P.field_size, {'size_mm': '50'}) and bad_f(P.field_size, {'size_mm': True}))
ck('Device ID parsing', P.parse_device_id(b'\x00\x2bMFG:Samsung;CMD:SPL,PCL6;MDL:M2070 Series;') == {'MFG': 'Samsung', 'CMD': 'SPL,PCL6', 'MDL': 'M2070 Series'})

print('\n3. Run for real, against a fake printer')
tmp = tempfile.mkdtemp()
pkg = os.path.join(tmp, 'fake')
os.makedirs(pkg)
open(os.path.join(pkg, 'usb1.py'), 'w').write(FAKE_USB1)

def run(req, devices, raw=None):
    rq, rs, out = os.path.join(tmp, 'PRINT_REQUEST.json'), os.path.join(tmp, 'RESULT.json'), os.path.join(tmp, 'printer.bin')
    for f in (rs, out, out + '.claimed'):
        if os.path.exists(f): os.remove(f)
    with open(rq, 'w') as f:
        f.write(raw if raw is not None else json.dumps(req))
    env = dict(os.environ, PYTHONPATH=pkg, FAKE_USB=json.dumps({'devices': devices}), FAKE_USB_OUT=out, PYTHONDONTWRITEBYTECODE='1')
    subprocess.run([sys.executable, HELPER, rq, rs], env=env, capture_output=True, timeout=60)
    res = json.load(open(rs))
    sent = open(out, 'rb').read() if os.path.exists(out) else b''
    claimed = open(out + '.claimed').read() if os.path.exists(out + '.claimed') else ''
    return res, sent, claimed, os.path.exists(rq)

RID = 'abcdef0123456789'
samsung = {'class': 7, 'sub': 1, 'proto': 2, 'iface': 0, 'devid': 'MFG:Samsung;CMD:SPL,PCL6,PJL;MDL:M2070 Series;'}
scanner = {'class': 255, 'sub': 255, 'proto': 255, 'iface': 1}
keyboard = {'class': 3, 'sub': 1, 'proto': 1}
res, sent, _, left = run({'action': 'detect', 'request_id': RID}, [keyboard, scanner, samsung])
ck('detect: only the printer interface, named from its Device ID, PCL: yes', res.get('ok') and res['printers'] == [{'name': 'Samsung M2070 Series', 'pcl': True}] and res['request_id'] == RID, res)
ck('…the request file is deleted on read', not left)
res, _, _, _ = run({'action': 'detect', 'request_id': RID}, [{'class': 7, 'sub': 1, 'proto': 2, 'devid': 'MFG:Acme;CMD:SPL;MDL:GDI 9;'}])
ck('detect: a printer that lists no PCL says so', res['printers'] == [{'name': 'Acme GDI 9', 'pcl': False}], res)
res, _, _, _ = run({'action': 'detect', 'request_id': RID}, [{'class': 7, 'sub': 1, 'proto': 2, 'devid': '', 'mfg': 'HP', 'product': 'LaserJet 1020'}])
ck('detect: no Device ID → USB name, PCL unknown', res['printers'] == [{'name': 'HP LaserJet 1020', 'pcl': None}], res)
res, _, _, _ = run({'action': 'detect', 'request_id': RID}, [{'class': 7, 'sub': 1, 'proto': 4}])
ck('detect: an IPP-over-USB interface is not used', res['printers'] == [], res)

req = {'action': 'print', 'request_id': RID, 'modules': rows01(m), 'size_mm': 60, 'fingerprint': '5436d724'}
res, sent, claimed, left = run(req, [scanner, samsung])
d = read_pcl(sent)
Bs = P.layout(21, 60, '')['bounds']
ok = d['raster'] and all(pixel(d['raster'], (Bs[c] + Bs[c + 1]) // 2, (Bs[rr] + Bs[rr + 1]) // 2) == m[rr][c] for rr in range(21) for c in range(21))
ck('print: the page reaches the printer, square for square', res.get('ok') and res['status'] == 'printed' and ok, res)
ck('…only the printer interface was claimed (not the scanner)', claimed.strip() == '0', claimed)
res_b, sent_b, _, _ = run(dict(req, cut_box=True), [samsung])
ck('print with the cutting line: four black rules reach the printer, and the result gives the box size', res_b.get('ok') and len(read_pcl(sent_b)['rects']) == 4 and res_b.get('box_mm') and res_b['box_mm'] > 60, res_b)
ck('…the result names the printer and the real size, and holds no seed data', res['printer'] == 'Samsung M2070 Series' and abs(res['size_mm'] - 60) < 0.05 and 'modules' not in json.dumps(res) and '5436' not in json.dumps(res), res)
ck('…the request is deleted', not left)
res, sent, _, _ = run(req, [])
ck('print with no printer: no_printer, nothing sent', res['status'] == 'no_printer' and not sent, res)
res, sent, _, _ = run(req, [samsung, dict(samsung, iface=0)])
ck('two printers: refused', res['status'] == 'multiple_printers' and not sent, res)
res, sent, _, _ = run(req, [dict(samsung, stuck=True)])
ck('a printer that stops taking data: busy', res['status'] == 'busy', res)
res, sent, _, _ = run(dict(req, modules=rows01(m)[:20]), [samsung])
ck('a bad grid: bad_request, nothing sent', res['status'] == 'bad_request' and not sent, res)
res, sent, _, _ = run(None, [samsung], raw='{"action": "print", "x": "' + 'A' * 20000 + '"}')
ck('an oversized request: bad_request', res['status'] == 'bad_request' and not sent, res)
res, sent, _, _ = run({'action': 'poweroff', 'request_id': RID}, [samsung])
ck('an unknown action: bad_request', res['status'] == 'bad_request' and not sent, res)
env = dict(os.environ, PYTHONPATH=tmp + '/nothing')
rq, rs = os.path.join(tmp, 'R.json'), os.path.join(tmp, 'S.json')
open(rq, 'w').write(json.dumps({'action': 'detect', 'request_id': RID}))
subprocess.run([sys.executable, '-I', HELPER, rq, rs], env=env, capture_output=True)
ck('without libusb1: not_installed', json.load(open(rs))['status'] == 'not_installed')

print('\n4. The Print Watcher in safekeep-boot.sh, run for real')
import time, signal
boot = open(os.path.join(HERE, '..', 'safekeep-boot.sh')).read()
start = boot.index('    # -------------------------------------------------------------------\n    # PRINT WATCHER')
block = boot[start:boot.index('    PRINT_WATCHER_PID=$!')]
dl, sig = os.path.join(tmp, 'dl'), os.path.join(tmp, 'sig')
os.makedirs(dl); os.makedirs(sig)
script = os.path.join(tmp, 'w.sh')
open(script, 'w').write('set -uo pipefail\nCHROMIUM_DOWNLOAD_DIR=%s\nSIGNAL_DIR=%s\n' % (json.dumps(dl), json.dumps(sig))
    + block.replace('/opt/safekeep-hwi/bin/python3', sys.executable).replace('/usr/local/lib/safekeep/safekeep-print.py', os.path.abspath(HELPER)) + '    wait\n')
out = os.path.join(tmp, 'printer.bin')
if os.path.exists(out): os.remove(out)
env = dict(os.environ, PYTHONPATH=pkg, FAKE_USB=json.dumps({'devices': [samsung]}), FAKE_USB_OUT=out)
w = subprocess.Popen(['bash', script], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
try:
    time.sleep(0.5)
    open(os.path.join(dl, 'PRINT_REQUEST.json'), 'w').write(json.dumps(dict(req, size_mm=30)))
    res_path = os.path.join(sig, 'PRINT_RESULT.json')
    for _ in range(60):
        if os.path.exists(res_path): break
        time.sleep(0.25)
    res = json.load(open(res_path)) if os.path.exists(res_path) else {}
    ck('request → helper → printer, result in the RAM signal folder', res.get('status') == 'printed' and os.path.getsize(out) > 1000, res)
    ck('…the request (which holds the SeedQR) is gone', not os.path.exists(os.path.join(dl, 'PRINT_REQUEST.json')))
    open(os.path.join(dl, 'PRINT_ACK.json'), 'w').write('{"ack":true}')
    for _ in range(20):
        if not os.path.exists(res_path): break
        time.sleep(0.25)
    ck('…after the ack, the result and the ack are removed', not os.path.exists(res_path) and not os.listdir(dl), os.listdir(dl))
finally:
    os.killpg(w.pid, signal.SIGTERM)

print('\n%d passed, %d failed' % (passed, failed))
sys.exit(1 if failed else 0)
