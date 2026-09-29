/**
 * SafeKeepVault — Transfer Drive bridge (no browser permission prompts)
 *
 * WHY THIS EXISTS
 *   The exFAT TRANSFER partition is mounted by safekeep-boot.sh at boot.
 *   The app used to reach it through Chromium's File System Access API
 *   (showDirectoryPicker), which forces a folder picker AND an
 *   "Allow this site to edit files?" prompt on every boot — Chromium has no
 *   policy to pre-grant it, and the kiosk runs incognito so nothing persists.
 *
 *   This module provides an object with the same shape as a
 *   FileSystemDirectoryHandle (the subset the app uses), backed by the
 *   daemon instead of the File System Access API:
 *     - READ:   fetch(file://<transfer>/<name>)   (Chromium runs with
 *               --allow-file-access-from-files, same as vault reads)
 *     - LIST:   fetch(file:///tmp/safekeep-signals/xfer/index.txt), an index
 *               the watcher keeps current (the browser cannot list dirs)
 *     - WRITE / DELETE / RENAME: a single Blob download named
 *               SKXFER-<op>-<reqid>[-<hexname>].skxfer. Chromium's download
 *               policy drops it into the vault's download dir; the
 *               Transfer Watcher in safekeep-boot.sh performs the operation
 *               with FIXED logic (no shell commands from the browser),
 *               then writes done-<reqid>.txt with "ok" or "error: …".
 *   One download per user action keeps Chromium's "multiple downloads"
 *   prompt out of the picture.
 *
 * Names are hex-encoded (UTF-8) in the download filename so Chromium's
 * filename sanitiser can never alter them; the watcher re-validates every
 * name (no "/", no leading ".", no control characters).
 *
 * A memory backend is provided for the localhost dev server so the
 * integration can be exercised without the daemon.
 */

const STATE_DIR = '/tmp/safekeep-signals/xfer';
const STATE_URL = 'file://' + STATE_DIR;
const MAX_NAME_BYTES = 100;          // keeps the download filename < 255 bytes
const OP_TIMEOUT_MS = 30000;

function _err(name, message) {
  try { return new DOMException(message, name); }
  catch (_) { const e = new Error(message); e.name = name; return e; }
}

function _utf8Hex(str) {
  const bytes = new TextEncoder().encode(str);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

function _hexUtf8(hex) {
  if (!/^(?:[0-9a-f]{2})+$/.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (_) { return null; }
}

/** Same rules the watcher enforces. Throws TypeError like the real API. */
function validateName(name) {
  if (typeof name !== 'string' || name === '' || name === '.' || name === '..') {
    throw new TypeError('Name is not allowed.');
  }
  if (/[\/\\]/.test(name) || /[\x00-\x1f\x7f]/.test(name)) {
    throw new TypeError('Name is not allowed.');
  }
  if (name.startsWith('.')) throw new TypeError('Hidden (dot) files are not allowed on the Transfer Drive.');
  if (new TextEncoder().encode(name).length > MAX_NAME_BYTES) {
    throw new TypeError('File name is too long (max ' + MAX_NAME_BYTES + ' bytes).');
  }
  return name;
}

function _reqId() {
  const r = new Uint8Array(6);
  crypto.getRandomValues(r);
  return Date.now().toString(36) + Array.from(r, b => b.toString(16).padStart(2, '0')).join('');
}

function _download(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  try { a.click(); }
  finally {
    if (a.parentNode) a.parentNode.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }
}

const _sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
//  Backends: { label, list(), read(name), write(name, blob), remove(name),
//              move(from, to) }   list() → [{ name, size, lastModified }]
// ---------------------------------------------------------------------------

function _fileUrl(root, name) {
  return 'file://' + root.split('/').map(encodeURIComponent).join('/') + '/' + encodeURIComponent(name);
}

/**
 * Daemon backend. Resolves to null when the watcher is not running or no
 * transfer partition is mounted (ready.txt missing/empty) — the caller then
 * falls back to the old picker flow.
 */
async function daemonBackend(opts) {
  const fetchFn = (opts && opts.fetch) || ((u, o) => fetch(u, o));
  const downloadFn = (opts && opts.download) || _download;
  const pollMs = (opts && opts.pollMs) || 150;
  const timeoutMs = (opts && opts.timeoutMs) || OP_TIMEOUT_MS;

  async function readText(url) {
    try {
      const r = await fetchFn(url, { cache: 'no-store' });
      if (!r.ok) return null;
      return await r.text();
    } catch (_) { return null; }
  }

  const ready = await readText(STATE_URL + '/ready.txt');
  const root = ready ? ready.trim() : '';
  if (!root || !root.startsWith('/')) return null;

  async function list() {
    const txt = await readText(STATE_URL + '/index.txt');
    if (txt === null) throw _err('NotReadableError', 'Transfer Drive is not available right now.');
    const lines = txt.split('\n');
    if (lines[0].trim() !== 'SKX1') throw _err('NotReadableError', 'Transfer Drive index is malformed.');
    const out = [];
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split('\t');
      if (parts.length < 3) continue;
      const name = _hexUtf8(parts[0]);
      if (!name || name.startsWith('.')) continue;
      out.push({ name, size: Number(parts[1]) || 0, lastModified: (Number(parts[2]) || 0) * 1000 });
    }
    return out;
  }

  async function request(op, blob, hexName) {
    const id = _reqId();
    const fname = 'SKXFER-' + op + '-' + id + (hexName ? '-' + hexName : '') + '.skxfer';
    downloadFn(fname, blob);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await _sleep(pollMs);
      const res = await readText(STATE_URL + '/done-' + id + '.txt');
      if (res === null) continue;
      const t = res.trim();
      if (t === 'ok') return;
      const msg = t.replace(/^error:\s*/, '') || 'unknown error';
      if (/^notfound/i.test(msg)) throw _err('NotFoundError', 'File not found on Transfer Drive.');
      throw _err('InvalidStateError', 'Transfer Drive: ' + msg);
    }
    throw _err('TimeoutError', 'Transfer Drive did not respond (is the transfer watcher running?).');
  }

  return {
    label: root,
    root,
    list,
    async read(name) {
      const r = await fetchFn(_fileUrl(root, name), { cache: 'no-store' }).catch(() => null);
      if (!r || !r.ok) throw _err('NotFoundError', 'File not found on Transfer Drive.');
      return await r.blob();
    },
    write(name, blob) {
      return request('W', blob, _utf8Hex(name));
    },
    remove(name) {
      return request('D', new Blob([_utf8Hex(name) + '\n'], { type: 'application/octet-stream' }));
    },
    move(from, to) {
      return request('M', new Blob([_utf8Hex(from) + '\n' + _utf8Hex(to) + '\n'], { type: 'application/octet-stream' }));
    },
  };
}

/** In-memory backend for the localhost dev server (and tests). */
function memoryBackend(label) {
  const files = new Map();   // name → { blob, lastModified }
  return {
    label: label || 'TRANSFER (dev mock)',
    root: '/media/safekeep-transfer',
    async list() {
      return Array.from(files, ([name, f]) => ({ name, size: f.blob.size, lastModified: f.lastModified }));
    },
    async read(name) {
      const f = files.get(name);
      if (!f) throw _err('NotFoundError', 'File not found on Transfer Drive.');
      return f.blob;
    },
    async write(name, blob) { files.set(name, { blob, lastModified: Date.now() }); },
    async remove(name) {
      if (!files.delete(name)) throw _err('NotFoundError', 'File not found on Transfer Drive.');
    },
    async move(from, to) {
      const f = files.get(from);
      if (!f) throw _err('NotFoundError', 'File not found on Transfer Drive.');
      files.delete(from);
      files.set(to, { blob: f.blob, lastModified: Date.now() });
    },
  };
}

// ---------------------------------------------------------------------------
//  FileSystem*Handle look-alikes
// ---------------------------------------------------------------------------

function _toBlobPart(data) {
  if (data && typeof data === 'object' && !(data instanceof Blob) && !ArrayBuffer.isView(data)
      && !(data instanceof ArrayBuffer) && 'type' in data) {
    // WriteParams form: { type: 'write', data }
    if (data.type !== 'write' || data.position !== undefined) {
      throw _err('NotSupportedError', 'Only sequential writes are supported on the Transfer Drive.');
    }
    return data.data;
  }
  return data;
}

class SkxFileHandle {
  constructor(dir, name, meta) {
    this.kind = 'file';
    this.name = name;
    this._dir = dir;
    this._meta = meta || null;
  }
  async getFile() {
    const blob = await this._dir._backend.read(this.name);
    const lm = (this._meta && this._meta.lastModified) || Date.now();
    return new File([blob], this.name, { lastModified: lm, type: blob.type || '' });
  }
  async createWritable(options) {
    if (options && options.keepExistingData) {
      throw _err('NotSupportedError', 'keepExistingData is not supported on the Transfer Drive.');
    }
    const parts = [];
    let closed = false;
    const self = this;
    return {
      async write(data) {
        if (closed) throw _err('InvalidStateError', 'Stream is closed.');
        parts.push(_toBlobPart(data));
      },
      async seek() { throw _err('NotSupportedError', 'seek() is not supported on the Transfer Drive.'); },
      async truncate() { throw _err('NotSupportedError', 'truncate() is not supported on the Transfer Drive.'); },
      async abort() { closed = true; parts.length = 0; },
      async close() {
        if (closed) return;
        closed = true;
        const blob = new Blob(parts, { type: 'application/octet-stream' });
        await self._dir._backend.write(self.name, blob);
        self._meta = { size: blob.size, lastModified: Date.now() };
      },
    };
  }
  async move(a, b) {
    const newName = validateName(typeof a === 'string' ? a : b);
    await this._dir._backend.move(this.name, newName);
    this.name = newName;
  }
  async isSameEntry(other) {
    return !!other && other.kind === 'file' && other.name === this.name && other._dir === this._dir;
  }
  async queryPermission() { return 'granted'; }
  async requestPermission() { return 'granted'; }
}

class SkxDirectoryHandle {
  constructor(backend) {
    this.kind = 'directory';
    this.name = 'TRANSFER';
    this._backend = backend;
    this.isSafeKeepTransfer = true;
    this.label = backend.label;
  }
  async _list() { return this._backend.list(); }
  async *entries() {
    for (const f of await this._list()) yield [f.name, new SkxFileHandle(this, f.name, f)];
  }
  async *values() {
    for (const f of await this._list()) yield new SkxFileHandle(this, f.name, f);
  }
  async *keys() {
    for (const f of await this._list()) yield f.name;
  }
  [Symbol.asyncIterator]() { return this.entries(); }
  async getFileHandle(name, options) {
    validateName(name);
    const found = (await this._list()).find(f => f.name === name);
    if (found) return new SkxFileHandle(this, name, found);
    if (options && options.create) return new SkxFileHandle(this, name, null);
    throw _err('NotFoundError', 'File not found on Transfer Drive.');
  }
  async getDirectoryHandle(name) {
    throw _err('NotFoundError', 'Sub-folders are not supported on the Transfer Drive.');
  }
  async removeEntry(name) {
    validateName(name);
    await this._backend.remove(name);
  }
  async resolve() { return null; }
  async isSameEntry(other) { return other === this; }
  async queryPermission() { return 'granted'; }
  async requestPermission() { return 'granted'; }
}

function makeHandle(backend) {
  return new SkxDirectoryHandle(backend);
}

const SKTransfer = { daemonBackend, memoryBackend, makeHandle, validateName, _utf8Hex, _hexUtf8, STATE_DIR };

if (typeof window !== 'undefined') window.SKTransfer = SKTransfer;

export { SKTransfer };
