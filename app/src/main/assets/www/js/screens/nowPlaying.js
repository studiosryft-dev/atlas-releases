/** Now Playing — full redesign. Lives on one Indexed Page with Lyrics (LyricsScreen), the two
 *  sliding horizontally inside `.np-slider` rather than being separate indexed pages. Background
 *  is the current track's own artwork, scaled/blurred/dimmed. Position/timestamp is animated via
 *  a local 1s ticker (native only pushes on real player events, not every second) that resyncs
 *  to the authoritative value every time a fresh playback.state push arrives. */
const VIS_BAR_COUNT = 24;

const NowPlayingScreen = (() => {
  let activePanel = 'player'; // 'player' | 'lyrics'
  let localPositionMs = 0;
  let isPlayingLocal = false;
  let tickTimer = null;
  let sleepEndsAtMs = null;

  // ---------------- audio visualizer ----------------
  // Real captured audio data (see VisualizerController.kt), not a looping decorative animation —
  // native pushes FFT-derived bar magnitudes only while `visualizer.start` is active, which this
  // module only calls while the player panel is visible AND actually playing. currentBars is
  // smoothed toward targetBars every frame via simple lerp rather than snapping to each new
  // native sample, which is what makes it read as fluid motion instead of jittery; when playback
  // stops, targetBars becomes all-zero and the same loop naturally settles the bars down to idle
  // and then stops itself — no ongoing rAF cost while paused/closed.
  let visualizerActive = false;
  let visualizerTargetBars = new Array(VIS_BAR_COUNT).fill(0);
  let visualizerCurrentBars = new Array(VIS_BAR_COUNT).fill(0);
  let visualizerRaf = null;
  let visualizerUnsub = null;

  function startVisualizerCapture() {
    if (visualizerActive) return;
    visualizerActive = true;
    const perfMode = document.documentElement.hasAttribute('data-perf-mode');
    Bridge.call('visualizer.start', { reduced: perfMode }).catch(() => {});
    if (!visualizerUnsub) {
      visualizerUnsub = Bridge.on('playback.visualizerData', (bars) => {
        if (Array.isArray(bars) && bars.length === VIS_BAR_COUNT) {
          visualizerTargetBars = bars;
          ensureVisualizerLoop();
        }
      });
    }
  }
  function stopVisualizerCapture() {
    if (!visualizerActive) return;
    visualizerActive = false;
    Bridge.call('visualizer.stop').catch(() => {});
    visualizerTargetBars = new Array(VIS_BAR_COUNT).fill(0);
    ensureVisualizerLoop(); // let the bars settle down to 0 smoothly instead of freezing mid-height
  }
  function ensureVisualizerLoop() {
    if (visualizerRaf) return;
    visualizerRaf = requestAnimationFrame(visualizerTick);
  }
  function visualizerTick() {
    let stillMoving = false;
    for (let i = 0; i < VIS_BAR_COUNT; i++) {
      const diff = visualizerTargetBars[i] - visualizerCurrentBars[i];
      if (Math.abs(diff) > 0.004) {
        visualizerCurrentBars[i] += diff * 0.25;
        stillMoving = true;
      } else {
        visualizerCurrentBars[i] = visualizerTargetBars[i];
      }
    }
    const host = document.getElementById('np-visualizer');
    if (host) {
      const bars = host.children;
      for (let i = 0; i < bars.length; i++) {
        bars[i].style.transform = `scaleY(${Math.max(0.05, visualizerCurrentBars[i])})`;
      }
    }
    const anyAboveZero = visualizerCurrentBars.some((v) => v > 0.005);
    if (stillMoving || anyAboveZero) {
      visualizerRaf = requestAnimationFrame(visualizerTick);
    } else {
      visualizerRaf = null; // fully idle — stop looping entirely rather than ticking at 0 forever
    }
  }
  function syncVisualizerToPlaybackState() {
    if (isOpen() && activePanel === 'player' && isPlayingLocal) startVisualizerCapture();
    else stopVisualizerCapture();
  }

  function fmtTime(ms) {
    const total = Math.floor(Math.max(0, ms || 0) / 1000);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  function findTrack(id) {
    return (AppStore.get('library') || []).find((t) => t.id === id) || null;
  }

  function isOpen() {
    return !!document.querySelector('.indexed-page[data-page="nowPlaying"].is-open');
  }

  function render(rootEl) {
    activePanel = 'player';
    const state = AppStore.get('playbackState') || {};
    localPositionMs = state.positionMs || 0;
    isPlayingLocal = !!state.isPlaying;

    rootEl.innerHTML = `
      <div class="np-shell">
        <div class="np-bg" id="np-bg"></div>
        <div class="np-slider" id="np-slider">
          <div class="np-panel" id="np-panel-player"></div>
          <div class="np-panel" id="np-panel-lyrics"></div>
        </div>
      </div>
    `;
    renderPlayerPanel();
    applyBg(state.artworkPath);
    updateSliderPosition();
    // The swipe-down-to-dismiss gesture itself now lives in app.js's openIndexedPage (applies
    // to every indexed page, not just this one) — this just makes sure the position ticker gets
    // stopped whenever this page closes, including via that generic swipe gesture, not only via
    // the explicit close()/back-button paths.
    onIndexedPageClose('nowPlaying', () => { stopTicker(); stopVisualizerCapture(); });

    Bridge.call('playback.getSleepTimer').then((t) => { sleepEndsAtMs = t?.endsAtMs || null; refreshSleepButton(); }).catch(() => {});

    startTicker();
    syncVisualizerToPlaybackState();
  }

  // Registered once at module load — same "check .is-open before touching the DOM" pattern
  // queue.js already uses, rather than subscribing/unsubscribing per open
  // (which would need every possible close path, including a future back-gesture, to remember
  // to tear the listener down or it'd silently accumulate duplicates).
  Bridge.on('playback.state', (s) => {
    AppStore.set({ playbackState: s });
    if (!isOpen()) return;
    localPositionMs = s.positionMs || 0;
    isPlayingLocal = !!s.isPlaying;
    applyBg(s.artworkPath);
    refreshDynamic();
    if (document.getElementById('np-panel-player')?.dataset.trackId !== s.currentTrackId) renderPlayerPanel();
    syncVisualizerToPlaybackState();
  });
  Bridge.on('playback.sleepTimer', (t) => {
    sleepEndsAtMs = t?.endsAtMs || null;
    if (isOpen()) refreshSleepButton();
  });

  function close() {
    stopTicker();
    stopVisualizerCapture();
    closeIndexedPage('nowPlaying');
  }

  let lastColorUrl = null;
  function applyBg(artworkPath) {
    const bg = document.getElementById('np-bg');
    if (!bg) return;
    const url = artworkPath ? artworkUrl(artworkPath) : null;
    bg.style.backgroundImage = url ? `url('${url}')` : 'none';
    if (url === lastColorUrl) return;
    lastColorUrl = url;
    if (!url) return;
    AlbumColor.extract(url).then((color) => {
      if (!color || url !== lastColorUrl) return; // track changed again before this resolved
      document.querySelector('.np-shell')?.style.setProperty('--np-accent', color);
    });
  }

  function startTicker() {
    stopTicker();
    tickTimer = setInterval(() => {
      if (!isOpen()) { stopTicker(); return; }
      if (isPlayingLocal) {
        localPositionMs += 1000;
        refreshSeekUi();
      }
    }, 1000);
  }
  function stopTicker() { if (tickTimer) { clearInterval(tickTimer); tickTimer = null; } }

  function refreshDynamic() {
    const state = AppStore.get('playbackState') || {};
    const playEl = document.getElementById('np-toggle');
    if (playEl) playEl.innerHTML = state.isPlaying ? Icons.pause(36) : Icons.play(36);
    refreshSeekUi();
  }

  function refreshSeekUi() {
    const state = AppStore.get('playbackState') || {};
    const duration = state.durationMs || 0;
    const fill = document.getElementById('np-seek-fill');
    const handle = document.getElementById('np-seek-handle');
    const cur = document.getElementById('np-time-current');
    const pct = duration > 0 ? Math.min(100, (localPositionMs / duration) * 100) : 0;
    if (fill) fill.style.width = `${pct}%`;
    if (handle) handle.style.left = `${pct}%`;
    if (cur) cur.textContent = fmtTime(localPositionMs);
  }

  function refreshSleepButton() {
    const btn = document.getElementById('np-act-sleep');
    if (!btn) return;
    btn.classList.toggle('is-active', !!sleepEndsAtMs);
  }

  // ---------------- player panel ----------------
  function renderPlayerPanel() {
    const panel = document.getElementById('np-panel-player');
    if (!panel) return;
    const state = AppStore.get('playbackState') || {};
    const track = findTrack(state.currentTrackId);
    panel.dataset.trackId = state.currentTrackId || '';
    const liked = track?.liked || false;
    const quality = (state.qualityLabel || track?.qualityLabel || 'MEDIUM');

    panel.innerHTML = `
      <div class="np-topbar">
        <button class="icon-btn" id="np-close">${Icons.chevronDown(24)}</button>
        <div class="np-visualizer" id="np-visualizer">${Array.from({ length: VIS_BAR_COUNT }).map(() => '<span class="np-vis-bar"></span>').join('')}</div>
        <div class="np-menu-wrap">
          <button class="icon-btn icon-morph-btn" id="np-menu-btn">
            <span class="icon-morph-icon icon-morph-icon--a">${Icons.more(22)}</span>
            <span class="icon-morph-icon icon-morph-icon--b">${Icons.close(22)}</span>
          </button>
          <div class="glass glass--strong np-dropdown" id="np-dropdown" hidden>
            <button class="np-dropdown__item" data-menu-action="rename">${Icons.pencil(16)} Rename</button>
            <button class="np-dropdown__item" data-menu-action="playlist">${Icons.playlistAdd(16)} Add to Playlist</button>
            ${track && !track.derivedKind ? `<button class="np-dropdown__item" data-menu-action="voiceIsolation">${Icons.mic(16)} Voice Isolation</button>` : ''}
            <button class="np-dropdown__item is-danger" data-menu-action="trash">${Icons.trash(16)} Move to Trash</button>
          </div>
        </div>
      </div>

      <div class="np-art-wrap" id="np-art-wrap">
        <div class="glass np-art">
          ${track?.artworkPath ? `<img src="${artworkUrl(track.artworkPath)}">` : ''}
        </div>
      </div>

      <div class="np-title-row">
        <div style="flex:1; min-width:0;">
          <div class="display np-title">${state.title || 'Nothing playing'}</div>
          <div class="np-artist">${state.artist || ''}</div>
        </div>
        <button class="icon-btn np-like ${liked ? 'is-liked' : ''}" id="np-like">${Icons.heart(24, liked)}</button>
      </div>

      <div class="np-seek" id="np-seek">
        <div class="np-seek__track">
          <div class="np-seek__fill" id="np-seek-fill"></div>
          <div class="np-seek__handle" id="np-seek-handle"></div>
        </div>
      </div>
      <div class="np-time-row">
        <span id="np-time-current">${fmtTime(localPositionMs)}</span>
        <span class="np-quality">${Icons.waveform(14)} ${quality}</span>
        <span id="np-time-total">${fmtTime(state.durationMs)}</span>
      </div>

      <div class="np-transport">
        <button class="icon-btn" id="np-prev">${Icons.prev(30)}</button>
        <button class="icon-btn glass glass--pill np-play" id="np-toggle">${state.isPlaying ? Icons.pause(36) : Icons.play(36)}</button>
        <button class="icon-btn" id="np-next">${Icons.next(30)}</button>
      </div>
      <div class="np-repeat-row" id="np-repeat-row">
        <button class="np-repeat-btn" data-mode="0" title="No Repeat">${Icons.repeatOff(20)}</button>
        <button class="np-repeat-btn" data-mode="1" title="Repeat Once">${Icons.repeatOnce(20)}</button>
        <button class="np-repeat-btn" data-mode="2" title="Repeat">${Icons.repeat(20)}</button>
      </div>

      <div class="np-action-row">
        <button class="np-action-btn ${activePanel === 'lyrics' ? 'is-active' : ''}" id="np-act-lyrics">${Icons.mic(20)}<span>Lyrics</span></button>
        <button class="np-action-btn" id="np-act-eq">${Icons.tune(20)}<span>Equalizer</span></button>
        <button class="np-action-btn ${sleepEndsAtMs ? 'is-active' : ''}" id="np-act-sleep">${Icons.moon(20)}<span>Sleep</span></button>
        <button class="np-action-btn" id="np-act-queue">${Icons.listQueue(20)}<span>Queue</span></button>
      </div>
    `;

    wirePlayerPanel(panel, track);
    refreshSeekUi();
  }

  function wirePlayerPanel(panel, track) {
    panel.querySelector('#np-close').onclick = close;
    panel.querySelector('#np-toggle').onclick = () => Bridge.call('playback.togglePlayPause');
    panel.querySelector('#np-next').onclick = () => Bridge.call('playback.next');
    panel.querySelector('#np-prev').onclick = () => Bridge.call('playback.previous');

    const repeatRow = panel.querySelector('#np-repeat-row');
    const state0 = AppStore.get('playbackState') || {};
    repeatRow.querySelectorAll('.np-repeat-btn').forEach((btn) => {
      btn.classList.toggle('is-active', Number(btn.dataset.mode) === (state0.repeatMode || 0));
      btn.onclick = () => {
        const mode = Number(btn.dataset.mode);
        repeatRow.querySelectorAll('.np-repeat-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
        Bridge.call('playback.setRepeatMode', { mode });
      };
    });
    panel.querySelector('#np-like').onclick = () => {
      if (!track) return;
      // Optimistic — flips the icon fill and color immediately rather than waiting on the
      // library.changed round-trip, so the tap visibly *does* something instead of just pulsing
      // with no visible before/after state change.
      const btn = panel.querySelector('#np-like');
      const nowLiked = !btn.classList.contains('is-liked');
      btn.classList.toggle('is-liked', nowLiked);
      btn.innerHTML = Icons.heart(24, nowLiked);
      btn.classList.add('is-pulsing');
      setTimeout(() => btn.classList.remove('is-pulsing'), 380);
      Bridge.call('library.toggleLiked', { id: track.id });
    };

    // 3-dot menu, icon-morph animation between the dots and an X via the is-open class. The
    // outside-click listener is only ever attached while the dropdown is actually open (and
    // always removed when it closes, however it closes) — attaching one unconditionally on
    // every renderPlayerPanel() call (which fires on every track transition while this page is
    // open) would stack up an ever-growing pile of dangling document listeners instead.
    const menuBtn = panel.querySelector('#np-menu-btn');
    const dropdown = panel.querySelector('#np-dropdown');
    const closeDropdown = () => {
      menuBtn.classList.remove('is-open');
      document.removeEventListener('click', closeDropdown);
      dropdown.classList.add('is-closing');
      setTimeout(() => { dropdown.hidden = true; dropdown.classList.remove('is-closing'); }, 180);
    };
    menuBtn.onclick = (e) => {
      e.stopPropagation();
      if (dropdown.hidden) {
        dropdown.hidden = false;
        menuBtn.classList.add('is-open');
        setTimeout(() => document.addEventListener('click', closeDropdown), 0);
      } else {
        closeDropdown();
      }
    };
    dropdown.querySelectorAll('[data-menu-action]').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        closeDropdown();
        if (!track) return;
        const action = btn.dataset.menuAction;
        if (action === 'rename') promptRename(track);
        else if (action === 'playlist') PlaylistsScreen.openAddToPlaylistPicker(track.id);
        else if (action === 'voiceIsolation') VoiceIsolationFlow.open(track.id, track.title);
        else if (action === 'trash') { Bridge.call('library.moveToTrash', { id: track.id }); close(); }
      };
    });

    // Seek bar — drag anywhere on the track, live preview while dragging, commits on release.
    const seek = panel.querySelector('#np-seek');
    seek.addEventListener('pointerdown', (e) => beginSeekDrag(e, seek));

    panel.querySelector('#np-act-lyrics').onclick = () => openLyrics(track);
    panel.querySelector('#np-act-eq').onclick = () => openEqualizerSheet(track);
    panel.querySelector('#np-act-sleep').onclick = (e) => openSleepPopup(e.currentTarget);
    panel.querySelector('#np-act-queue').onclick = () => openQueueSheet();
  }

  async function promptRename(track) {
    const result = await promptDialog({
      title: 'Rename Track',
      fields: [
        { id: 'title', label: 'Track name', value: track.title },
        { id: 'artist', label: 'Artist', value: track.artist },
      ],
    });
    if (!result) return;
    Bridge.call('library.rename', { id: track.id, title: result.title, artist: result.artist });
  }

  function beginSeekDrag(e, seek) {
    const state = AppStore.get('playbackState') || {};
    const duration = state.durationMs || 0;
    if (duration <= 0) return;
    const rect = seek.getBoundingClientRect();
    const startX = e.clientX;
    // .np-seek.is-dragging strips the fill/handle's transition (nowPlaying.css) so a real drag
    // tracks the finger 1:1 with no lag — but adding it immediately on pointerdown meant even a
    // plain tap-to-seek (jumping straight from the current position to wherever you tapped) hit
    // that same transition-less state, so it snapped instantly instead of animating over. Now
    // .is-dragging is only added once actual pointer movement is detected — a tap never moves,
    // so its one-and-only position update keeps the default 240ms transition and glides smoothly
    // to the new spot; a real drag still tracks instantly the moment it starts moving.
    let isDragging = false;
    const update = (clientX) => {
      const pct = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      localPositionMs = pct * duration;
      refreshSeekUi();
      return pct;
    };
    update(startX);
    const onMove = (ev) => {
      if (!isDragging && Math.abs(ev.clientX - startX) > 4) {
        isDragging = true;
        seek.classList.add('is-dragging');
      }
      update(ev.clientX);
    };
    const onUp = (ev) => {
      const pct = update(ev.clientX);
      seek.classList.remove('is-dragging');
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      Bridge.call('playback.seek', { positionMs: Math.round(pct * duration) });
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }

  // ---------------- sleep timer popup ----------------
  function openSleepPopup(anchorBtn) {
    document.querySelectorAll('.np-sleep-popup').forEach((el) => el.remove());
    const options = [
      { label: '5 min', minutes: 5 },
      { label: '10 min', minutes: 10 },
      { label: '30 min', minutes: 30 },
      { label: '1 hr', minutes: 60 },
      { label: '5 hr', minutes: 300 },
      { label: 'Off', minutes: 0 },
    ];
    const rect = anchorBtn.getBoundingClientRect();
    const popup = document.createElement('div');
    popup.className = 'glass glass--strong np-sleep-popup';
    popup.style.left = `${Math.min(rect.left, window.innerWidth - 200)}px`;
    popup.style.bottom = `${window.innerHeight - rect.top + 8}px`;
    popup.innerHTML = options.map((o) => `
      <button class="np-sleep-popup__item ${sleepEndsAtMs && o.minutes > 0 && Math.abs((sleepEndsAtMs - Date.now()) - o.minutes * 60000) < 60000 ? 'is-active' : ''} ${o.minutes === 0 && !sleepEndsAtMs ? 'is-active' : ''}" data-minutes="${o.minutes}">${o.label}</button>
    `).join('');
    const close = () => closeOverlayAnimated(popup);
    popup.querySelectorAll('[data-minutes]').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        Bridge.call('playback.setSleepTimer', { minutes: Number(btn.dataset.minutes) });
        close();
      };
    });
    document.body.appendChild(popup);
    setTimeout(() => document.addEventListener('click', close, { once: true }), 0);
  }

  // ---------------- equalizer inline sheet ----------------
  function openEqualizerSheet() {
    const overlay = document.createElement('div');
    overlay.className = 'swipe-toolbar-overlay';
    const sheet = document.createElement('div');
    sheet.className = 'glass glass--strong np-bottom-sheet';
    sheet.innerHTML = `
      <div class="np-bottom-sheet__header">
        <div class="display" style="font-size:16px;">Equalizer</div>
        <button class="icon-btn" id="np-eq-close">${Icons.close(18)}</button>
      </div>
      <div id="np-eq-embed"></div>
    `;
    const close = () => closeOverlayAnimated(overlay, sheet);
    overlay.onclick = close;
    sheet.querySelector('#np-eq-close').onclick = close;
    document.body.appendChild(overlay);
    document.body.appendChild(sheet);
    EmbeddedEqualizer.mount(sheet.querySelector('#np-eq-embed'));
  }

  // ---------------- queue sheet (Up Next + Autoplay) ----------------
  function openQueueSheet() {
    const overlay = document.createElement('div');
    overlay.className = 'swipe-toolbar-overlay';
    const sheet = document.createElement('div');
    sheet.className = 'glass glass--strong np-bottom-sheet np-bottom-sheet--tall';

    const renderBody = () => {
      const settings = AppStore.get('settings') || {};
      const q = AppStore.get('queueState') || { queue: [], currentIndex: -1 };
      sheet.innerHTML = `
        <div class="np-bottom-sheet__header">
          <div class="display" style="font-size:16px;">Up Next</div>
          <button class="icon-btn" id="np-queue-close">${Icons.close(18)}</button>
        </div>
        <div style="display:flex; align-items:center; margin:6px 0 14px;">
          <div style="flex:1;">Autoplay</div>
          <div class="switch ${settings.autoplay ? 'is-on' : ''}" id="np-queue-autoplay"></div>
        </div>
        <div class="embedded-scroll" style="max-height:44vh;">
          ${q.queue.length ? q.queue.map((t, i) => `
            <div class="track-row" data-play="${i}" style="${i === q.currentIndex ? 'background:rgba(255,255,255,0.06);' : ''}">
              ${t.artworkPath ? `<img class="track-row__art" src="${artworkUrl(t.artworkPath)}">` : `<div class="track-row__art"></div>`}
              <div class="track-row__body">
                <div class="track-row__title">${t.title}</div>
                <div class="track-row__subtitle">${i === q.currentIndex ? 'Now Playing' : t.artist}</div>
              </div>
            </div>
          `).join('') : `<div style="text-align:center; color:var(--ink-mute); padding:24px 0;">Queue is empty.</div>`}
        </div>
      `;
      sheet.querySelector('#np-queue-close').onclick = close;
      sheet.querySelector('#np-queue-autoplay').onclick = async () => {
        await Bridge.call('settings.setAutoplay', { enabled: !settings.autoplay });
        const s = await Bridge.call('settings.get');
        AppStore.set({ settings: s });
        renderBody();
      };
      sheet.querySelectorAll('[data-play]').forEach((row) => {
        row.onclick = () => Bridge.call('queue.playIndex', { index: Number(row.dataset.play) });
      });
    };

    const overlayUnsub = Bridge.on('queue.changed', (state) => { AppStore.set({ queueState: state }); renderBody(); });
    const close = () => { overlayUnsub?.(); closeOverlayAnimated(overlay, sheet); };
    overlay.onclick = close;
    document.body.appendChild(overlay);
    document.body.appendChild(sheet);
    renderBody();
  }

  // ---------------- slide to Lyrics ----------------
  function openLyrics(track) {
    if (!track) return;
    activePanel = 'lyrics';
    updateSliderPosition();
    syncVisualizerToPlaybackState();
    LyricsScreen.render(document.getElementById('np-panel-lyrics'), track, backToPlayer);
  }
  function backToPlayer() {
    activePanel = 'player';
    updateSliderPosition();
    syncVisualizerToPlaybackState();
  }
  function updateSliderPosition() {
    const slider = document.getElementById('np-slider');
    if (slider) slider.style.transform = activePanel === 'lyrics' ? 'translateX(-50%)' : 'translateX(0)';
  }

  return { render };
})();
