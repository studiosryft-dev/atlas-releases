const PlaylistsScreen = (() => {
  const PRESETS = ['aurora', 'ember', 'lagoon', 'nova', 'citrus', 'void'];
  const PRESET_COLORS = {
    aurora: ['#8B5CF6', '#38BDF8'], ember: ['#F97316', '#EF4444'], lagoon: ['#06B6D4', '#3B82F6'],
    nova: ['#D946EF', '#8B5CF6'], citrus: ['#FACC15', '#F97316'], void: ['#312E81', '#0F172A'],
  };

  function coverStyle(p) {
    const [c1, c2] = PRESET_COLORS[p.artworkMode] || PRESET_COLORS.aurora;
    return `background: radial-gradient(circle at 30% 30%, ${c1}, transparent 70%), radial-gradient(circle at 70% 70%, ${c2}, transparent 70%), #0a0a16;`;
  }

  function render(el) {
    const playlists = AppStore.get('playlists') || [];
    el.innerHTML = `
      <div style="margin-bottom:14px; font-family:var(--font-display); font-size:15px; color:var(--ink-dim);">${playlists.length} playlists</div>
      <div id="pl-grid" style="display:grid; grid-template-columns:1fr 1fr; gap:16px; padding-bottom:72px;"></div>
      <button class="glass glass--strong fab" id="pl-create" aria-label="New Playlist">${Icons.plus(24)}</button>
    `;
    document.getElementById('pl-create').onclick = createPlaylist;
    renderGrid();
  }

  function renderGrid() {
    const grid = document.getElementById('pl-grid');
    if (!grid) return;
    const playlists = AppStore.get('playlists') || [];
    if (playlists.length === 0) {
      grid.innerHTML = `<div style="grid-column:1/-1; text-align:center; color:var(--ink-mute); padding:40px 0;">No playlists yet.</div>`;
      return;
    }
    grid.innerHTML = playlists.map((p) => `
      <div data-id="${p.id}" class="pl-card">
        <div class="glass" style="aspect-ratio:1; border-radius:14px; ${coverStyle(p)}; animation:${p.animated ? 'glowPulse 4s ease-in-out infinite' : 'none'};"></div>
        <div style="display:flex; align-items:center; margin-top:6px;">
          <div style="flex:1; font-family:var(--font-display); font-weight:700; font-size:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${p.name}</div>
          <button class="icon-btn icon-morph-btn" data-edit="${p.id}">
            <span class="icon-morph-icon icon-morph-icon--a">${Icons.more(16)}</span>
            <span class="icon-morph-icon icon-morph-icon--b">${Icons.close(16)}</span>
          </button>
        </div>
      </div>
    `).join('');
    grid.querySelectorAll('[data-id]').forEach((card) => {
      card.addEventListener('click', (e) => { if (!e.target.closest('button')) openDetail(card.dataset.id); });
    });
    grid.querySelectorAll('[data-edit]').forEach((btn) => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); editPlaylist(btn.dataset.edit, btn); });
    });
  }

  async function createPlaylist() {
    const result = await promptDialog({ title: 'New Playlist', fields: [{ id: 'name', label: 'Playlist name' }], confirmLabel: 'Create' });
    if (!result || !result.name) return;
    Bridge.call('playlists.create', { name: result.name, artworkMode: PRESETS[Math.floor(Math.random() * PRESETS.length)] });
  }

  function editPlaylist(id, triggerBtn) {
    const p = (AppStore.get('playlists') || []).find(x => x.id === id);
    if (!p) return;
    triggerBtn?.classList.add('is-open');
    showActionSheet(p.name, [
      ['Rename', async () => {
        const result = await promptDialog({ title: 'Rename Playlist', fields: [{ id: 'name', label: 'Playlist name', value: p.name }] });
        if (result && result.name) Bridge.call('playlists.rename', { id, name: result.name });
      }],
      ['Toggle Animated Cover', () => Bridge.call('playlists.setAnimated', { id, animated: !p.animated })],
      ['Delete', async () => {
        const ok = await confirmDialog({ title: 'Delete Playlist?', body: `"${p.name}" will be removed. Tracks stay in your library.`, confirmLabel: 'Delete', danger: true });
        if (ok) Bridge.call('playlists.delete', { id });
      }],
    ], () => triggerBtn?.classList.remove('is-open'));
  }

  function fmtDuration(ms) {
    const total = Math.floor((ms || 0) / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${m}:${String(s).padStart(2, '0')}`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /** Playlist Detail — its own indexed page. Embedded-scroll track list (Library/Discover's own
   *  frame-crops-the-scrollbar widget, not raw indexed-page overflow — a long playlist used to
   *  just spill past the page), an extended header carrying real stats (track count, total
   *  duration, times played — the last one backed by PlaylistEntity.playCount, bumped natively
   *  once per Play/Shuffle here), and inline pencil-edit rename (swaps the name for a text input
   *  in place, no popup) instead of routing through the grid's action-sheet Rename. Drag-reorder
   *  and swipe-to-remove are ported from Queue's own implementation (js/screens/queue.js) —
   *  same gesture code, same .track-swipe/.queue-row CSS, adapted to call playlists.reorder/
   *  removeTrack and to work off this closure's local `tracks` array (there's no live per-
   *  playlist track push the way Queue has queue.changed, so state here is optimistically
   *  updated in place after each gesture rather than reactively re-rendered from a Bridge.on). */
  async function openDetail(id) {
    let p = (AppStore.get('playlists') || []).find((x) => x.id === id);
    let tracks = await Bridge.call('playlists.getTracks', { id });
    let editingName = false;
    let swipeGesture = null;
    const SWIPE_THRESHOLD = 90;

    openIndexedPage('playlistDetail', (content) => renderDetail(content));

    function renderDetail(content) {
      content.style.display = 'flex';
      content.style.flexDirection = 'column';
      content.style.overflow = 'hidden';
      content.style.height = '100%';
      const totalMs = tracks.reduce((sum, t) => sum + (t.durationMs || 0), 0);
      content.innerHTML = `
        <div class="indexed-page__mini-header" style="flex-shrink:0;">
          <div class="display" style="font-size:22px;">Playlist</div>
          <button class="icon-btn" id="pd-close">${Icons.close(20)}</button>
        </div>
        <div class="pd-title-row" style="flex-shrink:0;">
          ${editingName
            ? `<input class="pd-title-input" id="pd-title-input" value="${escapeHtml(p.name)}">`
            : `<div class="pd-title" id="pd-title">${escapeHtml(p.name)}</div>`}
          <button class="icon-btn" id="pd-edit-name">${editingName ? Icons.check(16) : Icons.pencil(16)}</button>
        </div>
        <div class="pd-stats-row" style="flex-shrink:0;">
          <span>${tracks.length} track${tracks.length === 1 ? '' : 's'}</span>
          <span class="pd-stats-dot">•</span>
          <span>${fmtDuration(totalMs)}</span>
          <span class="pd-stats-dot">•</span>
          <span>Played ${p.playCount || 0}×</span>
        </div>
        <div style="display:flex; gap:10px; margin:14px 0; flex-shrink:0;">
          <button class="btn-primary" id="pd-play" style="flex:1;">${Icons.play(16)} Play</button>
          <button class="btn-primary" id="pd-shuffle" style="flex:1;">${Icons.shuffle(16)} Shuffle</button>
        </div>
        <div class="glass embedded-scroll-frame embedded-scroll-frame--widget" style="flex:1; min-height:0;">
          <div class="embedded-scroll" id="pd-list"></div>
        </div>
      `;

      content.querySelector('#pd-close').onclick = () => closeIndexedPage('playlistDetail');
      const ids = () => tracks.map((t) => t.id);
      content.querySelector('#pd-play').onclick = () => {
        Bridge.call('playback.playQueue', { trackIds: ids(), startIndex: 0, playlistContextId: id });
        p = { ...p, playCount: (p.playCount || 0) + 1 };
      };
      content.querySelector('#pd-shuffle').onclick = () => {
        Bridge.call('playback.playShuffled', { trackIds: ids(), playlistContextId: id });
        p = { ...p, playCount: (p.playCount || 0) + 1 };
      };

      if (editingName) {
        const input = content.querySelector('#pd-title-input');
        input.focus();
        input.select();
        let committed = false;
        const commit = async () => {
          if (committed) return;
          committed = true;
          const newName = input.value.trim();
          editingName = false;
          if (newName && newName !== p.name) {
            p = { ...p, name: newName };
            await Bridge.call('playlists.rename', { id, name: newName });
          }
          renderDetail(content);
        };
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          else if (e.key === 'Escape') { committed = true; editingName = false; renderDetail(content); }
        });
        input.addEventListener('blur', commit);
      } else {
        content.querySelector('#pd-edit-name').onclick = () => { editingName = true; renderDetail(content); };
      }

      renderTrackList(content);
    }

    function renderTrackList(content) {
      const listEl = content.querySelector('#pd-list');
      listEl.innerHTML = tracks.length ? tracks.map((t, i) => `
        <div class="queue-row__placeholder-gap" data-gap="${i}"></div>
        <div class="track-swipe" data-swipe-index="${i}">
          <div class="track-swipe__bg track-swipe__bg--left">${Icons.close(18)} Remove</div>
          <div class="track-swipe__bg track-swipe__bg--right">${Icons.close(18)} Remove</div>
          <div class="track-row queue-row" data-index="${i}">
            <span class="icon-btn" style="width:20px; cursor:grab; color:var(--ink-mute);" data-handle="${i}" data-no-swipe-dismiss>${Icons.grip(16)}</span>
            ${t.artworkPath ? `<img class="track-row__art" src="${artworkUrl(t.artworkPath)}">` : `<div class="track-row__art"></div>`}
            <div class="track-row__body"><div class="track-row__title">${t.title}</div><div class="track-row__subtitle">${t.artist}</div></div>
            <div class="track-row__meta">${fmtDuration(t.durationMs)}</div>
          </div>
        </div>
      `).join('') + `<div class="queue-row__placeholder-gap" data-gap="${tracks.length}"></div>`
        : `<div style="text-align:center; color:var(--ink-mute); padding:30px 0;">No tracks in this playlist yet.</div>`;

      listEl.querySelectorAll('[data-handle]').forEach((handle) => {
        handle.addEventListener('pointerdown', (e) => startDrag(e, content, listEl, Number(handle.dataset.handle)));
      });
      attachSwipeGestures(content, listEl);
    }

    // ---------------- drag to reorder (ported from queue.js's startDrag) ----------------
    function startDrag(e, content, listEl, fromIndex) {
      e.preventDefault();
      setPageBusy(content, true);
      if (e.pointerId != null && e.target.setPointerCapture) {
        try { e.target.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      }
      const row = listEl.querySelector(`.queue-row[data-index="${fromIndex}"]`);
      if (!row) return;
      const rect = row.getBoundingClientRect();
      const rows = Array.from(listEl.querySelectorAll('.queue-row'));
      const gaps = Array.from(listEl.querySelectorAll('.queue-row__placeholder-gap'));

      row.dataset.suppressClick = '1';

      const ghost = row.cloneNode(true);
      ghost.classList.add('is-dragging');
      ghost.style.position = 'fixed';
      ghost.style.left = rect.left + 'px';
      ghost.style.top = rect.top + 'px';
      ghost.style.width = rect.width + 'px';
      ghost.style.pointerEvents = 'none';
      document.body.appendChild(ghost);
      row.style.visibility = 'hidden';

      let currentGapIndex = fromIndex;
      gaps[currentGapIndex].classList.add('is-open');

      const startY = e.clientY;
      const onMove = (ev) => {
        const dy = ev.clientY - startY;
        ghost.style.top = (rect.top + dy) + 'px';
        let newGapIndex = rows.length;
        for (const r of rows) {
          if (r === row) continue;
          const rRect = r.getBoundingClientRect();
          if (ev.clientY < rRect.top + rRect.height / 2) { newGapIndex = Number(r.dataset.index); break; }
        }
        if (newGapIndex !== currentGapIndex) {
          gaps[currentGapIndex].classList.remove('is-open');
          currentGapIndex = newGapIndex;
          gaps[currentGapIndex].classList.add('is-open');
        }
      };
      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        ghost.remove();
        gaps[currentGapIndex].classList.remove('is-open');
        row.style.visibility = '';
        setPageBusy(content, false);
        setTimeout(() => { delete row.dataset.suppressClick; }, 0);

        let toIndex = currentGapIndex;
        if (toIndex > fromIndex) toIndex -= 1;
        if (toIndex !== fromIndex) {
          const moved = tracks.splice(fromIndex, 1)[0];
          tracks.splice(toIndex, 0, moved);
          Bridge.call('playlists.reorder', { playlistId: id, trackIds: tracks.map((t) => t.id) });
          renderTrackList(content);
        }
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    }

    // ---------------- swipe left/right to remove (ported from queue.js) ----------------
    function attachSwipeGestures(content, listEl) {
      // #pd-list itself persists across renderTrackList() calls (only its innerHTML is replaced
      // on reorder/remove) — without this guard, calling attachSwipeGestures again on every
      // re-render would stack a fresh set of delegated pointer listeners onto the same element
      // each time, same risk queue.js's own attachQueueSwipeGestures already guards against.
      if (listEl.__pdSwipeDelegated) return;
      listEl.__pdSwipeDelegated = true;

      const reset = (g) => {
        g.row.classList.add('is-swipe-animating');
        g.row.style.transform = 'translateX(0)';
        g.wrap.style.setProperty('--swipe-progress', '0');
        g.wrap.style.setProperty('--swipe-progress-right', '0');
        g.wrap.classList.remove('is-dragging-left', 'is-dragging-right');
      };
      const commit = (g) => {
        g.row.classList.add('is-swipe-animating');
        g.row.style.transform = g.dx < 0 ? 'translateX(-100%)' : 'translateX(100%)';
        g.wrap.style.opacity = '0';
        setTimeout(() => {
          const removed = tracks[g.index];
          if (!removed) return;
          tracks.splice(g.index, 1);
          Bridge.call('playlists.removeTrack', { playlistId: id, trackId: removed.id });
          renderTrackList(content);
        }, 180);
      };

      listEl.addEventListener('pointerdown', (e) => {
        const wrap = e.target.closest('.track-swipe');
        if (!wrap || e.target.closest('[data-handle]')) return;
        const row = wrap.querySelector('.queue-row');
        row.classList.remove('is-swipe-animating');
        swipeGesture = { wrap, row, index: Number(wrap.dataset.swipeIndex), startX: e.clientX, startY: e.clientY, dx: 0, axis: null };
      });

      listEl.addEventListener('pointermove', (e) => {
        const g = swipeGesture;
        if (!g) return;
        const rawDx = e.clientX - g.startX;
        const rawDy = e.clientY - g.startY;
        if (!g.axis) {
          if (Math.abs(rawDx) < 8 && Math.abs(rawDy) < 8) return;
          g.axis = Math.abs(rawDx) > Math.abs(rawDy) ? 'x' : 'y';
          if (g.axis === 'y') { swipeGesture = null; return; }
          g.row.setPointerCapture(e.pointerId);
          setPageBusy(content, true);
        }
        g.dx = rawDx;
        const clamped = Math.max(-140, Math.min(140, g.dx));
        g.row.style.transform = `translateX(${clamped}px)`;
        if (clamped < 0) {
          g.wrap.style.setProperty('--swipe-progress', String(Math.min(1, Math.abs(clamped) / SWIPE_THRESHOLD)));
          g.wrap.classList.add('is-dragging-left');
          g.wrap.classList.remove('is-dragging-right');
        } else {
          g.wrap.style.setProperty('--swipe-progress-right', String(Math.min(1, clamped / SWIPE_THRESHOLD)));
          g.wrap.classList.add('is-dragging-right');
          g.wrap.classList.remove('is-dragging-left');
        }
      });

      const finish = () => {
        const g = swipeGesture;
        swipeGesture = null;
        if (!g) return;
        if (g.axis === 'x' && Math.abs(g.dx) > 8) {
          g.row.dataset.suppressClick = '1';
          setTimeout(() => { delete g.row.dataset.suppressClick; }, 0);
        }
        if (g.axis === 'x' && Math.abs(g.dx) >= SWIPE_THRESHOLD) commit(g); else reset(g);
        if (g.axis === 'x') setPageBusy(content, false);
      };
      listEl.addEventListener('pointerup', finish);
      listEl.addEventListener('pointercancel', finish);
    }

    /** Same purpose as Queue's own setPageBusy — flags this indexed page so app.js's page-level
     *  swipe-down-to-dismiss can't fire while a reorder-drag or a row swipe is in progress. */
    function setPageBusy(content, busy) {
      const page = content.closest('.indexed-page');
      if (page) page.dataset.suppressSwipeDismiss = busy ? '1' : '0';
    }
  }

  /** Custom styled sheet (not the generic showActionSheet) — playlist cover thumbnails, a quick
   *  "New Playlist" row, and a per-row checkmark that animates in place once a track's actually
   *  been added, instead of just closing the sheet with no confirmation. */
  function openAddToPlaylistPicker(trackId) {
    const playlists = AppStore.get('playlists') || [];
    const sheet = document.createElement('div');
    sheet.className = 'action-sheet-overlay';

    const rowsHtml = playlists.length ? playlists.map((p) => `
      <button class="atp-row" data-playlist="${p.id}">
        <div class="glass atp-row__cover" style="${coverStyle(p)}"></div>
        <div class="atp-row__name">${p.name}</div>
        <span class="atp-row__check">${Icons.check(15)}</span>
      </button>
    `).join('') : `<div style="text-align:center; color:var(--ink-mute); padding:20px 0;">No playlists yet — create one below.</div>`;

    sheet.innerHTML = `
      <div class="glass glass--strong action-sheet-card">
        <div style="font-family:var(--font-display); font-weight:700; margin-bottom:10px; padding:0 6px;">Add to Playlist</div>
        <div class="atp-list">${rowsHtml}</div>
        <button class="btn-glass glass" id="atp-new" style="width:100%; margin-top:10px;">${Icons.plus(16)} New Playlist</button>
      </div>
    `;
    const close = () => closeOverlayAnimated(sheet);
    sheet.addEventListener('click', (e) => { if (e.target === sheet) close(); });
    sheet.querySelectorAll('[data-playlist]').forEach((row) => {
      row.onclick = async () => {
        if (row.classList.contains('is-added')) return;
        row.classList.add('is-added');
        await Bridge.call('playlists.addTrack', { playlistId: row.dataset.playlist, trackId });
        setTimeout(close, 420);
      };
    });
    sheet.querySelector('#atp-new').onclick = async () => {
      const result = await promptDialog({ title: 'New Playlist', fields: [{ id: 'name', label: 'Playlist name' }], confirmLabel: 'Create' });
      if (!result || !result.name) return;
      const artworkMode = PRESETS[Math.floor(Math.random() * PRESETS.length)];
      const created = await Bridge.call('playlists.create', { name: result.name, artworkMode });
      if (created?.id) Bridge.call('playlists.addTrack', { playlistId: created.id, trackId });
      close();
    };
    document.body.appendChild(sheet);
  }

  Bridge.on('playlists.changed', (list) => { AppStore.set({ playlists: list }); if (Router.current === 'playlists') renderGrid(); });

  return { render, openAddToPlaylistPicker };
})();
