const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

test('ordinary plugin file names load, paths and hidden files do not (#38)', () => {
  const orig = Module._load;
  Module._load = function (req, ...rest) { return req === 'electron' ? { dialog: {}, ipcMain: {}, shell: {} } : orig.call(this, req, ...rest); };
  try {
    const { safeName } = require('../plugins');
    for (const ok of ['hello.js', 'my plugin (1).js', 'Grüße.JS', 'a-b_c.d.js']) assert.ok(safeName(ok), ok);
    for (const bad of ['../x.js', 'x.js.txt', '.hidden.js', 'a/b.js', 'a\\\\b.js', 'x.mjs']) assert.ok(!safeName(bad), bad);
  } finally { Module._load = orig; }
});
