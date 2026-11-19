"""
Tests for usbbootdrive/safekeep-documents.py (DOCUMENTS_DESIGN.md).

    PYTHONDONTWRITEBYTECODE=1 python3 usbbootdrive/tests/test-documents-helper.py

Runs the helper as the File Router does, on temporary folders standing in
for the vault's seeds/ (where the app's downloads land) and documents/.
"""
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
HELPER = os.path.join(HERE, '..', 'safekeep-documents.py')

passed = failed = 0


def ck(name, ok, detail=''):
    global passed, failed
    if ok:
        passed += 1
        print('  [PASS] ' + name)
    else:
        failed += 1
        print('  [FAIL] ' + name + ('  → ' + str(detail) if detail else ''))


root = tempfile.mkdtemp(prefix='skdoc-')
INC = os.path.join(root, 'seeds')
DOCS = os.path.join(root, 'documents')
ERR = os.path.join(root, 'errors.json')
os.makedirs(INC)


def run(*args):
    r = subprocess.run([sys.executable, '-I', HELPER] + list(args), capture_output=True, text=True)
    return r


def route():
    return run('route', INC, DOCS, ERR)


def index():
    with open(os.path.join(DOCS, '.documents-index.json')) as f:
        return json.load(f)


def put(name, data):
    p = os.path.join(INC, name)
    with open(p, 'wb') as f:
        f.write(data if isinstance(data, bytes) else data.encode('utf-8'))
    return p


def send(doc_id, name, data, **over):
    meta = {'name': name, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest(), 'added': '2026-11-18T12:00:00Z'}
    meta.update(over)
    put('SKDOC-%s.skmeta' % doc_id, json.dumps(meta))
    put('SKDOC-%s.skbin' % doc_id, data)


def ids():
    return [d['id'] for d in index()['documents']]


PDF = b'%PDF-1.7\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n'
PNG = b'\x89PNG\r\n\x1a\n' + b'\x00' * 40
JPG = b'\xff\xd8\xff\xe0' + b'\x00' * 40
GIF = b'GIF89a' + b'\x00' * 20
WEBP = b'RIFF\x10\x00\x00\x00WEBPVP8 ' + b'\x00' * 20
TXT = 'Letter to my family\n\nThe seed backup is in the safe. Café ✓\n'.encode('utf-8')

print('1. Importing')
send('a' * 16, 'Letter of instruction.pdf', PDF)
r = route()
ck('route runs', r.returncode == 0, r.stderr)
ix = index()
ck('the document is in the index', ids() == ['a' * 16], ix)
d = ix['documents'][0]
ck('name, extension, kind, size and hash recorded',
   d['name'] == 'Letter of instruction.pdf' and d['ext'] == 'pdf' and d['kind'] == 'pdf' and d['size'] == len(PDF)
   and d['sha256'] == hashlib.sha256(PDF).hexdigest(), d)
ck('the bytes are stored unchanged as <id>.pdf', open(os.path.join(DOCS, 'a' * 16 + '.pdf'), 'rb').read() == PDF)
ck('the request files are gone', os.listdir(INC) == [], os.listdir(INC))
ck('the index reports free and total space', ix['free'] > 0 and ix['total'] >= ix['free'])

for i, (data, name, kind) in enumerate([(PNG, 'scan.PNG', 'png'), (JPG, 'photo.jpg', 'jpeg'), (GIF, 'a.gif', 'gif'),
                                         (WEBP, 'b.webp', 'webp'), (TXT, 'notes.txt', 'text'), (TXT, 'readme.md', 'text')]):
    send('%016x' % (0x100 + i), name, data)
route()
kinds = {d['name']: d['kind'] for d in index()['documents']}
ck('PNG, JPEG, GIF, WebP and text are recognized from their bytes',
   kinds.get('scan.PNG') == 'png' and kinds.get('photo.jpg') == 'jpeg' and kinds.get('a.gif') == 'gif'
   and kinds.get('b.webp') == 'webp' and kinds.get('notes.txt') == 'text' and kinds.get('readme.md') == 'text', kinds)

send('b' * 16, 'not really.pdf', b'<html><script>alert(1)</script>')
send('c' * 16, 'drawing.svg', b'<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script></svg>')
send('d' * 16, 'Will.docx', b'PK\x03\x04' + b'\x00' * 30)
send('e' * 16, 'binary.txt', b'abc\x00def')
send('f' * 16, 'no extension', b'hello')
route()
kinds = {d['name']: (d['kind'], d['ext']) for d in index()['documents']}
ck('a .pdf that isn\'t a PDF is "other"', kinds.get('not really.pdf') == ('other', 'pdf'), kinds.get('not really.pdf'))
ck('SVG is stored but "other" (never shown)', kinds.get('drawing.svg') == ('other', 'svg'))
ck('.docx is stored as "other"', kinds.get('Will.docx') == ('other', 'docx'))
ck('a .txt with NUL bytes is "other"', kinds.get('binary.txt') == ('other', 'txt'))
ck('no extension: stored as .bin', kinds.get('no extension') == ('other', 'bin'))

print('2. Waiting and refusing')
put('SKDOC-%s.skmeta' % ('1' * 16), json.dumps({'name': 'x.txt', 'size': 5, 'sha256': hashlib.sha256(b'hello').hexdigest()}))
route()
ck('metadata alone waits for its bytes', os.path.exists(os.path.join(INC, 'SKDOC-%s.skmeta' % ('1' * 16))) and '1' * 16 not in ids())
put('SKDOC-%s.skbin' % ('1' * 16), b'hel')
route()
ck('bytes still arriving (too short) wait', os.path.exists(os.path.join(INC, 'SKDOC-%s.skbin' % ('1' * 16))) and '1' * 16 not in ids())
put('SKDOC-%s.skbin' % ('1' * 16), b'hello')
route()
ck('then it is imported', '1' * 16 in ids())

send('2' * 16, 'x.txt', b'hello', sha256='0' * 64)
route()
ix = index()
ck('a wrong checksum is refused and reported', '2' * 16 not in ids() and 'damaged' in ix['errors'].get('2' * 16, ''), ix['errors'])
ck('and its request files removed', not any(n.startswith('SKDOC-' + '2' * 16) for n in os.listdir(INC)))

send('3' * 16, 'x' * 201, b'hello')
send('4' * 16, '   ', b'hello')
route()
e = index()['errors']
ck('a name over 200 characters or blank is refused', 'name' in e.get('3' * 16, '') and 'name' in e.get('4' * 16, ''), e)

big = 100 * 1024 * 1024 + 1
put('SKDOC-%s.skmeta' % ('5' * 16), json.dumps({'name': 'big.bin', 'size': big, 'sha256': '0' * 64}))
put('SKDOC-%s.skbin' % ('5' * 16), b'x')
route()
ck('over 100 MB is refused before reading it', '100 MB' in index()['errors'].get('5' * 16, ''), index()['errors'])

put('SKDOC-%s.skmeta' % ('6' * 16), '{not json')
put('SKDOC-%s.skbin' % ('6' * 16), b'x')
route()
ck('unreadable metadata is refused', 'unreadable' in index()['errors'].get('6' * 16, ''))

send('a' * 16, 'again.pdf', PDF)
route()
ck('an ID that already exists is refused (never overwritten)', index()['errors'].get('a' * 16, '').startswith('A document with this ID')
   and {d['id']: d['name'] for d in index()['documents']}['a' * 16] == 'Letter of instruction.pdf')

for bad in ['SKDOC-../../etc.skbin', 'SKDOC-ABCDEF0123456789.skbin', 'SKDOC-abc.skbin', 'skdoc-%s.skbin' % ('7' * 16),
            'SKDOC-%s.skbin.crdownload' % ('7' * 16), 'master-seed.json']:
    try:
        put(bad, b'x')
    except OSError:
        pass
route()
left = sorted(os.listdir(INC))
ck('names that don\'t match the pattern are never touched', 'master-seed.json' in left and 'SKDOC-%s.skbin.crdownload' % ('7' * 16) in left
   and 'SKDOC-ABCDEF0123456789.skbin' in left, left)
for n in left:
    os.remove(os.path.join(INC, n))

p = put('SKDOC-%s.skbin' % ('8' * 16), b'half')
os.utime(p, (time.time() - 3600, time.time() - 3600))
route()
ck('half an import left over 15 minutes is given up on', not os.path.exists(p) and 'never finished' in index()['errors'].get('8' * 16, ''))

print('3. Rename and delete')
put('SKDOC-%s.skren' % ('a' * 16), json.dumps({'name': 'Letter for Mom.pdf'}))
route()
names = {d['id']: d['name'] for d in index()['documents']}
ck('rename changes the name only', names['a' * 16] == 'Letter for Mom.pdf' and os.path.exists(os.path.join(DOCS, 'a' * 16 + '.pdf')))
ck('a successful request clears that ID\'s old error', 'a' * 16 not in index()['errors'])
put('SKDOC-%s.skren' % ('9' * 16), json.dumps({'name': 'x'}))
route()
ck('renaming a missing document is reported', 'no longer' in index()['errors'].get('9' * 16, ''))
put('SKDOC-%s.skdel' % ('a' * 16), b'')
route()
ck('delete removes its bytes and metadata', 'a' * 16 not in ids() and not any(n.startswith('a' * 16) for n in os.listdir(DOCS)))
ck('other documents are untouched', len(ids()) == 12, len(ids()))

print('3b. The names list for 7-Zip users')
NAMES = os.path.join(DOCS, 'README - document names.txt')
raw = open(NAMES, 'rb').read()
names_txt = raw.decode('utf-8')
ck('the list exists, in UTF-8 with Windows line endings', b'\r\n' in raw and b'\n' not in raw.replace(b'\r\n', b''))
line = [l for l in names_txt.split('\r\n') if 'Letter for Mom' in l]
ck('a deleted document is gone from it', not line, line)
line = [l for l in names_txt.split('\r\n') if l.startswith('%016x.' % 0x104)]
ck('each line gives the file, its real name, size and date',
   line and 'notes.txt' in line[0] and '(%d bytes, added Nov 18, 2026)' % len(TXT) in line[0], line)
send('7' * 16, 'Lettre à Maman.txt', 'Café ✓'.encode('utf-8'))
route()
ck('a new document appears in it, accents and all', 'Lettre à Maman.txt' in open(NAMES, encoding='utf-8').read())
ck('the list never counts as a document', NAMES.rsplit('/', 1)[-1] not in [d['id'] for d in index()['documents']] and len(ids()) == 13, len(ids()))
put('SKDOC-%s.skdel' % ('7' * 16), b'')
route()

print('3c. OpenDocument text (.odt)')
import io, zipfile
def make_zip(entries, first_stored=True):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as z:
        for i, (name, data) in enumerate(entries):
            z.writestr(zipfile.ZipInfo(name), data, compress_type=zipfile.ZIP_STORED if (i == 0 and first_stored) else zipfile.ZIP_DEFLATED)
    return buf.getvalue()
ODT = make_zip([('mimetype', 'application/vnd.oasis.opendocument.text'), ('content.xml', '<office:document-content/>')])
OTT = make_zip([('mimetype', 'application/vnd.oasis.opendocument.text-template'), ('content.xml', '<x/>')])
DOCX = make_zip([('[Content_Types].xml', '<x/>'), ('word/document.xml', '<x/>')])
DEFLATED_MIME = make_zip([('mimetype', 'application/vnd.oasis.opendocument.text')], first_stored=False)
REAL = open(os.path.join(HERE, '..', '..', 'seed-xor-tool', 'test-fixtures', 'letter-of-instruction.odt'), 'rb').read()
for i, (data, name) in enumerate([(ODT, 'a.odt'), (OTT, 'b.ott'), (DOCX, 'c.docx'), (DEFLATED_MIME, 'd.odt'), (REAL, 'Letter.odt'), (ODT, 'renamed.zip')]):
    send('%016x' % (0x200 + i), name, data)
route()
kinds = {d['name']: d['kind'] for d in index()['documents']}
ck('an .odt is recognized from its bytes (LibreOffice-made and minimal)', kinds.get('a.odt') == 'odt' and kinds.get('Letter.odt') == 'odt', kinds)
ck('...whatever its name', kinds.get('renamed.zip') == 'odt')
ck('a template (.ott), a .docx and a compressed mimetype are not', kinds.get('b.ott') == 'other' and kinds.get('c.docx') == 'other' and kinds.get('d.odt') == 'other', kinds)
# A document stored before .odt was known keeps "other" in its metadata: the index looks again.
mp = os.path.join(DOCS, '%016x.meta.json' % 0x200)
rec = json.load(open(mp)); rec['kind'] = 'other'; json.dump(rec, open(mp, 'w'))
run('index', DOCS, ERR)
ck('an .odt stored as "other" earlier is shown as .odt now', {d['id']: d['kind'] for d in index()['documents']}['%016x' % 0x200] == 'odt')
for i in range(6):
    put('SKDOC-%016x.skdel' % (0x200 + i), b'')
route()

print('4. Index, cleanup, robustness')
os.remove(os.path.join(DOCS, '%016x.png' % 0x100))
r = run('index', DOCS, ERR)
ck('index alone works, and skips metadata whose bytes are gone', r.returncode == 0 and '%016x' % 0x100 not in ids(), r.stdout + r.stderr)
with open(os.path.join(DOCS, '%016x.meta.json' % 0x101), 'w') as f:
    f.write('{"name": 5, "ext": "../x", "kind": "html", "sha256": "zz"}')
run('index', DOCS, ERR)
d = [x for x in index()['documents'] if x['id'] == '%016x' % 0x101]
ck('tampered metadata is cleaned in the index (or dropped)', not d or (d[0]['ext'] == 'bin' and d[0]['kind'] == 'other' and d[0]['sha256'] == ''), d)
put('SKDOC-%s.skbin' % ('c' * 16), b'x')
put('SKDOC-%s.skdel' % ('c' * 16), b'')
put('keep.json', b'{}')
r = run('cleanup', INC)
ck('cleanup at boot removes only leftover requests', sorted(os.listdir(INC)) == ['keep.json'], os.listdir(INC))
r = run('bogus')
ck('an unknown command is a usage error', r.returncode == 2)
r = run('route', os.path.join(root, 'missing'), DOCS, ERR)
ck('a missing folder is exit 3, not a crash', r.returncode == 3, (r.returncode, r.stderr))
ck('documents/ is created private (0700)', (os.stat(DOCS).st_mode & 0o777) == 0o700, oct(os.stat(DOCS).st_mode))
idx_text = open(os.path.join(DOCS, '.documents-index.json'), encoding='utf-8').read()
ck('the index is valid JSON with non-ASCII names kept', json.loads(idx_text)['version'] == 1)

print('\ntest-documents-helper: %d passed, %d failed' % (passed, failed))
sys.exit(1 if failed else 0)
