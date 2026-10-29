'use strict';

// /api/image-proxy (server.js): the last cover a picture tries on computers. Public hosts only, kept on disk.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// a data folder of its own, so the kept pictures neither come from nor stay in the real one
process.env.MURIEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'muriel-image-proxy-'));

function get(port, route, token) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: route, headers: token ? { 'X-Muriel-Token': token } : {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

test('image proxy: needs the token, refuses private hosts, fetches and keeps public pictures', async () => {
  const oldFetch = globalThis.fetch;
  const asked = [];
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(800)]);
  let server;
  try {
    globalThis.fetch = async (url) => {
      asked.push(String(url));
      if (String(url) === 'https://93.184.216.34/cover.png') return new Response(png, { status: 200 });
      return new Response('', { status: 404 });
    };
    delete require.cache[require.resolve('../server')];
    server = require('../server');
    const port = await server.startServer(0);
    const token = server.getServerToken();
    const q = (u) => `/api/image-proxy?url=${encodeURIComponent(u)}`;

    assert.equal((await get(port, q('https://93.184.216.34/cover.png'))).status, 403, 'needs the token');
    assert.equal((await get(port, q('file:///etc/passwd'), token)).status, 400);
    assert.equal((await get(port, q('http://127.0.0.1:22/x.png'), token)).status, 404);
    assert.equal((await get(port, q('http://192.168.1.1/x.png'), token)).status, 404);
    assert.equal(asked.length, 0, 'nothing was fetched from a private address');

    const ok = await get(port, q('https://93.184.216.34/cover.png'), token);
    assert.equal(ok.status, 200);
    assert.equal(ok.type, 'image/png');
    assert.equal(ok.body.length, png.length);
    const again = await get(port, `${q('https://93.184.216.34/cover.png')}&t=${token}`);
    assert.equal(again.status, 200, 'the token also works in the URL, for <img>');
    assert.equal(asked.length, 1, 'the second time comes from disk');
  } finally {
    if (server) await server.stopServer();
    delete require.cache[require.resolve('../server')];
    globalThis.fetch = oldFetch;
    fs.rmSync(process.env.MURIEL_DATA_DIR, { recursive: true, force: true });
  }
});
