// "Download all" for a playlist, favorites or an album (#29). A long list used to go one song after another with
// no retry: once YouTube started refusing (HTTP 429/403 after a couple of hundred lookups) every later song
// failed straight away, and a failed song was not tried again. Here a few songs download at a time, a refusal
// makes every worker wait (longer each time) before the song is tried again with a fresh lookup, and songs that
// still failed get one more slow pass at the end. No DOM: app.js runs it, test/download-batch.test.js tests it.
(function () {
  // what a failed download says: 'rate' (YouTube is refusing us: wait before anything else), 'retry' (worth
  // another go), 'fatal' (won't change)
  function classifyError(err) {
    if (!err) return 'retry';
    if (err.name === 'AbortError') return 'fatal';
    const status = Number(err.status) || 0;
    const msg = String(err.message || '');
    if (status === 429 || status === 403 || /\b(429|403)\b|too many requests|forbidden|rate.?limit|sign in to confirm|not a bot/i.test(msg)) return 'rate';
    if (status >= 400 && status < 500 && status !== 408) return 'fatal';
    return 'retry';
  }

  // milliseconds to wait before attempt number `attempt` (1 = the first retry): doubling, capped, with jitter
  function backoffMs(attempt, kind, { baseMs = 2000, rateBaseMs = 15000, maxMs = 120000, random = Math.random } = {}) {
    const base = kind === 'rate' ? rateBaseMs : baseMs;
    const ms = Math.min(maxMs, base * 2 ** Math.max(0, attempt - 1));
    return Math.round(ms * (0.85 + random() * 0.3));
  }

  const realSleep = (ms, signal) => new Promise((resolve) => {
    if (!(ms > 0) || (signal && signal.aborted)) return resolve();
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); if (signal) signal.removeEventListener('abort', done); resolve(); }
    if (signal) signal.addEventListener('abort', done);
  });

  // items: what to download. worker(item, { attempt, fresh }) resolves when the song is saved, throws otherwise
  // (err.status for an HTTP answer). Resolves { done: [items], failed: [{ item, error }], aborted }.
  async function runDownloadBatch(items, worker, opts = {}) {
    const {
      concurrency = 2, retries = 3, finalPass = true, finalPassDelayMs = 20000, signal = null,
      sleep = realSleep, now = () => Date.now(), onProgress = null, backoff = {},
    } = opts;
    const list = Array.from(items || []);
    const done = [];
    let failed = [];
    let pauseUntil = 0; // a refusal pauses every worker, not only the one that saw it
    const aborted = () => !!(signal && signal.aborted);
    const report = (current) => { if (onProgress) { try { onProgress({ done: done.length, failed: failed.length, total: list.length, current }); } catch (e) {} } };

    async function attemptItem(item, maxRetries, freshFirst) {
      let lastErr = null;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (aborted()) return { aborted: true };
        const wait = pauseUntil - now();
        if (wait > 0) await sleep(wait, signal);
        if (aborted()) return { aborted: true };
        try {
          await worker(item, { attempt, fresh: freshFirst || attempt > 0 });
          return { ok: true };
        } catch (err) {
          if (aborted()) return { aborted: true };
          lastErr = err;
          const kind = classifyError(err);
          if (kind === 'fatal' || attempt >= maxRetries) break;
          const ms = backoffMs(attempt + 1, kind, backoff);
          if (kind === 'rate') pauseUntil = Math.max(pauseUntil, now() + ms);
          else await sleep(ms, signal);
        }
      }
      return { ok: false, error: lastErr };
    }

    async function pass(queue, workers, maxRetries, fresh) {
      let next = 0;
      const out = [];
      const run = async () => {
        while (next < queue.length && !aborted()) {
          const item = queue[next++];
          report(item);
          const r = await attemptItem(item, maxRetries, fresh);
          if (r.aborted) return;
          if (r.ok) done.push(item); else out.push({ item, error: r.error });
          report(null);
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, Math.min(workers, queue.length)) }, run));
      return out;
    }

    failed = await pass(list, concurrency, retries, false);
    if (finalPass && failed.length && !aborted()) {
      // the last go for what's left: after a pause, one song at a time, each with a fresh lookup
      await sleep(Math.max(finalPassDelayMs, pauseUntil - now()), signal);
      if (!aborted()) {
        const again = failed.map((f) => f.item);
        failed = [];
        failed = await pass(again, 1, 1, true);
      }
    }
    return { done, failed, aborted: aborted() };
  }

  const api = { runDownloadBatch, classifyError, backoffMs };
  if (typeof module !== 'undefined') module.exports = api;
  else window.MurielDownloadBatch = api;
})();
