const test = require('node:test');
const assert = require('node:assert');
const { runDownloadBatch, classifyError, backoffMs } = require('../download-batch');

// a fake clock: sleep advances time instantly
function clock() {
  let t = 0;
  const slept = [];
  return { now: () => t, sleep: async (ms) => { slept.push(ms); t += Math.max(0, ms); }, slept };
}

test('classifyError: refusals, retryable and fatal errors', () => {
  assert.strictEqual(classifyError({ status: 429 }), 'rate');
  assert.strictEqual(classifyError({ status: 500, message: 'ERROR: HTTP Error 403: Forbidden' }), 'rate');
  assert.strictEqual(classifyError({ status: 500, message: 'Sign in to confirm you are not a bot' }), 'rate');
  assert.strictEqual(classifyError({ status: 500, message: "Couldn't play this song" }), 'retry');
  assert.strictEqual(classifyError(new TypeError('Failed to fetch')), 'retry');
  assert.strictEqual(classifyError({ status: 400, message: 'missing track information' }), 'fatal');
  assert.strictEqual(classifyError({ name: 'AbortError' }), 'fatal');
});

test('backoffMs doubles, is capped and longer for refusals', () => {
  const r = () => 0.5;
  assert.strictEqual(backoffMs(1, 'retry', { random: r }), 2000);
  assert.strictEqual(backoffMs(3, 'retry', { random: r }), 8000);
  assert.strictEqual(backoffMs(1, 'rate', { random: r }), 15000);
  assert.strictEqual(backoffMs(20, 'rate', { random: r }), 120000);
});

test('every song downloads, at most `concurrency` at a time', async () => {
  const c = clock();
  let active = 0;
  let peak = 0;
  const items = Array.from({ length: 50 }, (_, i) => i);
  const r = await runDownloadBatch(items, async () => {
    active++; peak = Math.max(peak, active);
    await new Promise((res) => setImmediate(res));
    active--;
  }, { concurrency: 3, ...c });
  assert.strictEqual(r.done.length, 50);
  assert.strictEqual(r.failed.length, 0);
  assert.strictEqual(peak, 3);
});

test('a rate limit pauses, then the song is retried with a fresh lookup', async () => {
  const c = clock();
  const calls = [];
  let refusals = 3;
  const r = await runDownloadBatch([1, 2, 3, 4], async (item, { fresh }) => {
    calls.push({ item, fresh, at: c.now() });
    if (item === 2 && refusals-- > 0) throw Object.assign(new Error('rate'), { status: 429 });
  }, { concurrency: 1, finalPass: false, ...c });
  assert.deepStrictEqual(r.done.sort(), [1, 2, 3, 4]);
  const twos = calls.filter((x) => x.item === 2);
  assert.strictEqual(twos.length, 4);
  assert.deepStrictEqual(twos.map((x) => x.fresh), [false, true, true, true]);
  assert.ok(twos[1].at >= 12000, 'waited before retrying');
});

test('songs that keep failing get one final fresh pass, then are reported', async () => {
  const c = clock();
  const tries = new Map();
  const r = await runDownloadBatch(['a', 'b', 'c'], async (item, { fresh, attempt }) => {
    tries.set(item, (tries.get(item) || 0) + 1);
    // 'b' only works on the final pass; 'c' never
    if (item === 'b' && tries.get('b') <= 4) throw new Error('server error');
    if (item === 'c') throw new Error('server error');
    if (item === 'b') assert.strictEqual(fresh, true);
  }, { concurrency: 2, retries: 3, ...c });
  assert.deepStrictEqual(r.done.sort(), ['a', 'b']);
  assert.deepStrictEqual(r.failed.map((f) => f.item), ['c']);
  assert.strictEqual(tries.get('c'), 4 + 2);
  assert.ok(c.slept.includes(20000), 'paused before the final pass');
});

test('a fatal error is not retried; abort stops the batch', async () => {
  const c = clock();
  let n = 0;
  const r1 = await runDownloadBatch(['x'], async () => { n++; throw Object.assign(new Error('bad'), { status: 400 }); }, { finalPass: false, ...c });
  assert.strictEqual(n, 1);
  assert.strictEqual(r1.failed.length, 1);

  const ac = new AbortController();
  const seen = [];
  const r2 = await runDownloadBatch([1, 2, 3, 4, 5], async (i) => { seen.push(i); if (i === 2) ac.abort(); }, { concurrency: 1, signal: ac.signal, ...c });
  assert.strictEqual(r2.aborted, true);
  assert.deepStrictEqual(seen, [1, 2]);
});
