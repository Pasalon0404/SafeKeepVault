#!/usr/bin/env python3
"""
safekeep-print — print a SeedQR on a USB laser printer, with no print system.

    safekeep-print.py REQUEST.json RESULT.json

Run by the Print Watcher in safekeep-boot.sh, with the Python in
/opt/safekeep-hwi (it already holds the pinned libusb1 package, installed for
the Trezor). Same request / RAM result / ack files as the Trezor helper.

WHY THIS WAY
  SafeKeep has no print system on purpose: safekeep-harden.sh removes CUPS
  and Ghostscript and bans the kernel's printer drivers (usblp, lp, parport).
  That stays. This helper draws the page itself in PCL, the printer language
  most laser printers understand, and writes it straight to the printer's
  USB printer interface with libusb. No driver, no spooler, no filters, no
  network. Only a USB interface of the printer class (7/1, protocol 1 or 2)
  is ever opened, so the scanner or fax side of a multifunction printer is
  never touched.

SECURITY MODEL
  * The request file is UNTRUSTED DATA written by the browser. It is read
    once, deleted at once, size-limited and validated field by field.
    Nothing in it is run.
  * Only two actions:
      detect -> list the USB printers: name and whether they say they
                understand PCL (from their IEEE 1284 Device ID).
      print  -> print ONE page: the SeedQR given as rows of 0/1, at the size
                asked (10–150 mm wide), optionally the seed fingerprint
                (8 hex digits) under it, and optionally a square cutting
                line around both. No job name or other text is sent.
  * The page is never written to disk: it's built in memory and sent.
  * The result goes to RAM (/tmp/safekeep-signals) and holds no seed data.
  * The printer keeps the page in its own memory until it's overwritten or
    switched off; the app tells the user to switch it off afterwards.

Result JSON: {"ok": true/false, "status": "...", "request_id": ..., ...}
  ok statuses   : detected, printed
  error statuses: bad_request, not_installed, no_printer, multiple_printers,
                  busy, timeout, error
"""
import json
import os
import re
import signal
import sys

MAX_REQUEST_BYTES = 16384
DPI = 600
DOTS_PER_MM = DPI / 25.4
MIN_SIZE_MM = 10.0
MAX_SIZE_MM = 150.0
GRID_SIZES = (21, 25, 29)
TIME_LIMIT_S = 120

# Where the code goes on the page: centred on a line 105 mm from the paper's
# left edge (the middle of A4; 3 mm left of the middle of US Letter), top
# 30 mm down. PCL's x = 0 is the left edge of its logical page, 1/4 inch in.
PAGE_CENTRE_X_MM = 105.0
LOGICAL_LEFT_MM = 6.35
TOP_MM = 30.0


class Fail(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def write_result(path, obj):
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(obj, f)
    os.replace(tmp, path)


def load_request(path):
    try:
        with open(path, 'rb') as f:
            raw = f.read(MAX_REQUEST_BYTES + 1)
    except OSError:
        raise Fail('bad_request', 'Could not read the print request.')
    finally:
        try:
            os.remove(path)
        except OSError:
            pass
    if len(raw) > MAX_REQUEST_BYTES:
        raise Fail('bad_request', 'The print request is too large.')
    try:
        data = json.loads(raw.decode('utf-8'))
    except Exception:
        raise Fail('bad_request', 'The print request is not valid JSON.')
    if not isinstance(data, dict):
        raise Fail('bad_request', 'The print request has the wrong format.')
    return data


# ---------------------------------------------------------------- fields

def field_request_id(data):
    v = data.get('request_id')
    return v if isinstance(v, str) and re.fullmatch(r'[0-9a-f]{8,64}', v) else None


def field_modules(data):
    rows = data.get('modules')
    if not isinstance(rows, list) or len(rows) not in GRID_SIZES:
        raise Fail('bad_request', 'The SeedQR must be 21, 25 or 29 squares across.')
    n = len(rows)
    out = []
    for r in rows:
        if not isinstance(r, str) or len(r) != n or not re.fullmatch(r'[01]+', r):
            raise Fail('bad_request', 'The SeedQR rows are not valid.')
        out.append([c == '1' for c in r])
    return out


def field_size(data):
    v = data.get('size_mm')
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v:
        raise Fail('bad_request', 'The print size is not a number.')
    return max(MIN_SIZE_MM, min(MAX_SIZE_MM, float(v)))


def field_cut_box(data):
    v = data.get('cut_box', False)
    if not isinstance(v, bool):
        raise Fail('bad_request', 'The cutting line must be on or off.')
    return v


def field_fingerprint(data):
    v = data.get('fingerprint', '')
    if v in ('', None):
        return ''
    if not isinstance(v, str) or not re.fullmatch(r'[0-9A-Fa-f]{8}', v):
        raise Fail('bad_request', 'The fingerprint must be 8 hex digits.')
    return v.upper()


# ---------------------------------------------------------------- the page (PCL 5)

def mm(v):
    return int(round(v * DOTS_PER_MM))


def pt_to_dots(p):
    return p * DPI / 72.0


def _font(pt):
    # Courier (typeface 4099), fixed pitch, upright, medium. For a fixed-pitch
    # font the size is set by its pitch: 120 / points characters per inch.
    pitch = 120.0 / pt
    return b'\x1b(8U\x1b(s0p%.2fh0s0b4099T' % pitch


def _text_width(text, pt):
    return len(text) * 0.6 * pt_to_dots(pt)


def _at(x, y):
    return b'\x1b*p%dx%dY' % (int(round(x)), int(round(y)))


def layout(n, size_mm, fingerprint, cut_box=False):
    """Everything about where things go, in 600-dpi dots. Pure, for tests."""
    # The whole code is exactly the size asked (to the dot). Squares are
    # whole dots, so they differ by at most one dot (0.04 mm): square k runs
    # from bounds[k] to bounds[k + 1].
    side = max(2 * n, mm(size_mm))
    bounds = [int(round(k * side / n)) for k in range(n + 1)]
    cell = side / n
    x0 = max(0, mm(PAGE_CENTRE_X_MM - LOGICAL_LEFT_MM) - side // 2)
    y0 = mm(TOP_MM)
    lay = {'n': n, 'cell': cell, 'side': side, 'bounds': bounds, 'x0': x0, 'y0': y0,
           'actual_mm': round(side / DOTS_PER_MM, 2), 'fingerprint': None, 'box': None}
    # With a cutting line, the white margin around the code is the quiet zone
    # scanners need (4 squares), at least 2 mm and at most 10 mm; the
    # fingerprint goes below that margin, inside the box.
    margin = int(round(max(mm(2), min(4 * cell, mm(10))))) if cut_box else 0
    if fingerprint:
        below = y0 + side
        for pt in (10.0, 9.0, 8.0, 7.0, 6.0):
            for text in ('Fingerprint ' + fingerprint, fingerprint):
                if _text_width(text, pt) <= max(side, _text_width(fingerprint, 6.0)):
                    break
            else:
                continue
            break
        w = _text_width(text, pt)
        gap = margin if cut_box else mm(5)
        lay['fingerprint'] = {'text': text, 'pt': pt, 'x': x0 + side / 2 - w / 2,
                              'y': below + gap + pt_to_dots(pt) * 0.75}
    if cut_box:
        # A square: as wide as it is tall, the code centred across it.
        top = y0 - margin
        if lay['fingerprint']:
            bottom = lay['fingerprint']['y'] + pt_to_dots(lay['fingerprint']['pt']) * 0.25 + max(mm(1.5), margin // 2)
        else:
            bottom = y0 + side + margin
        size = int(round(max(bottom - top, side + 2 * margin)))
        left = x0 + side // 2 - size // 2
        lay['box'] = {'x': left, 'y': top, 'size': size, 'line': mm(0.25), 'margin': margin,
                      'size_mm': round(size / DOTS_PER_MM, 1)}
    return lay


def bitmap(modules, lay):
    """The code as rows of packed bits (1 = black)."""
    n, side, b = lay['n'], lay['side'], lay['bounds']
    row_bytes = (side + 7) // 8
    col_of = [0] * side                    # which square each dot column is in
    for k in range(n):
        for x in range(b[k], b[k + 1]):
            col_of[x] = k
    rows = []
    for my in range(n):
        line = bytearray(row_bytes)
        for x in range(side):
            if modules[my][col_of[x]]:
                line[x >> 3] |= 0x80 >> (x & 7)
        rows.extend([bytes(line)] * (b[my + 1] - b[my]))
    return rows, row_bytes


def _rect(x, y, w, h):
    # PCL rectangular area fill, black (0P), at (x, y), w × h in 1/600 inch.
    return _at(x, y) + b'\x1b*c%da%db0P' % (int(round(w)), int(round(h)))


def build_pcl(modules, size_mm, fingerprint, cut_box=False):
    n = len(modules)
    lay = layout(n, size_mm, fingerprint, cut_box)
    rows, row_bytes = bitmap(modules, lay)
    out = bytearray()
    out += b'\x1b%-12345X@PJL ENTER LANGUAGE=PCL\r\n'   # no job name, no other PJL
    out += b'\x1bE'                     # reset
    out += b'\x1b&l0O'                  # portrait
    out += b'\x1b&l0E'                  # no top margin: y = 0 is the top of the page
    out += b'\x1b&u600D'                # positions in 1/600 inch
    out += b'\x1b*t600R'                # raster at 600 dpi
    out += b'\x1b*r0F'                  # raster follows the page orientation
    out += b'\x1b*r%dS' % lay['side']   # raster width
    out += _at(lay['x0'], lay['y0'])
    out += b'\x1b*b0M'                  # no compression
    out += b'\x1b*r1A'                  # start raster at the cursor
    for r in rows:
        out += b'\x1b*b%dW' % row_bytes + r
    out += b'\x1b*rC'                   # end raster
    if lay['fingerprint']:
        f = lay['fingerprint']
        out += _font(f['pt']) + _at(f['x'], f['y']) + f['text'].encode()
    if lay['box']:
        b, t = lay['box'], lay['box']['line']
        out += _rect(b['x'], b['y'], b['size'], t)                  # top
        out += _rect(b['x'], b['y'] + b['size'] - t, b['size'], t)  # bottom
        out += _rect(b['x'], b['y'], t, b['size'])                  # left
        out += _rect(b['x'] + b['size'] - t, b['y'], t, b['size'])  # right
    out += b'\x0c'                      # form feed: print the page
    out += b'\x1bE'
    out += b'\x1b%-12345X'
    return bytes(out), lay


# ---------------------------------------------------------------- USB

def _clean(s, limit=60):
    s = re.sub(r'[^\x20-\x7e]', '', s or '')
    return s.strip()[:limit]


def parse_device_id(raw):
    """IEEE 1284 Device ID: 2-byte big-endian length, then KEY:value; pairs."""
    if not raw or len(raw) < 2:
        return {}
    length = (raw[0] << 8) | raw[1]
    text = bytes(raw[2:max(2, min(len(raw), length))]).decode('latin-1', 'replace')
    out = {}
    for part in text.split(';'):
        if ':' in part:
            k, v = part.split(':', 1)
            out[k.strip().upper()] = v.strip()
    return out


def find_printers(ctx):
    """Every USB printer-class interface with a bulk OUT endpoint."""
    found = []
    for dev in ctx.getDeviceIterator(skip_on_error=True):
        try:
            for ci, cfg in enumerate(dev.iterConfigurations()):
                for iface in cfg:
                    for setting in iface:
                        if setting.getClass() != 7 or setting.getSubClass() != 1 or setting.getProtocol() not in (1, 2):
                            continue
                        out_ep = None
                        for ep in setting:
                            addr = ep.getAddress()
                            if not addr & 0x80 and (ep.getAttributes() & 3) == 2:
                                out_ep = addr
                                break
                        if out_ep is None:
                            continue
                        found.append({'dev': dev, 'config_index': ci,
                                      'interface': setting.getNumber(),
                                      'alt': setting.getAlternateSetting(), 'ep': out_ep})
                        raise StopIteration   # one printer interface per device
        except StopIteration:
            pass
    return found


def describe(p):
    """Name and PCL support, from the printer's Device ID (or USB strings)."""
    name, pcl = '', None
    handle = None
    try:
        handle = p['dev'].open()
        try:
            raw = handle.controlRead(0xA1, 0, p['config_index'], (p['interface'] << 8) | p['alt'], 1023, timeout=2000)
            dev_id = parse_device_id(raw)
        except Exception:
            dev_id = {}
        mfg = dev_id.get('MFG') or dev_id.get('MANUFACTURER') or ''
        mdl = dev_id.get('MDL') or dev_id.get('MODEL') or ''
        cmd = dev_id.get('CMD') or dev_id.get('COMMAND SET')
        if not (mfg or mdl):
            try:
                mfg, mdl = handle.getManufacturer() or '', handle.getProduct() or ''
            except Exception:
                pass
        name = _clean((mfg + ' ' + mdl) if mdl and mfg and mfg.lower() not in mdl.lower() else (mdl or mfg))
        if cmd is not None:
            pcl = bool(re.search(r'\bPCL', cmd, re.I))
    except Exception:
        pass
    finally:
        if handle is not None:
            try:
                handle.close()
            except Exception:
                pass
    return {'name': name or 'USB printer', 'pcl': pcl}


def send(p, data):
    handle = p['dev'].open()
    try:
        try:
            handle.setAutoDetachKernelDriver(True)
        except Exception:
            pass
        handle.claimInterface(p['interface'])
        try:
            if p['alt']:
                handle.setInterfaceAltSetting(p['interface'], p['alt'])
            pos = 0
            while pos < len(data):
                chunk = data[pos:pos + 65536]
                sent = handle.bulkWrite(p['ep'], chunk, timeout=30000)
                if not sent:
                    raise Fail('busy', 'The printer stopped taking data. Check that it is on, has paper, and isn\'t showing an error.')
                pos += sent
        finally:
            try:
                handle.releaseInterface(p['interface'])
            except Exception:
                pass
    finally:
        handle.close()


# ---------------------------------------------------------------- actions

def do_detect(ctx, data):
    printers = [describe(p) for p in find_printers(ctx)]
    return {'ok': True, 'status': 'detected', 'printers': printers}


def do_print(ctx, data):
    modules = field_modules(data)
    size = field_size(data)
    fp = field_fingerprint(data)
    cut_box = field_cut_box(data)
    printers = find_printers(ctx)
    if not printers:
        raise Fail('no_printer', 'No USB printer found. Connect the printer with a USB cable and switch it on.')
    if len(printers) > 1:
        raise Fail('multiple_printers', 'More than one USB printer is connected. Unplug all but the one to use.')
    info = describe(printers[0])
    page, lay = build_pcl(modules, size, fp, cut_box)
    modules = None
    try:
        send(printers[0], page)
    finally:
        page = None
    return {'ok': True, 'status': 'printed', 'printer': info['name'], 'pcl': info['pcl'], 'size_mm': lay['actual_mm'],
            'box_mm': lay['box']['size_mm'] if lay['box'] else None}


def main(argv):
    if len(argv) != 3:
        print('usage: safekeep-print.py REQUEST.json RESULT.json', file=sys.stderr)
        return 2
    req_path, res_path = argv[1], argv[2]
    rid = None

    def on_timeout(signum, frame):
        write_result(res_path, {'ok': False, 'status': 'timeout', 'request_id': rid,
                                'error': 'The printer did not answer in time. Check that it is on and has paper, then try again.'})
        os._exit(1)

    signal.signal(signal.SIGALRM, on_timeout)
    signal.alarm(TIME_LIMIT_S)
    try:
        data = load_request(req_path)
        rid = field_request_id(data)
        action = data.get('action')
        if action not in ('detect', 'print'):
            raise Fail('bad_request', 'Unknown print action.')
        try:
            import usb1
        except Exception:
            raise Fail('not_installed', 'Printing is not installed on this SafeKeep build.')
        with usb1.USBContext() as ctx:
            result = do_detect(ctx, data) if action == 'detect' else do_print(ctx, data)
    except Fail as e:
        result = {'ok': False, 'status': e.status, 'error': e.message}
    except Exception as e:
        result = {'ok': False, 'status': 'error', 'error': 'Printing failed: ' + _clean(type(e).__name__ + ' ' + str(e), 160)}
    result['request_id'] = rid
    write_result(res_path, result)
    return 0 if result.get('ok') else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv))
