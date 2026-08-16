const LibraryScreen = (() => {
  // Order the filter chips are laid out in — determines slide direction on switch. 'all' isn't
  // a visible chip anymore but still anchors the leftmost/starting position for that ordering.
  const FILTER_ORDER = ['all', 'liked', 'mostPlayed', 'recentlyPlayed', 'trash'];
  let filter = 'all';
  let query = '';

  function fmtDuration(ms) {
    const total = Math.floor(ms / 1000);
    const m = Math.floor(total / 60);
    const s = String(total % 60).padStart(2, '0');
    return `${m}:${s}`;
  }

  function filteredTracks() {
    if (filter === 'trash' && !query.trim()) return AppStore.get('libraryTrash') || [];
    let list = AppStore.get('library') || [];
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter((t) => t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q));
    } else if (filter === 'liked') list = list.filter((t) => t.liked);
    else if (filter === 'mostPlayed') list = [...list].sort((a, b) => b.playCount - a.playCount);
    else if (filter === 'recentlyPlayed') list = list.filter((t) => t.lastPlayedAt).sort((a, b) => (b.lastPlayedAt||0) - (a.lastPlayedAt||0));
    return list;
  }

  function render(el) {
    // This page opts out of the default whole-page scroll (.page-slide's own overflow-y:auto)
    // in favor of a fixed header + one embedded-scrolling list beneath it — the search/filter/
    // play controls stay put while only the track list itself scrolls, and the embedded-scroll
    // frame's rounded corners crop the scrollbar cleanly at top and bottom (see components.css's
    // .embedded-scroll-frame/.embedded-scroll) instead of the whole page (and the scrollbar
    // riding along the search bar/buttons) scrolling as one long column.
    el.style.display = 'flex';
    el.style.flexDirection = 'column';
    el.style.overflow = 'hidden';
    el.innerHTML = `
      <div style="flex-shrink:0;">
        <div class="glass search-field" style="margin-bottom:12px;">
          ${Icons.search(16)}<input id="lib-search" placeholder="Search downloaded tracks" value="${query}">
        </div>
        <div class="lib-filter-grid" id="lib-filters">
          ${['liked','mostPlayed','recentlyPlayed','trash'].map(f => `
            <button class="chip glass icon-chip ${filter===f?'is-selected':''}" data-filter="${f}" title="${
              { liked: 'Liked Songs', mostPlayed: 'Most Played', recentlyPlayed: 'Recently Played', trash: 'Trash' }[f]
            }">${
              { liked: Icons.heart(18), mostPlayed: Icons.flame(18), recentlyPlayed: Icons.history(18), trash: Icons.trash(18) }[f]
            }</button>`).join('')}
        </div>
        <div class="lib-actions-row" style="display:flex; gap:10px; margin-bottom:14px;">
          <button class="btn-primary" id="lib-action-1" style="flex:1;"><span class="lib-action-label" id="lib-action-1-label"></span></button>
          <button class="btn-primary" id="lib-action-2" style="flex:1;"><span class="lib-action-label" id="lib-action-2-label"></span></button>
        </div>
      </div>
      <div class="glass embedded-scroll-frame embedded-scroll-frame--widget" style="flex:1; min-height:0;">
        <div class="embedded-scroll" id="lib-list"></div>
      </div>
    `;

    document.getElementById('lib-search').oninput = (e) => { query = e.target.value; renderList(); };
    el.querySelectorAll('[data-filter]').forEach((btn) => {
      btn.onclick = () => {
        // Toggle: tapping the already-active filter turns it back off, returning to the
        // default "everything" view — there's no separate "All" chip anymore, that state is
        // just "nothing toggled on".
        const prevFilter = filter;
        const next = btn.dataset.filter === filter ? 'all' : btn.dataset.filter;
        // Only the chip's color/text fades (handled entirely by .chip's existing CSS
        // transitions) — no transform/motion is ever applied to the chips themselves here.
        el.querySelectorAll('[data-filter]').forEach((b) => b.classList.toggle('is-selected', b.dataset.filter === next));
        filter = next;
        query = '';
        document.getElementById('lib-search').value = '';
        const direction = Math.sign(FILTER_ORDER.indexOf(next) - FILTER_ORDER.indexOf(prevFilter));
        if (filter === 'trash' && !(AppStore.get('libraryTrash') || []).length) {
          Bridge.call('library.trashList').then((list) => { AppStore.set({ libraryTrash: list }); renderActions(); renderList({ direction }); });
        }
        renderActions();
        renderList({ direction });
      };
    });

    if (filter === 'trash') Bridge.call('library.trashList').then((list) => AppStore.set({ libraryTrash: list }));

    renderActions();
    renderList();
  }

  /** The row directly under the filter chips — Play/Shuffle normally, Recover All/Delete All in
   *  Trash. The buttons themselves are persistent DOM nodes, created once in render() and never
   *  recreated/repositioned/faded on a filter change — only the text+icon inside each one
   *  crossfades to its new label. */
  function renderActions() {
    const label1 = document.getElementById('lib-action-1-label');
    const label2 = document.getElementById('lib-action-2-label');
    const btn1 = document.getElementById('lib-action-1');
    const btn2 = document.getElementById('lib-action-2');
    if (!label1 || !label2) return;

    const setLabel = (labelEl, html) => {
      labelEl.classList.add('is-swapping');
      setTimeout(() => {
        labelEl.innerHTML = html;
        labelEl.classList.remove('is-swapping');
      }, 120);
    };

    if (filter === 'trash') {
      setLabel(label1, `${Icons.restore(16)} Recover All`);
      setLabel(label2, `${Icons.trash(16)} Delete All`);
      btn2.style.color = 'var(--danger)';
      btn1.style.color = '';
      btn1.onclick = () => { Bridge.call('library.restoreAll'); AppStore.set({ libraryTrash: [] }); renderList(); };
      btn2.onclick = () => { Bridge.call('library.permanentlyDeleteAll'); AppStore.set({ libraryTrash: [] }); renderList(); };
    } else {
      setLabel(label1, `${Icons.play(16)} Play`);
      setLabel(label2, `${Icons.shuffle(16)} Shuffle`);
      btn1.style.color = '';
      btn2.style.color = '';
      btn1.onclick = () => {
        const ids = filteredTracks().map(t => t.id);
        Bridge.call('playback.playQueue', { trackIds: ids, startIndex: 0 });
      };
      btn2.onclick = () => {
        const ids = filteredTracks().map(t => t.id);
        Bridge.call('playback.playShuffled', { trackIds: ids });
      };
    }
  }

  function rowsHtml(list, isTrash) {
    if (list.length === 0) {
      return `<div style="text-align:center; color:var(--ink-mute); padding:40px 0;">${isTrash ? 'Trash is empty.' : 'No tracks yet — tap Discover to add one.'}</div>`;
    }
    return list.map((t) => `
      <div class="track-swipe" data-swipe-id="${t.id}">
        <div class="track-swipe__bg track-swipe__bg--left">${Icons.trash(18)} ${isTrash ? 'Delete Permanently' : 'Move to Trash'}</div>
        ${isTrash ? `<div class="track-swipe__bg track-swipe__bg--right">${Icons.restore(18)} Restore</div>` : ''}
        <div class="track-row" data-id="${t.id}">
          ${t.artworkPath ? `<img class="track-row__art" src="${artworkUrl(t.artworkPath)}">` : `<div class="track-row__art"></div>`}
          <div class="track-row__body">
            <div class="track-row__title">${t.title}</div>
            <div class="track-row__subtitle">${t.artist}</div>
          </div>
          <div class="track-row__meta">${fmtDuration(t.durationMs)}</div>
          ${isTrash ? '' : `<button class="icon-btn" data-like="${t.id}">${Icons.heart(18, t.liked)}</button>`}
        </div>
      </div>
    `).join('');
  }

  function wireRows(listEl, list, isTrash) {
    listEl.querySelectorAll('[data-id]').forEach((row) => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        const wrap = row.closest('.track-swipe');
        if (wrap && wrap.dataset.suppressClick === '1') { delete wrap.dataset.suppressClick; return; }
        if (isTrash) return; // trash rows don't play — only Restore/Delete apply
        const ids = list.map(t => t.id);
        Bridge.call('playback.playQueue', { trackIds: ids, startIndex: ids.indexOf(row.dataset.id) });
      });
    });
    listEl.querySelectorAll('[data-like]').forEach((btn) => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); Bridge.call('library.toggleLiked', { id: btn.dataset.like }); });
    });
    attachSwipeGestures(listEl);
  }

  const LIST_SLIDE_MS = 320;

  /** `opts.direction`: 1 = switching to a filter to the right in FILTER_ORDER (old tracks slide
   *  out left, new tracks slide in from the right — "forward"), -1 = the reverse ("backward"),
   *  0/undefined = no directional slide (search-as-you-type, or a live data push where the
   *  visible id set happened to change) — those just crossfade in place, matching the previous
   *  behavior, since a directional slide implies "you picked a different filter," which neither
   *  of those actually is. */
  function renderList(opts = {}) {
    const listEl = document.getElementById('lib-list');
    if (!listEl) return;
    const list = filteredTracks();
    const isTrash = filter === 'trash';

    const newIds = list.map(t => t.id).join(',');
    const changed = listEl.dataset.idsSnapshot !== newIds;
    listEl.dataset.idsSnapshot = newIds;

    const paint = () => {
      listEl.innerHTML = rowsHtml(list, isTrash);
      wireRows(listEl, list, isTrash);
    };

    if (!changed || !listEl.children.length) {
      paint();
      return;
    }

    const direction = opts.direction;
    if (direction === 1 || direction === -1) {
      // Outgoing: a plain visual clone (no listeners — cloneNode never copies them, and this
      // node never gets attachSwipeGestures called on it) positioned over the same spot via the
      // shared .embedded-scroll class, sliding out to the trailing edge while fading.
      const outgoing = document.createElement('div');
      outgoing.className = listEl.className;
      outgoing.style.pointerEvents = 'none';
      outgoing.innerHTML = listEl.innerHTML;
      outgoing.style.transition = `transform ${LIST_SLIDE_MS}ms cubic-bezier(0.22,1,0.36,1), opacity ${LIST_SLIDE_MS}ms ease`;
      listEl.parentElement.appendChild(outgoing);
      requestAnimationFrame(() => {
        outgoing.style.transform = `translateX(${direction > 0 ? '-100%' : '100%'})`;
        outgoing.style.opacity = '0';
      });
      setTimeout(() => outgoing.remove(), LIST_SLIDE_MS + 30);

      // Incoming: paint the new content immediately, offset just off the leading edge, then
      // animate to its resting position — giving the impression both lists are one continuous
      // strip sliding past each other rather than two separate fades.
      paint();
      listEl.style.transition = 'none';
      listEl.style.transform = `translateX(${direction > 0 ? '100%' : '-100%'})`;
      listEl.style.opacity = '0';
      void listEl.offsetWidth;
      listEl.style.transition = `transform ${LIST_SLIDE_MS}ms cubic-bezier(0.22,1,0.36,1), opacity ${LIST_SLIDE_MS}ms ease`;
      listEl.style.transform = 'translateX(0)';
      listEl.style.opacity = '1';
      setTimeout(() => { listEl.style.transition = ''; listEl.style.transform = ''; listEl.style.opacity = ''; }, LIST_SLIDE_MS + 30);
    } else {
      listEl.classList.add('is-list-out');
      setTimeout(() => {
        paint();
        listEl.classList.remove('is-list-out', 'is-list-in');
        void listEl.offsetWidth;
        listEl.classList.add('is-list-in');
      }, 140);
    }
  }

  /** Long-press fallback (500ms hold) exposing everything the swipe toolbar doesn't have room
   *  for — Equalizer and Voice Isolation — alongside the same Rename/Add to Playlist/Trash
   *  actions the swipe gestures cover. */
  function openFullTrackMenu(trackId) {
    const track = (AppStore.get('library') || []).find(t => t.id === trackId);
    if (!track) return;
    showActionSheet(track.title, [
      ['Rename', () => promptRename(track)],
      ['Add to Playlist', () => PlaylistsScreen.openAddToPlaylistPicker(trackId)],
      ['Equalizer', () => EqualizerScreen?.open?.(trackId, 'TRACK', track.title)],
      ...(track.derivedKind ? [] : [['Voice Isolation', () => VoiceIsolationFlow.open(trackId, track.title)]]),
      ['Move to Trash', () => Bridge.call('library.moveToTrash', { id: trackId })],
    ]);
  }

  function openTrashTrackMenu(trackId) {
    const track = (AppStore.get('library') || []).find(t => t.id === trackId);
    if (!track) return;
    showActionSheet(track.title, [
      ['Restore', () => Bridge.call('library.restore', { id: trackId })],
      ['Delete Permanently', () => Bridge.call('library.permanentlyDelete', { id: trackId })],
    ]);
  }

  /** Non-trash: swipe left (Gmail-style) → drag reveals a red Trash backdrop, releasing past the
   *  threshold moves the track to Trash; swipe right past the threshold opens the floating
   *  action toolbar (Close/Rename/Add to Playlist/Move to Trash). Trash filter: swipe left
   *  permanently deletes, swipe right restores — both commit immediately on release past the
   *  threshold, no toolbar (only one action each way).
   *
   *  Delegated on `listEl` itself (bound once) rather than on each `.track-row` individually —
   *  per-row binding was the previous approach, and while every renderList() call did rebind it
   *  on the fresh rows, this delegated form is immune to the whole class of "listener silently
   *  stops firing after some DOM churn" issue entirely (stale pointer captures on a since-removed
   *  element, a full-screen overlay eating a gesture mid-close, etc.) since there's exactly one
   *  listener, attached to a container that outlives its children, for the page's whole lifetime. */
  const SWIPE_THRESHOLD = 130;
  let swipeGesture = null; // { wrap, row, trackId, startX, startY, dx, axis, longPressTimer }

  function attachSwipeGestures(listEl) {
    if (listEl.__swipeDelegated) return;
    listEl.__swipeDelegated = true;

    const clearLongPress = () => {
      if (swipeGesture?.longPressTimer) { clearTimeout(swipeGesture.longPressTimer); swipeGesture.longPressTimer = null; }
    };
    const reset = (g) => {
      g.row.classList.add('is-swipe-animating');
      g.row.style.transform = 'translateX(0)';
      g.wrap.style.setProperty('--swipe-progress', '0');
      g.wrap.style.setProperty('--swipe-progress-right', '0');
      g.wrap.classList.remove('is-dragging-left', 'is-dragging-right');
    };
    const commit = (g, bridgeAction) => {
      g.row.classList.add('is-swipe-animating');
      g.row.style.transform = g.dx < 0 ? 'translateX(-100%)' : 'translateX(100%)';
      g.wrap.style.opacity = '0';
      setTimeout(() => {
        Bridge.call(bridgeAction, { id: g.trackId });
        AppStore.set({ libraryTrash: (AppStore.get('libraryTrash') || []).filter(t => t.id !== g.trackId) });
      }, 180);
    };

    listEl.addEventListener('pointerdown', (e) => {
      const wrap = e.target.closest('.track-swipe');
      if (!wrap || e.target.closest('button')) return;
      const row = wrap.querySelector('.track-row');
      const trackId = wrap.dataset.swipeId;
      row.classList.remove('is-swipe-animating');
      swipeGesture = { wrap, row, trackId, startX: e.clientX, startY: e.clientY, dx: 0, axis: null, longPressTimer: null };
      swipeGesture.longPressTimer = setTimeout(() => {
        wrap.dataset.suppressClick = '1';
        swipeGesture = null;
        if (filter === 'trash') openTrashTrackMenu(trackId); else openFullTrackMenu(trackId);
      }, 500);
    });

    listEl.addEventListener('pointermove', (e) => {
      const g = swipeGesture;
      if (!g) return;
      const rawDx = e.clientX - g.startX;
      const rawDy = e.clientY - g.startY;
      if (!g.axis) {
        if (Math.abs(rawDx) < 8 && Math.abs(rawDy) < 8) return;
        clearLongPress();
        g.axis = Math.abs(rawDx) > Math.abs(rawDy) ? 'x' : 'y';
        if (g.axis === 'y') { swipeGesture = null; return; }
        g.row.setPointerCapture(e.pointerId);
      }
      g.dx = rawDx;
      const isTrash = filter === 'trash';
      if (g.dx < 0) {
        const clamped = Math.max(g.dx, -140);
        g.row.style.transform = `translateX(${clamped}px)`;
        // Fade the backdrop in proportionally to drag distance instead of snapping to full
        // opacity the instant you move left at all — reaches full intensity only once you're
        // most of the way to the commit threshold.
        g.wrap.style.setProperty('--swipe-progress', String(Math.min(1, Math.abs(clamped) / SWIPE_THRESHOLD)));
        g.wrap.classList.add('is-dragging-left');
        g.wrap.classList.remove('is-dragging-right');
      } else if (isTrash) {
        const clamped = Math.min(g.dx, 140);
        g.row.style.transform = `translateX(${clamped}px)`;
        g.wrap.style.setProperty('--swipe-progress-right', String(Math.min(1, clamped / SWIPE_THRESHOLD)));
        g.wrap.classList.add('is-dragging-right');
        g.wrap.classList.remove('is-dragging-left');
      } else {
        g.row.style.transform = `translateX(${Math.min(g.dx * 0.35, 60)}px)`;
        g.wrap.classList.remove('is-dragging-left', 'is-dragging-right');
      }
    });

    const finish = () => {
      clearLongPress();
      const g = swipeGesture;
      if (!g) return;
      swipeGesture = null;
      const isTrash = filter === 'trash';
      if (g.axis === 'x' && Math.abs(g.dx) > 8) g.wrap.dataset.suppressClick = '1';
      if (g.axis === 'x' && g.dx <= -SWIPE_THRESHOLD) {
        commit(g, isTrash ? 'library.permanentlyDelete' : 'library.moveToTrash');
      } else if (g.axis === 'x' && isTrash && g.dx >= SWIPE_THRESHOLD) {
        commit(g, 'library.restore');
      } else if (g.axis === 'x' && !isTrash && g.dx >= SWIPE_THRESHOLD) {
        reset(g);
        openSwipeToolbar(g.trackId, g.wrap);
      } else {
        reset(g);
      }
    };
    listEl.addEventListener('pointerup', finish);
    listEl.addEventListener('pointercancel', finish);
  }

  function openSwipeToolbar(trackId, wrap) {
    const track = (AppStore.get('library') || []).find(t => t.id === trackId);
    if (!track) return;

    const overlay = document.createElement('div');
    overlay.className = 'swipe-toolbar-overlay';

    const toolbar = document.createElement('div');
    toolbar.className = 'glass glass--strong swipe-toolbar';

    const rowRect = wrap.getBoundingClientRect();
    const toolbarH = 84;
    const headerBottom = document.getElementById('global-header')?.getBoundingClientRect().bottom ?? 96;
    const miniPlayerTop = document.getElementById('mini-player')?.getBoundingClientRect().top ?? window.innerHeight - 24;
    let top = rowRect.top + rowRect.height / 2 - toolbarH / 2;
    top = Math.max(headerBottom + 10, Math.min(top, miniPlayerTop - toolbarH - 10));
    toolbar.style.top = `${top}px`;

    const actions = [
      { key: 'close', icon: Icons.close(20), label: 'Close', run: null },
      { key: 'rename', icon: Icons.pencil(20), label: 'Rename', run: () => promptRename(track) },
      { key: 'playlist', icon: Icons.playlistAdd(20), label: 'Add to Playlist', run: () => PlaylistsScreen.openAddToPlaylistPicker(trackId) },
      { key: 'trash', icon: Icons.trash(20), label: 'Move to Trash', run: () => Bridge.call('library.moveToTrash', { id: trackId }) },
    ];
    toolbar.innerHTML = actions.map((a) => `
      <button class="swipe-toolbar__btn ${a.key === 'trash' ? 'is-danger' : ''}" data-action="${a.key}">${a.icon}<span>${a.label}</span></button>
    `).join('');

    const close = () => closeOverlayAnimated(overlay, toolbar);
    overlay.addEventListener('click', close);
    toolbar.querySelectorAll('[data-action]').forEach((btn) => {
      const action = actions.find(a => a.key === btn.dataset.action);
      btn.addEventListener('click', () => { action.run?.(); close(); });
    });

    document.body.appendChild(overlay);
    document.body.appendChild(toolbar);
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

  Bridge.on('library.changed', (list) => { AppStore.set({ library: list }); if (Router.current === 'library' && filter !== 'trash') renderList(); });
  Bridge.on('library.trash.changed', (list) => { AppStore.set({ libraryTrash: list }); if (Router.current === 'library' && filter === 'trash') renderList(); });

  return { render };
})();

/** Minimal bottom action-sheet used by 3-dot menus across pages. Open animates in via the
 *  .action-sheet-card's own @keyframes (components.css); close is driven by closeOverlayAnimated
 *  so it animates back out instead of vanishing instantly. `onClose` (optional) fires once the
 *  sheet is actually gone — mainly so a trigger button can revert its own morph-icon state. */
function showActionSheet(title, actions, onClose) {
  const sheet = document.createElement('div');
  sheet.className = 'action-sheet-overlay';
  sheet.innerHTML = `
    <div class="glass glass--strong action-sheet-card">
      <div style="font-family:var(--font-display); font-weight:700; margin-bottom:10px; padding:0 6px;">${title}</div>
      ${actions.map((a, i) => `<button class="btn-glass" data-i="${i}" style="width:100%; justify-content:flex-start; padding:12px 10px;">${a[0]}</button>`).join('')}
    </div>
  `;
  const close = () => closeOverlayAnimated(sheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) close(); });
  sheet.querySelectorAll('[data-i]').forEach((btn) => {
    btn.addEventListener('click', () => { actions[Number(btn.dataset.i)][1](); close(); });
  });
  if (onClose) sheet.addEventListener('transitionend', onClose, { once: true });
  document.body.appendChild(sheet);
}
