/** App bootstrap: registers native-tab pages with the router, wires the global header /
 *  bottom nav / indexed-page overlays, and starts the auth flow. */

const NAV_ITEMS = [
  { key: 'library', label: 'Library', icon: 'library' },
  { key: 'playlists', label: 'Playlists', icon: 'playlistsNav' },
  { key: 'settings', label: 'Settings', icon: 'settingsNav' },
  { key: 'account', label: 'Account', icon: 'accountNav' },
];

// name -> cleanup fn, e.g. stopping a ticker interval — most indexed pages need nothing beyond
// the default is-open removal, but a few (Now Playing's position ticker) have real teardown to
// do, so closeIndexedPage always checks this rather than every close call site needing to know
// which pages have extra state.
const indexedPageCloseHooks = {};
function onIndexedPageClose(name, fn) { indexedPageCloseHooks[name] = fn; }

// Every indexed page is its own fully opaque layer sitting above everything else (z-index 30,
// see layout.css) — Now Playing/Lyrics paint a solid var(--deep) background, every other one
// (Discover, Queue, Notification Center, Playlist Detail, Equalizer) mounts its own independent
// instance of the animated wave background (see js/wavesBg.js's mountInstance) rather than
// relying on the shared #bg-root showing through a transparent page. That's the whole fix, and
// it means #page-container (the native tab underneath) never needs to be hidden/shown at all —
// an earlier version of this toggled a `visibility:hidden` class on it for as long as any
// indexed page was open, which is exactly what was causing a visible stall between an indexed
// page finishing its close animation and the native tab reappearing (flipping visibility back
// to visible on a whole tab's worth of DOM forces the WebView to redo layout/paint on it, which
// is not free) for a "fix" that a correctly-opaque indexed page makes entirely unnecessary in
// the first place — indexed pages sit above #page-container in z-order regardless, so whether
// it's visible underneath was never actually observable while anything is covering it opaquely.
const PAGES_WITHOUT_WAVE_BG = new Set(['nowPlaying', 'lyrics']);
function openIndexedPage(name, renderFn) {
  const container = document.getElementById('indexed-pages');
  let page = container.querySelector(`.indexed-page[data-page="${name}"]`);
  if (!page) {
    page = document.createElement('div');
    page.className = 'indexed-page';
    page.dataset.page = name;
    page.innerHTML = `
      ${PAGES_WITHOUT_WAVE_BG.has(name) ? '' : '<div class="indexed-page__bg waves-bg-host"></div>'}
      <div class="indexed-page__content"></div>
    `;
    container.appendChild(page);
    if (!PAGES_WITHOUT_WAVE_BG.has(name)) WavesBackground.mountInstance(page.querySelector('.indexed-page__bg'));
    attachIndexedPageSwipeDismiss(page, name);
  }
  renderFn(page.querySelector('.indexed-page__content'));
  requestAnimationFrame(() => page.classList.add('is-open'));
}

function closeIndexedPage(name) {
  indexedPageCloseHooks[name]?.();
  const page = document.querySelector(`.indexed-page[data-page="${name}"]`);
  page?.classList.remove('is-open');
}

/** Dragging down substantially anywhere on an indexed page (except actual controls — buttons,
 *  inputs, and scrollable content that isn't already at its own scroll top) animates the whole
 *  page down and off-screen, slower and smoother than the default open/close transition, before
 *  actually closing. Bound once per page node (nodes are cached/reused across opens, see
 *  openIndexedPage above), so every indexed page — Now Playing/Lyrics, Discover, Queue, Download
 *  Queue, Notification Center — gets this for free.
 *
 *  Third attempt at this gesture, and the previous two failed for the same underlying reason:
 *  they used Pointer Events + CSS `touch-action` to try to keep this gesture and native content
 *  scrolling from fighting each other, but `touch-action` is a static per-element property — the
 *  scrollable containers (.indexed-page__content, .np-panel, .ly-lines) had to keep `pan-y` so
 *  scrolling worked AT ALL, and since those containers wrap essentially the entire page content,
 *  that `pan-y` applied to nearly every touch start regardless of whether there was anything to
 *  actually scroll, letting native panning claim the gesture before this code ever got usable
 *  pointermove deltas. That's what made it silently not work, and the native-scroll-vs-inline-
 *  transform fight on the rare frames that DID get through is what read as flicker.
 *
 *  This version leaves touch-action alone (native scroll works completely normally everywhere)
 *  and instead uses raw touch events with a *conditional* `preventDefault()`: on the first
 *  meaningful movement of a touch, decide whether this drag should be OUR gesture (pointer moved
 *  down more than sideways, AND the nearest scrollable ancestor is already at scrollTop 0 — i.e.
 *  a native scroll attempt would just rubber-band/no-op anyway) or NATIVE's (anything else —
 *  scrolling up, sideways, or a list that isn't at its top yet). Only in the first case do we
 *  call preventDefault(), which is what actually cancels/suppresses the native touch handling
 *  for that gesture — same technique real iOS/Android "pull down to dismiss" implementations
 *  use, and the only one that can coexist with normal scrolling inside the exact same page. */
function attachIndexedPageSwipeDismiss(page, name) {
  const DISMISS_THRESHOLD = 140;
  const EXIT_MS = 620;
  let gesture = null; // { startX, startY, axis: 'x'|'y'|null, scrollEl }

  const isInteractiveTarget = (el) => !!el.closest(
    'button, input, textarea, select, a, .np-seek, .np-dropdown, [data-no-swipe-dismiss]'
  );
  const nearestScrollable = (el) => {
    let node = el;
    while (node && node !== page) {
      const cs = getComputedStyle(node);
      if (cs.overflowY === 'auto' || cs.overflowY === 'scroll') return node;
      node = node.parentElement;
    }
    return null;
  };

  page.addEventListener('touchstart', (e) => {
    // Queue's own drag-to-reorder and swipe-to-remove-from-queue gestures (queue.js) set this
    // flag on the page for as long as either is in progress — without it, the same physical
    // touch that starts a reorder-drag or a row swipe could *also* be read as the start of this
    // page-level dismiss gesture (both are touch-driven, and the drag handle / a queue row don't
    // match isInteractiveTarget's selector), fighting each other or accidentally closing the
    // whole Queue screen mid-drag.
    if (page.dataset.suppressSwipeDismiss === '1') { gesture = null; return; }
    if (e.touches.length !== 1 || isInteractiveTarget(e.target)) { gesture = null; return; }
    const t = e.touches[0];
    gesture = { startX: t.clientX, startY: t.clientY, axis: null, scrollEl: nearestScrollable(e.target) };
  }, { passive: true });

  page.addEventListener('touchmove', (e) => {
    if (!gesture || e.touches.length !== 1) return;
    const t = e.touches[0];
    const dx = t.clientX - gesture.startX;
    const dy = t.clientY - gesture.startY;
    if (!gesture.axis) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return; // not enough movement yet to tell
      const atScrollTop = !gesture.scrollEl || gesture.scrollEl.scrollTop <= 0;
      gesture.axis = (dy > 0 && dy > Math.abs(dx) && atScrollTop) ? 'y' : 'x';
      if (gesture.axis === 'x') { gesture = null; return; } // leave it to native scroll entirely
    }
    e.preventDefault(); // committed to owning this gesture — cancels native scroll for it
    page.style.transition = 'none';
    page.style.transform = `translateY(${Math.min(dy, window.innerHeight)}px)`;
  }, { passive: false });

  const finish = (e) => {
    if (!gesture) return;
    const wasTracking = gesture.axis === 'y';
    const t = e.changedTouches && e.changedTouches[0];
    const dy = wasTracking && t ? t.clientY - gesture.startY : 0;
    gesture = null;
    if (!wasTracking) return;
    if (dy > DISMISS_THRESHOLD) {
      page.style.transition = `transform ${EXIT_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`;
      page.style.transform = 'translateY(100%)';
      setTimeout(() => {
        // .indexed-page's own closed state is translateY(100%) — the same value we just
        // animated to — so closing (removing is-open) and then clearing these inline overrides
        // is a true no-op transform-wise, nothing left to animate or snap.
        closeIndexedPage(name);
        requestAnimationFrame(() => { page.style.transition = ''; page.style.transform = ''; });
      }, EXIT_MS);
    } else {
      page.style.transition = 'transform 260ms var(--ease-standard)';
      page.style.transform = '';
    }
  };
  page.addEventListener('touchend', finish);
  page.addEventListener('touchcancel', finish);
}

/** Builds the nav bar once — the sliding pill indicator (see layout.css's .nav-pill) has to be
 *  a persistent DOM node across navigations, not rebuilt every time, or its `left`/`width`
 *  CSS transition has nothing to animate from and just snaps instead of sliding. */
function buildNav() {
  const nav = document.getElementById('bottom-nav');
  const pill = document.createElement('div');
  pill.className = 'nav-pill';
  nav.appendChild(pill);
  NAV_ITEMS.forEach((item) => {
    const btn = document.createElement('button');
    btn.className = 'nav-item';
    btn.dataset.nav = item.key;
    btn.innerHTML = `${Icons[item.icon](22)}<span class="nav-label">${item.label}</span>`;
    btn.addEventListener('click', () => navigateTo(item.key));
    nav.appendChild(btn);
  });
}

function renderNav() {
  const nav = document.getElementById('bottom-nav');
  if (!nav.querySelector('.nav-pill')) buildNav();

  const activeBtn = nav.querySelector(`[data-nav="${Router.current}"]`);
  nav.querySelectorAll('.nav-item').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.nav === Router.current);
  });

  const pill = nav.querySelector('.nav-pill');
  if (activeBtn) {
    pill.style.left = `${activeBtn.offsetLeft}px`;
    pill.style.width = `${activeBtn.offsetWidth}px`;
  }
}

const PAGE_TITLES = { library: 'Library', playlists: 'Playlists', settings: 'Settings', account: 'Account' };
const NAV_ORDER = NAV_ITEMS.map((i) => i.key);

function navigateTo(page) {
  const fromIndex = NAV_ORDER.indexOf(Router.current);
  const toIndex = NAV_ORDER.indexOf(page);
  const direction = toIndex >= fromIndex ? 1 : -1;
  Router.show(page, { direction });
  document.getElementById('page-title').textContent = PAGE_TITLES[page] || '';
  renderNav();
}

/** Swipe left/right anywhere in the native page viewport to move to the adjacent bottom-nav tab
 *  (left = next, right = previous, wrapping is intentionally NOT supported — swiping left on the
 *  last tab or right on the first just does nothing). Same conditional-preventDefault technique
 *  as attachIndexedPageSwipeDismiss (app.js): only claims the gesture once it's clearly more
 *  horizontal than vertical, so normal vertical list scrolling is completely unaffected. Bails
 *  out entirely if the gesture starts on anything that already owns its own horizontal drag —
 *  a swipeable track row (.track-swipe), a range slider, or the equalizer's draggable points —
 *  so an individual card's own swipe action always takes priority over a whole-page tab switch. */
function attachPageSwipeNav() {
  const container = document.getElementById('page-container');
  if (!container) return;
  const SWIPE_THRESHOLD = 60;
  let gesture = null;

  const ownsHorizontalDrag = (el) => !!el.closest(
    '.track-swipe, .queue-row, input[type="range"], .eq-curve-point, .eq-curve-graph, [data-no-page-swipe]'
  );

  container.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || ownsHorizontalDrag(e.target)) { gesture = null; return; }
    const t = e.touches[0];
    gesture = { startX: t.clientX, startY: t.clientY, axis: null };
  }, { passive: true });

  container.addEventListener('touchmove', (e) => {
    if (!gesture || e.touches.length !== 1) return;
    const t = e.touches[0];
    const dx = t.clientX - gesture.startX;
    const dy = t.clientY - gesture.startY;
    if (!gesture.axis) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      gesture.axis = Math.abs(dx) > Math.abs(dy) * 1.4 ? 'x' : 'y';
      if (gesture.axis === 'y') { gesture = null; return; }
    }
  }, { passive: true });

  const finish = (e) => {
    if (!gesture || gesture.axis !== 'x') { gesture = null; return; }
    const t = e.changedTouches && e.changedTouches[0];
    if (!t) { gesture = null; return; }
    const dx = t.clientX - gesture.startX;
    gesture = null;
    if (Math.abs(dx) < SWIPE_THRESHOLD) return;
    const fromIndex = NAV_ORDER.indexOf(Router.current);
    const toIndex = dx < 0 ? fromIndex + 1 : fromIndex - 1; // swipe left -> next tab
    const nextPage = NAV_ORDER[toIndex];
    if (nextPage) navigateTo(nextPage);
  };
  container.addEventListener('touchend', finish);
  container.addEventListener('touchcancel', () => { gesture = null; });
}

function renderMiniPlayer() {
  const state = AppStore.get('playbackState');
  const el = document.getElementById('mini-player');
  if (!state || !state.title) { el.classList.remove('is-visible'); el.innerHTML = ''; return; }
  el.classList.add('is-visible');
  el.innerHTML = `
    <div style="display:flex; align-items:center; gap:10px; padding:8px;">
      ${state.artworkPath ? `<img src="${artworkUrl(state.artworkPath)}" style="width:40px; height:40px; border-radius:8px; object-fit:cover;">` : `<div style="width:40px; height:40px; border-radius:8px; background:var(--glass-fill);"></div>`}
      <div style="flex:1; min-width:0;">
        <div class="track-row__title">${state.title}</div>
        <div class="track-row__subtitle">${state.artist || ''}</div>
      </div>
      <button class="icon-btn icon-btn--accent" id="mp-toggle">${state.isPlaying ? Icons.pause(20) : Icons.play(20)}</button>
    </div>
  `;
  el.querySelector('#mp-toggle').onclick = (e) => { e.stopPropagation(); Bridge.call('playback.togglePlayPause'); };
  el.onclick = () => openIndexedPage('nowPlaying', NowPlayingScreen.render);
}

async function initShell() {
  Router.register('library', LibraryScreen.render);
  Router.register('playlists', PlaylistsScreen.render);
  Router.register('settings', SettingsScreen.render);
  Router.register('account', AccountScreen.render);

  document.getElementById('btn-discover').onclick = () => openIndexedPage('discover', DiscoverScreen.content);
  document.getElementById('btn-queue').onclick = () => openIndexedPage('queue', QueueScreen.content);
  document.getElementById('btn-notifications').onclick = () => openIndexedPage('notificationCenter', NotificationCenterScreen.content);
  attachPageSwipeNav();

  Bridge.on('playback.state', (state) => { AppStore.set({ playbackState: state }); renderMiniPlayer(); });
  Bridge.on('library.changed', (list) => AppStore.set({ library: list }));

  Bridge.call('settings.get').then((s) => {
    AppStore.set({ settings: s });
    document.documentElement.setAttribute('data-colorway', s.colorway);
    SettingsScreen.applyAppearance(s.themeMode);
    WavesBackground.setEnabled(s.backgroundAnimationEnabled !== false);
    WavesBackground.setSpeed(s.backgroundAnimationSpeed || 1);
    applyPerfMode(!!s.phoneHeatOptimization);
  });

  // Pull the current snapshot explicitly instead of relying solely on the native push arriving
  // in time. WebAppBridge's Room-Flow pushes start firing from inside MainActivity.onCreate(),
  // racing against the WebView's own page-load/script-execution pipeline that this listener
  // above depends on — a real, timing-sensitive race, not a rare edge case, and the actual
  // cause of tracks "sometimes not appearing at all" until something else happened to
  // re-trigger the Flow. This fetch is a local Room query via the bridge (no network), so it
  // resolves in milliseconds and doesn't reintroduce any startup delay.
  const [library, playlists] = await Promise.all([
    Bridge.call('library.list').catch(() => []),
    Bridge.call('playlists.list').catch(() => []),
  ]);
  AppStore.set({ library, playlists });

  navigateTo('library');
}

document.addEventListener('atlas:authed', initShell);
Auth.tryResumeSession();
