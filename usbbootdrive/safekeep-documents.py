#!/usr/bin/env python3
# =====================================================================
#  safekeep-documents.py — documents in the vault
# =====================================================================
#  DOCUMENTS_DESIGN.md. Run as root by safekeep-boot.sh (at boot and by
#  the File Router watcher). The app can't write or delete files in the
#  vault itself: it "downloads" small request files into the vault's
#  download folder (seeds/), and this helper carries them out with fixed
#  logic. Nothing in a request is ever run or used as a path.
#
#  Requests (in INCOMING, names exactly as below, ID = 16 hex characters)
#     SKDOC-<ID>.skmeta   JSON: {"name", "size", "sha256", "added"}
#     SKDOC-<ID>.skbin    the document's bytes
#         Together: import. Routed only when both are there and the bytes
#         match the size and SHA-256. The bytes are moved (renamed inside
#         the vault, never copied) to DOCS/<ID>.<ext>.
#     SKDOC-<ID>.skren    JSON: {"name"}   rename
#     SKDOC-<ID>.skdel    (any content)    delete
#
#  In DOCS, per document
#     <ID>.<ext>          the original bytes, unchanged
#     <ID>.meta.json      {"id", "name", "ext", "kind", "size", "sha256",
#                          "added"}; "kind" is detected here from the bytes
#  and one index the app reads
#     .documents-index.json  {"version": 1, "free": B, "total": B,
#                             "documents": [...], "errors": {ID: text}}
#  and, for a person opening an Encrypted Backup with 7-Zip on another
#  computer, a plain list of which file is which document:
#     README - document names.txt
#
#  Usage
#     route   INCOMING DOCS [ERRORS]   carry out waiting requests, then index
#     index   DOCS [ERRORS]            write the index only
#     cleanup INCOMING                 at boot: delete leftover requests
#  ERRORS is a small JSON file outside the vault (default
#  /tmp/safekeep-documents-errors.json) holding this session's refusals.
#
#  Exit codes: 0 done (refusals are reported in the index, not here),
#  2 usage, 3 the folders can't be used.
# =====================================================================
import hashlib
import json
import os
import re
import sys
import time

MAX_BYTES = 100 * 1024 * 1024          # 100 MB per document
MAX_META = 4096                        # a request's JSON
MAX_NAME = 200
INDEX_NAME = '.documents-index.json'
NAMES_FILE = 'README - document names.txt'
MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
DEFAULT_ERRORS = '/tmp/safekeep-documents-errors.json'
REQ_RE = re.compile(r'^SKDOC-([0-9a-f]{16})\.(skmeta|skbin|skren|skdel)$')
ID_RE = re.compile(r'^[0-9a-f]{16}$')
EXT_RE = re.compile(r'^[a-z0-9]{1,8}$')
SHA_RE = re.compile(r'^[0-9a-f]{64}$')
TEXT_EXTS = {'txt', 'md', 'csv', 'log', 'json'}
# A request older than this with its partner missing is given up on.
STALE_SECONDS = 15 * 60


def clean_name(name):
    """A display name: printable, trimmed, at most MAX_NAME characters."""
    if not isinstance(name, str):
        return None
    name = ''.join(ch for ch in name if ch.isprintable()).strip()
    if not name or len(name) > MAX_NAME:
        return None
    return name


def ext_of(name):
    base = name.rsplit('/', 1)[-1]
    if '.' not in base:
        return 'bin'
    ext = base.rsplit('.', 1)[1].lower()
    return ext if EXT_RE.match(ext) else 'bin'


def detect_kind(path, ext):
    """What the bytes are, from their first bytes (never the name alone)."""
    try:
        with open(path, 'rb') as f:
            head = f.read(65536)
    except OSError:
        return 'other'
    if b'%PDF-' in head[:1024]:
        return 'pdf'
    if head.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'png'
    if head.startswith(b'\xff\xd8\xff'):
        return 'jpeg'
    if head[:6] in (b'GIF87a', b'GIF89a'):
        return 'gif'
    if head[:4] == b'RIFF' and head[8:12] == b'WEBP':
        return 'webp'
    if ext in TEXT_EXTS and b'\x00' not in head:
        try:
            head.decode('utf-8')
            return 'text'
        except UnicodeDecodeError as e:
            # A multi-byte character cut at the 64 KB boundary is fine.
            if e.start >= len(head) - 3:
                return 'text'
    return 'other'


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def read_json(path, limit=MAX_META):
    try:
        if os.path.getsize(path) > limit:
            return None
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except (OSError, ValueError, UnicodeDecodeError):
        return None


def write_json_atomic(path, data):
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def remove_quietly(path):
    try:
        os.remove(path)
    except OSError:
        pass


def doc_files(docs, doc_id):
    """The files of one document in DOCS (its bytes and its metadata)."""
    out = []
    for n in os.listdir(docs):
        if n.startswith(doc_id + '.') and not n.endswith('.tmp'):
            out.append(os.path.join(docs, n))
    return out


class Errors:
    def __init__(self, path):
        self.path = path
        self.data = read_json(path, 65536) or {}

    def set(self, doc_id, text):
        self.data[doc_id] = text

    def clear(self, doc_id):
        self.data.pop(doc_id, None)

    def save(self):
        try:
            write_json_atomic(self.path, self.data)
        except OSError:
            pass


def do_import(incoming, docs, doc_id, errors):
    meta_path = os.path.join(incoming, 'SKDOC-%s.skmeta' % doc_id)
    bin_path = os.path.join(incoming, 'SKDOC-%s.skbin' % doc_id)
    if not (os.path.isfile(meta_path) and os.path.isfile(bin_path)):
        return False                      # wait for the other half
    meta = read_json(meta_path)

    def refuse(text):
        remove_quietly(meta_path)
        remove_quietly(bin_path)
        errors.set(doc_id, text)
        return True

    if meta is None:
        return refuse('The document\'s details were unreadable.')
    name = clean_name(meta.get('name'))
    size = meta.get('size')
    sha = meta.get('sha256')
    added = meta.get('added') if isinstance(meta.get('added'), str) else ''
    if name is None:
        return refuse('The document\'s name was missing or too long.')
    if not isinstance(size, int) or size < 0 or not isinstance(sha, str) or not SHA_RE.match(sha):
        return refuse('The document\'s details were incomplete.')
    if size > MAX_BYTES:
        return refuse('The document is larger than 100 MB.')
    actual = os.path.getsize(bin_path)
    if actual < size:
        return False                      # still being written
    if actual != size or sha256_file(bin_path) != sha:
        return refuse('The document arrived damaged (its size or checksum didn\'t match). Try again.')
    if doc_files(docs, doc_id):
        return refuse('A document with this ID already exists.')

    ext = ext_of(name)
    dest = os.path.join(docs, '%s.%s' % (doc_id, ext))
    os.replace(bin_path, dest)            # same file system: a rename
    record = {
        'id': doc_id, 'name': name, 'ext': ext,
        'kind': detect_kind(dest, ext), 'size': size, 'sha256': sha,
        'added': added[:40],
    }
    write_json_atomic(os.path.join(docs, '%s.meta.json' % doc_id), record)
    remove_quietly(meta_path)
    errors.clear(doc_id)
    print('Documents: imported %s (%d bytes, %s)' % (doc_id, size, record['kind']))
    return True


def do_rename(incoming, docs, doc_id, errors):
    req = os.path.join(incoming, 'SKDOC-%s.skren' % doc_id)
    data = read_json(req)
    remove_quietly(req)
    meta_path = os.path.join(docs, '%s.meta.json' % doc_id)
    record = read_json(meta_path, 65536)
    name = clean_name(data.get('name')) if data else None
    if record is None:
        errors.set(doc_id, 'That document is no longer in the vault.')
    elif name is None:
        errors.set(doc_id, 'The new name was missing or too long.')
    else:
        record['name'] = name
        write_json_atomic(meta_path, record)
        errors.clear(doc_id)
        print('Documents: renamed %s' % doc_id)
    return True


def do_delete(incoming, docs, doc_id, errors):
    remove_quietly(os.path.join(incoming, 'SKDOC-%s.skdel' % doc_id))
    for p in doc_files(docs, doc_id):
        remove_quietly(p)
    errors.clear(doc_id)
    print('Documents: deleted %s' % doc_id)
    return True


def route(incoming, docs, errors):
    """Carry out every complete request. Returns how many changed DOCS."""
    os.makedirs(docs, mode=0o700, exist_ok=True)
    reqs = {}
    for n in sorted(os.listdir(incoming)):
        m = REQ_RE.match(n)
        if m and os.path.isfile(os.path.join(incoming, n)):
            reqs.setdefault(m.group(1), set()).add(m.group(2))
    changed = 0
    now = time.time()
    for doc_id, kinds in reqs.items():
        if 'skmeta' in kinds or 'skbin' in kinds:
            if do_import(incoming, docs, doc_id, errors):
                changed += 1
            else:
                # Half an import that never completed: give up on it.
                for k in ('skmeta', 'skbin'):
                    p = os.path.join(incoming, 'SKDOC-%s.%s' % (doc_id, k))
                    try:
                        if now - os.path.getmtime(p) > STALE_SECONDS:
                            remove_quietly(p)
                            errors.set(doc_id, 'The document never finished arriving. Try again.')
                            changed += 1
                    except OSError:
                        pass
        if 'skren' in kinds and do_rename(incoming, docs, doc_id, errors):
            changed += 1
        if 'skdel' in kinds and do_delete(incoming, docs, doc_id, errors):
            changed += 1
    return changed


def write_index(docs, errors):
    os.makedirs(docs, mode=0o700, exist_ok=True)
    documents = []
    for n in sorted(os.listdir(docs)):
        if not n.endswith('.meta.json'):
            continue
        doc_id = n[:-len('.meta.json')]
        if not ID_RE.match(doc_id):
            continue
        record = read_json(os.path.join(docs, n), 65536)
        if not record:
            continue
        ext = record.get('ext') if isinstance(record.get('ext'), str) and EXT_RE.match(record.get('ext')) else 'bin'
        data_path = os.path.join(docs, '%s.%s' % (doc_id, ext))
        if not os.path.isfile(data_path):
            continue                      # metadata without its document
        documents.append({
            'id': doc_id,
            'name': clean_name(record.get('name')) or doc_id,
            'ext': ext,
            'kind': record.get('kind') if record.get('kind') in ('pdf', 'png', 'jpeg', 'gif', 'webp', 'text') else 'other',
            'size': os.path.getsize(data_path),
            'sha256': record.get('sha256') if isinstance(record.get('sha256'), str) and SHA_RE.match(record.get('sha256')) else '',
            'added': record.get('added') if isinstance(record.get('added'), str) else '',
        })
    documents.sort(key=lambda d: d['added'], reverse=True)
    st = os.statvfs(docs)
    index = {
        'version': 1,
        'free': st.f_bavail * st.f_frsize,
        'total': st.f_blocks * st.f_frsize,
        'documents': documents,
        'errors': dict(errors.data),
    }
    write_json_atomic(os.path.join(docs, INDEX_NAME), index)
    write_names(docs, documents)
    return index


def human_size(n):
    if n < 1024:
        return '%d bytes' % n
    if n < 1024 * 1024:
        return '%d KB' % max(1, round(n / 1024))
    if n < 1024 * 1024 * 1024:
        return ('%.1f MB' % (n / 1048576)) if n < 10485760 else '%d MB' % round(n / 1048576)
    return '%.1f GB' % (n / 1073741824)


def human_date(iso):
    m = re.match(r'^(\d{4})-(\d{2})-(\d{2})', iso or '')
    if not m or not 1 <= int(m.group(2)) <= 12:
        return ''
    return '%s %d, %s' % (MONTHS[int(m.group(2)) - 1], int(m.group(3)), m.group(1))


def write_names(docs, documents):
    """The plain list a person reads after opening a backup with 7-Zip."""
    lines = [
        'SafeKeep documents',
        '',
        'Each file in this folder whose name is a code (like 3f9a1c2b4d5e6f70.pdf)',
        'is one document from the SafeKeep vault, unchanged. Its real name is below.',
        'Open it with any program that opens that kind of file. The .meta.json files',
        'hold the same details for SafeKeep itself.',
        '',
    ]
    if not documents:
        lines.append('(No documents yet.)')
    else:
        width = max(len('%s.%s' % (d['id'], d['ext'])) for d in documents)
        for d in sorted(documents, key=lambda d: d['name'].lower()):
            details = human_size(d['size'])
            when = human_date(d['added'])
            if when:
                details += ', added ' + when
            lines.append('%s   %s   (%s)' % (('%s.%s' % (d['id'], d['ext'])).ljust(width), d['name'], details))
    path = os.path.join(docs, NAMES_FILE)
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8', newline='\r\n') as f:
        f.write('\n'.join(lines) + '\n')
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def cleanup(incoming):
    n = 0
    for name in os.listdir(incoming):
        if REQ_RE.match(name):
            remove_quietly(os.path.join(incoming, name))
            n += 1
    return n


def main(argv):
    if len(argv) < 2:
        print(__doc__ or 'usage: route|index|cleanup', file=sys.stderr)
        return 2
    cmd = argv[1]
    try:
        if cmd == 'route' and len(argv) in (4, 5):
            errors = Errors(argv[4] if len(argv) == 5 else DEFAULT_ERRORS)
            changed = route(argv[2], argv[3], errors)
            errors.save()
            write_index(argv[3], errors)
            if changed:
                print('Documents: %d request(s) carried out' % changed)
            return 0
        if cmd == 'index' and len(argv) in (3, 4):
            errors = Errors(argv[3] if len(argv) == 4 else DEFAULT_ERRORS)
            idx = write_index(argv[2], errors)
            print('Documents index: %d document(s), %d MB free' % (len(idx['documents']), idx['free'] // 1048576))
            return 0
        if cmd == 'cleanup' and len(argv) == 3:
            n = cleanup(argv[2])
            if n:
                print('Documents: removed %d leftover request file(s)' % n)
            return 0
    except OSError as e:
        print('Documents: %s' % e, file=sys.stderr)
        return 3
    print('usage: route INCOMING DOCS [ERRORS] | index DOCS [ERRORS] | cleanup INCOMING', file=sys.stderr)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv))
