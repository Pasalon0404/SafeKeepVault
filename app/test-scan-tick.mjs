/**
 * test-scan-tick.mjs — the hover tick when a QR chunk is read.
 *   SKScanner (the camera scanner every tool uses) plays skui_audio.scanTick
 *   once for each new QR chunk in a scan: once for a static QR held in view,
 *   once per new frame of an animated QR, and nothing for repeats. The tool
 *   still gets every decoded frame. Only hashes of chunks are kept, cleared
 *   on stop(), and a new scan starts fresh. scanTick is the hover tick, so it
 *   follows the same mute and volume.
 * SKScanner runs in a VM with a fake camera, canvas and jsQR.
 * Run: node test-scan-tick.mjs
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, 'boot.html'), 'utf8');
let pass = 0, fail = 0;
const ck = (n, c, x) => { c ? pass++ : fail++; if (!c || process.env.V) console.log((c ? '  PASS ' : '  FAIL ') + n + (c || x === undefined ? '' : '  -> ' + x)); };

const start = SRC.indexOf('var SKScanner = (function() {');
const end = SRC.indexOf('return { create: create, stopAll: stopAll };\n})();', start) + 'return { create: create, stopAll: stopAll };\n})();'.length;
ck('SKScanner found', start > 0 && end > start);

// A fake camera: each animation frame decodes the next item of `frames`
// (a string, or null for a frame with no QR).
function harness() {
  let frames = [], now = 0, rafQueue = [];
  const events = [];
  const el = () => ({ setAttribute() {}, removeAttribute() {}, appendChild() {}, remove() {}, style: {}, innerHTML: '' });
  const ctx = {
    window: {}, Set, Math, console,
    performance: { now: () => now },
    requestAnimationFrame: (fn) => { rafQueue.push(fn); return rafQueue.length; },
    cancelAnimationFrame: () => { rafQueue = []; },
    document: {
      getElementById: (id) => (id === 'reader' ? el() : null),
      createElement: (tag) => {
        const e = el();
        if (tag === 'canvas') e.getContext = () => ({ drawImage() {}, getImageData: () => ({ data: [], width: 1, height: 1 }) });
        if (tag === 'video') { e.play = () => {}; e.HAVE_ENOUGH_DATA = 4; e.readyState = 4; e.videoWidth = 1; e.videoHeight = 1; }
        return e;
      },
    },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } },
  };
  ctx.window.jsQR = () => { const f = frames.shift(); return f == null ? null : { data: f, binaryData: [] }; };
  ctx.skui_audio = { scanTick: () => events.push('tick') };
  ctx.window.skui_audio = ctx.skui_audio;
  vm.createContext(ctx);
  vm.runInContext(SRC.slice(start, end) + '\nwindow.SKScanner = SKScanner;', ctx);
  const runFrames = (list) => {
    frames = list.slice();
    for (let i = 0; i < list.length; i++) {
      now += 200; // past the 10 fps decode interval
      const q = rafQueue; rafQueue = [];
      q.forEach((fn) => fn());
    }
  };
  return { ctx, events, runFrames };
}

// Find the fake <video> the scanner made, to fire onloadedmetadata.
async function begin(h, onSuccess) {
  let videoEl = null;
  const orig = h.ctx.document.createElement;
  h.ctx.document.createElement = (tag) => { const e = orig(tag); if (tag === 'video') videoEl = e; return e; };
  const sc = h.ctx.window.SKScanner.create('reader');
  const p = sc.start({ fps: 10 }, onSuccess || ((t) => h.events.push('data:' + t)));
  await new Promise((r) => setImmediate(r));
  videoEl.onloadedmetadata();
  await p;
  return sc;
}

const ticks = (ev) => ev.filter((e) => e === 'tick').length;

console.log('1. Static QR');
{
  const h = harness();
  const sc = await begin(h);
  h.runFrames(['seed words', 'seed words', null, 'seed words']);
  ck('one tick for a static QR read three times', ticks(h.events) === 1, h.events.join(','));
  ck('the tool still gets every decoded frame', h.events.filter((e) => e === 'data:seed words').length === 3);
  ck('tick comes before the tool sees the frame', h.events[0] === 'tick' && h.events[1] === 'data:seed words');
  sc.stop();
}

console.log('2. Animated QR');
{
  const h = harness();
  const sc = await begin(h);
  h.runFrames(['ur:crypto-psbt/1-3/a', 'ur:crypto-psbt/1-3/a', 'ur:crypto-psbt/2-3/b', null, 'ur:crypto-psbt/3-3/c']);
  ck('one tick per new frame (3 frames)', ticks(h.events) === 3, h.events.join(','));
  h.runFrames(['ur:crypto-psbt/1-3/a', 'ur:crypto-psbt/2-3/b']);
  ck('the loop coming round again is silent', ticks(h.events) === 3);
  h.runFrames(['ur:crypto-psbt/4-3/d']);
  ck('a new fountain part ticks', ticks(h.events) === 4);
  sc.stop();
}

console.log('3. A new scan starts fresh');
{
  const h = harness();
  let sc = await begin(h);
  h.runFrames(['B$2P0200aaaa', 'B$2P0201bbbb']);
  sc.stop();
  sc = await begin(h);
  h.runFrames(['B$2P0200aaaa']);
  ck('the same chunk ticks again in a new scan', ticks(h.events) === 3, h.events.join(','));
  sc.stop();
}

console.log('4. Tool stops the scanner in its own callback');
{
  const h = harness();
  let scRef = null;
  const sc = await begin(h, (t) => { h.events.push('data:' + t); scRef.stop(); });
  scRef = sc;
  h.runFrames(['address']);
  ck('tick, then data, then stopped without error', h.events.join(',') === 'tick,data:address');
}

console.log('5. Sound is optional');
{
  const h = harness();
  h.ctx.skui_audio = undefined; h.ctx.window.skui_audio = undefined;
  const sc = await begin(h);
  h.runFrames(['x']);
  ck('no audio module: scanning still works', h.events.join(',') === 'data:x');
  sc.stop();
  const h2 = harness();
  h2.ctx.skui_audio.scanTick = () => { throw new Error('audio broke'); };
  const sc2 = await begin(h2);
  h2.runFrames(['y']);
  ck('a failing sound never breaks scanning', h2.events.join(',') === 'data:y');
  sc2.stop();
}

console.log('6. Wiring');
{
  const sk = SRC.slice(start, end);
  ck('only a hash of each chunk is kept', sk.includes('var chunk = _chunkHash(code.data') && sk.includes('seenChunks.add(chunk)') && !sk.includes('seenChunks.add(code.data'));
  ck('hashes cleared on stop()', /ctx = null;\s+seenChunks = null;/.test(sk));
  const audio = SRC.slice(SRC.indexOf('var skui_audio = (function () {'), SRC.indexOf("document.addEventListener('DOMContentLoaded', function () { skui_audio.init(); });"));
  ck('scanTick is the hover tick', /scanTick:\s+_hoverTick,/.test(audio));
  ck('the hover tick honours the mute switch', /function _hoverTick\(\) \{\s+if \(!enabled\) return;/.test(audio));
  ck('no tool calls jsQR outside SKScanner', (SRC.match(/window\.jsQR\(/g) || []).length === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
