'use strict';

// mobile/hls-loader.js: hls.js on phones fetches playlists and segments with native HTTP and the stream's headers.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

function load(fetchImpl) {
  const calls = [];
  globalThis.__murielFetch = async (url, init) => { calls.push({ url, init }); return fetchImpl(url, init); };
  const file = path.join(__dirname, '../mobile/hls-loader.js');
  delete require.cache[file];
  const mod = require(file);
  return { NativeLoader: mod.NativeLoader, calls };
}

const cb = () => {
  const out = {};
  const done = new Promise((resolve) => {
    out.callbacks = {
      onSuccess: (r, s, c) => resolve(['success', r, s]),
      onError: (e) => resolve(['error', e]),
      onTimeout: () => resolve(['timeout']),
      onAbort: () => resolve(['abort']),
    };
  });
  return { ...out, done };
};

test('segments get the headers remembered for their site, and a byte range', async () => {
  const { NativeLoader, calls } = load(async () => ({ ok: true, status: 200, url: '', arrayBuffer: async () => new ArrayBuffer(4) }));
  globalThis.__murielHlsHeaders.remember('https://manifest.googlevideo.com/x/index.m3u8', { 'User-Agent': 'visionOS' });
  const l = new NativeLoader();
  const { callbacks, done } = cb();
  l.load({ url: 'https://rr1---sn.googlevideo.com/seg/1', responseType: 'arraybuffer', rangeStart: 10, rangeEnd: 20 }, { timeout: 5000 }, callbacks);
  const [kind, res, stats] = await done;
  assert.strictEqual(kind, 'success');
  assert.strictEqual(res.data.byteLength, 4);
  assert.strictEqual(stats.loaded, 4);
  assert.deepStrictEqual(calls[0].init.headers, { 'User-Agent': 'visionOS', Range: 'bytes=10-19' });
});

test('playlists come back as text; a refused one is an error', async () => {
  const { NativeLoader } = load(async (url) => (url.endsWith('ok')
    ? { ok: true, status: 200, url, text: async () => '#EXTM3U' }
    : { ok: false, status: 403, statusText: 'Forbidden' }));
  const a = cb();
  new NativeLoader().load({ url: 'https://x.googlevideo.com/ok', responseType: '' }, {}, a.callbacks);
  assert.strictEqual((await a.done)[1].data, '#EXTM3U');
  const b = cb();
  new NativeLoader().load({ url: 'https://x.googlevideo.com/no', responseType: '' }, {}, b.callbacks);
  assert.deepStrictEqual(await b.done, ['error', { code: 403, text: 'Forbidden' }]);
});

test('an aborted load reports abort and ignores the late answer', async () => {
  let release;
  const { NativeLoader } = load(() => new Promise((r) => { release = () => r({ ok: true, status: 200, text: async () => 'late' }); }));
  const l = new NativeLoader();
  const { callbacks, done } = cb();
  let successes = 0;
  const wrapped = { ...callbacks, onSuccess: (...a) => { successes++; callbacks.onSuccess(...a); } };
  l.load({ url: 'https://x.googlevideo.com/p', responseType: '' }, { timeout: 5000 }, wrapped);
  l.abort();
  assert.deepStrictEqual(await done, ['abort']);
  release();
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(successes, 0);
});
