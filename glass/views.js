// Muriel Glass: content views behaviour (see glass/DESIGN.md and glass/views.css).
// - the compact bar of each page (.g-navbar): the large title collapses into it once it scrolls away
// - artwork collages (2x2) for playlists without their own cover, on the playlist page and Home's playlist row
(() => {
  const VIEWS = {
    'view-discover': '#home-large-title',
    'view-favorites': '.view-header h2',
    'view-albums': '.view-header h2',
    'view-local': '.view-header h2',
    'view-history': '.view-header h2',
    'view-playlist-detail': '#playlist-detail-title',
    'view-album': '#album-detail-title',
    'view-artist': '#artist-profile-name',
  };

  function initNavbars() {
    const main = document.getElementById('main-content');
    if (!main) return;
    const pages = [];
    for (const [id, sel] of Object.entries(VIEWS)) {
      const view = document.getElementById(id);
      const bar = view && view.querySelector(':scope > .g-navbar');
      if (!bar) continue;
      pages.push({ view, bar, title: bar.querySelector('.g-navbar-title'), sel });
    }
    let raf = 0;
    let topInset = 0;
    const readInset = () => { topInset = parseFloat(getComputedStyle(main).getPropertyValue('--g-content-top')) || 0; };
    const update = () => {
      raf = 0;
      const page = pages.find((p) => p.view.classList.contains('active'));
      if (!page) return;
      const big = page.view.querySelector(page.sel);
      const shown = !!(big && big.getClientRects().length);
      let on = false;
      if (shown) {
        // pushed pages: once the title passes under the back button; top pages: once it has gone
        const top = main.getBoundingClientRect().top + topInset;
        on = big.getBoundingClientRect().bottom < top + (page.bar.querySelector('.g-nav-btn') ? 52 : 4);
      }
      const text = shown ? (big.textContent || '').trim() : '';
      if (page.title && page.title.textContent !== text) page.title.textContent = text;
      if (page.bar.classList.contains('g-navbar-on') !== on) page.bar.classList.toggle('g-navbar-on', on);
      document.body.classList.toggle('g-title-collapsed', on);
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(update); };
    readInset();
    main.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', () => { readInset(); schedule(); }, { passive: true });
    // a page opening (its .active class), or its title changing (a playlist renamed, an artist loaded)
    const mo = new MutationObserver(schedule);
    pages.forEach((p) => {
      mo.observe(p.view, { attributes: true, attributeFilter: ['class'] });
      const big = p.view.querySelector(p.sel);
      if (big) mo.observe(big, { childList: true, characterData: true, subtree: true });
    });
    const results = document.getElementById('search-results-container');
    if (results) mo.observe(results, { attributes: true, attributeFilter: ['class'] });
    schedule();
  }

  // ---- collages: the first four different covers of a playlist, like Apple Music's playlist artwork ----
  const core = () => window.MurielCore;
  function coversOf(pl) {
    const C = core();
    const out = [];
    for (const t of (pl && pl.tracks) || []) {
      const u = (C && C.thumb && C.thumb(t)) || t.thumbnail || t.cover || '';
      if (u && !out.includes(u)) out.push(u);
      if (out.length === 4) break;
    }
    return out;
  }
  function paintCollage(box, pl) {
    if (!box) return;
    const urls = pl && !pl.cover ? coversOf(pl) : [];
    const old = box.querySelector(':scope > .g-collage');
    if (urls.length < 4) {
      if (old) old.remove();
      box.classList.remove('g-has-collage');
      return;
    }
    const sig = urls.join('\n');
    if (old && old.dataset.sig === sig) return;
    if (old) old.remove();
    const grid = document.createElement('div');
    grid.className = 'g-collage';
    grid.dataset.sig = sig;
    grid.setAttribute('aria-hidden', 'true');
    urls.forEach((u) => {
      const img = document.createElement('img');
      img.alt = '';
      img.decoding = 'async';
      img.loading = 'lazy';
      img.src = u;
      grid.appendChild(img);
    });
    box.appendChild(grid);
    box.classList.add('g-has-collage');
  }

  function initCollages() {
    const C = core();
    if (!C || !C.state) return;
    const detail = document.getElementById('playlist-detail-cover');
    if (detail) {
      const paint = () => paintCollage(detail, (C.state.playlists || []).find((p) => p.id === C.state.currentPlaylistId));
      new MutationObserver(paint).observe(detail, { childList: true });
      paint();
    }
    // Home's "Your playlists": the cards follow state.playlists, after the "New playlist" card
    const home = document.getElementById('section-home-playlists');
    if (home) {
      const paintHome = () => {
        const cards = home.querySelectorAll('.home-pl-card:not(.home-pl-new) .home-pl-cover');
        const lists = C.state.playlists || [];
        cards.forEach((cover, i) => paintCollage(cover, lists[i]));
      };
      let t = 0;
      new MutationObserver((recs) => {
        // our own collage nodes don't need another pass
        if (recs.every((r) => [...r.addedNodes, ...r.removedNodes].every((n) => n.classList && n.classList.contains('g-collage')))) return;
        clearTimeout(t); t = setTimeout(paintHome, 30);
      }).observe(home, { childList: true, subtree: true });
      paintHome();
    }
  }

  // ---- the multi-select bar floats above whatever is docked at the bottom of the window ----
  // The shell can say how tall that is (--g-chrome-bottom); when it doesn't, measure the player and the tab bar.
  function initChromeBottom() {
    const root = document.documentElement;
    const measure = () => {
      if (getComputedStyle(root).getPropertyValue('--g-chrome-bottom').trim()) return;
      let h = 0;
      document.querySelectorAll('#playbar, #sidebar').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (!r.height || r.height > innerHeight / 2 || r.top < innerHeight / 2) return;
        h = Math.max(h, innerHeight - r.top);
      });
      root.style.setProperty('--gv-chrome-bottom', `${Math.round(h)}px`);
    };
    new MutationObserver(() => { if (document.body.classList.contains('multi-select-on')) measure(); })
      .observe(document.body, { attributes: true, attributeFilter: ['class'] });
    window.addEventListener('resize', () => { if (document.body.classList.contains('multi-select-on')) measure(); }, { passive: true });
    measure();
  }

  const start = () => { initNavbars(); initCollages(); initChromeBottom(); };
  if (window.MurielCore) start();
  else window.addEventListener('muriel:ready', start, { once: true });
})();
