// "Update available": compares this build (build-info.js, stamped in CI) with its channel's GitHub release
// (update-core.js). Asks GitHub at most every 6 hours; "Later" hides the banner for that build for 3 days. Local and
// dev builds (sha "dev") never ask.
// Where the app can install the update itself (the computer: desktop-updater.js; Android: mobile/app-updater.js),
// "Update" downloads it right here with a progress bar and then offers "Restart now"; on iOS, or if that fails,
// "Download" opens the release in the browser as before.
(() => {
  const build = window.MURIEL_BUILD || {};
  const core = window.MurielUpdateCore;
  const CHECK_EVERY = 6 * 3600 * 1000;
  const SNOOZE = 3 * 24 * 3600 * 1000;
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };

  const channel = build.channel || (window.Capacitor && window.Capacitor.getPlatform ? window.Capacitor.getPlatform() : '');
  const api = core && core.releaseApi(build.repo || 'cloverscripts/riff-muriel', channel);
  const enabled = !!(api && build.sha && build.sha !== 'dev');
  const isAndroid = channel === 'android';
  // the in-app installer, when this build has one (null on iOS and in the browser)
  const installer = (window.electronAPI && window.electronAPI.updates) || window.MurielAppUpdater || null;
  let canInstall = null;
  const installable = async () => {
    if (canInstall === null) canInstall = !!(installer && await installer.supported().catch(() => false));
    return canInstall;
  };

  async function latestRelease() {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    try {
      const res = await fetch(api, { headers: { Accept: 'application/vnd.github+json' }, signal: ctrl.signal });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  function open(url) {
    if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) location.href = url; // the native shell hands outside links to the browser
    else window.open(url, '_blank');
  }

  // "Muriel 1.2.4" when the new build is a new version, else its build number
  function label(update) {
    if (update.version && update.version !== build.version) return `Muriel ${update.version}`;
    if (update.run && build.run && update.run > build.run) return `Build ${update.run}`;
    return 'A newer Muriel build';
  }

  // ---------- the in-app update: idle → downloading → ready (or failed, which falls back to the browser) ----------
  let phase = 'idle';
  let percent = 0;
  let failure = '';
  const listeners = new Set();
  const changed = () => listeners.forEach((fn) => fn());

  async function startUpdate(update) {
    if (phase === 'downloading' || phase === 'ready') return;
    phase = 'downloading';
    percent = 0;
    changed();
    const result = await installer.download(update, (p) => {
      if (!p || !p.total) return;
      const next = Math.min(100, Math.floor((p.received / p.total) * 100));
      if (next !== percent) { percent = next; changed(); }
    }).catch((e) => ({ ok: false, error: e && e.message }));
    if (result && result.ok) phase = 'ready';
    else { phase = 'failed'; failure = (result && result.error) || ''; }
    changed();
  }

  async function finishUpdate() {
    const result = await installer.install().catch((e) => ({ ok: false, error: e && e.message }));
    // Android: the first install needs "Install unknown apps" allowed for Muriel; install() opened that setting
    if (result && result.error === 'permission') { failure = 'permission'; changed(); }
    else if (!result || !result.ok) { phase = 'failed'; failure = (result && result.error) || ''; changed(); }
  }

  let banner = null;
  function hideBanner() {
    if (!banner) return;
    const b = banner; banner = null;
    listeners.delete(b.render);
    b.classList.remove('show');
    setTimeout(() => b.remove(), 400);
  }
  async function showBanner(update) {
    if (banner) return;
    const snooze = store.get('muriel_update_snooze');
    if (snooze && snooze.sha === update.sha && snooze.until > Date.now()) return;
    const inApp = await installable();
    if (banner) return;
    banner = document.createElement('div');
    banner.className = 'update-banner';
    banner.setAttribute('role', 'status');
    banner.innerHTML = `
      <svg class="update-banner-star" viewBox="0 0 1024 1024" aria-hidden="true"><path d="M512 32Q570 454 992 512Q570 570 512 992Q454 570 32 512Q454 454 512 32Z"/></svg>
      <div class="update-banner-text"><b data-i18n>Update available</b><span data-i18n></span><div class="update-banner-progress" hidden><i></i></div></div>
      <button type="button" class="update-banner-later" data-i18n>Later</button>
      <button type="button" class="update-banner-go" data-i18n>Download</button>`;
    const b = banner;
    const title = b.querySelector('b');
    const sub = b.querySelector('span');
    const bar = b.querySelector('.update-banner-progress');
    const later = b.querySelector('.update-banner-later');
    const go = b.querySelector('.update-banner-go');
    b.render = () => {
      const inProgress = phase === 'downloading';
      bar.hidden = !inProgress;
      bar.firstElementChild.style.width = `${percent}%`;
      go.hidden = inProgress;
      later.textContent = inProgress ? 'Hide' : 'Later';
      if (!inApp || phase === 'failed') {
        title.textContent = phase === 'failed' ? 'Update failed' : 'Update available';
        sub.textContent = phase === 'failed' ? 'Download it from GitHub instead' : `${label(update)} is ready`;
        go.textContent = 'Download';
      } else if (phase === 'idle') {
        title.textContent = 'Update available';
        sub.textContent = `${label(update)} is ready`;
        go.textContent = 'Update';
      } else if (inProgress) {
        title.textContent = 'Downloading update';
        sub.textContent = `${label(update)} · ${percent}%`;
      } else {
        title.textContent = failure === 'permission' ? 'Allow Muriel to install apps' : 'Update ready';
        sub.textContent = failure === 'permission' ? 'Then tap Install again'
          : isAndroid ? `${label(update)} is downloaded` : `${label(update)} installs when Muriel restarts`;
        go.textContent = isAndroid ? 'Install' : 'Restart now';
      }
    };
    go.addEventListener('click', () => {
      if (!inApp || phase === 'failed') { open(update.url); hideBanner(); }
      else if (phase === 'idle') startUpdate(update);
      else if (phase === 'ready') finishUpdate();
    });
    // before downloading: snooze this build. While or after downloading: just hide; a downloaded update still goes
    // in when Muriel quits (the computer) or from Settings > About (Android)
    later.addEventListener('click', () => {
      if (phase === 'idle') store.set('muriel_update_snooze', { sha: update.sha, until: Date.now() + SNOOZE });
      hideBanner();
    });
    listeners.add(b.render);
    b.render();
    document.body.appendChild(b);
    requestAnimationFrame(() => requestAnimationFrame(() => banner && banner.classList.add('show')));
  }

  // Settings > About: status line and "Check now" (then "Update" / "Restart now", or "Download" without an installer)
  const statusEl = document.getElementById('update-status');
  const checkBtn = document.getElementById('btn-check-updates');
  let current = null;
  let found = '';
  const setStatus = (text) => {
    if (!statusEl) return;
    found = text;
    renderStatus();
  };
  function renderStatus() {
    if (!statusEl) return;
    const inApp = canInstall && current;
    statusEl.textContent = !inApp || phase === 'idle' ? found
      : phase === 'downloading' ? `Downloading ${label(current)} · ${percent}%`
        : phase === 'ready' ? (failure === 'permission' ? 'Allow Muriel to install apps, then tap Install' : `${label(current)} is ready to install`)
          : `Update failed${failure && failure !== 'permission' ? `: ${failure}` : ''}`;
    statusEl.classList.toggle('has-update', !!current);
    if (!checkBtn) return;
    checkBtn.disabled = !!inApp && phase === 'downloading';
    checkBtn.textContent = !current ? 'Check now'
      : !inApp || phase === 'failed' ? 'Download'
        : phase === 'ready' ? (isAndroid ? 'Install' : 'Restart now') : 'Update';
  }
  listeners.add(renderStatus);

  async function check(manual) {
    if (!enabled) { if (manual) setStatus('Update checks run in the official builds'); return; }
    const last = store.get('muriel_update_last') || 0;
    if (!manual && Date.now() - last < CHECK_EVERY) {
      const cached = store.get('muriel_update_found');
      if (cached && cached.from === build.sha) { current = cached.update; await installable(); setStatus(`${label(current)} is available`); showBanner(current); }
      return;
    }
    if (manual) setStatus('Checking…');
    const rel = await latestRelease();
    if (!rel) { if (manual) setStatus("Couldn't reach GitHub, try again later"); return; }
    store.set('muriel_update_last', Date.now());
    current = core.describe(rel, build, channel);
    store.set('muriel_update_found', current ? { from: build.sha, update: current } : null);
    await installable();
    if (current) { setStatus(`${label(current)} is available`); showBanner(current); }
    else setStatus(`You're up to date${build.run ? ` (build ${build.run})` : ''}`);
  }

  if (checkBtn) {
    checkBtn.addEventListener('click', () => {
      if (!current) return check(true);
      if (!canInstall || phase === 'failed') return open(current.url);
      if (phase === 'idle') return startUpdate(current);
      if (phase === 'ready') return finishUpdate();
    });
  }
  if (statusEl) setStatus(enabled ? `${build.version ? `Muriel ${build.version} · ` : ''}Build ${build.run || '?'} · ${String(build.sha).slice(0, 7)}` : 'Development build');

  // first check a little after start-up, then whenever the app comes back to the foreground
  setTimeout(() => check(false), 8000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(false); });
  window.MurielUpdates = { check: () => check(true) };
})();
