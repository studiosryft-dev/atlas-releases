/** Queue indexed page — live playback queue + history. Whole-card drag-to-reorder (lift into a
 *  floating ghost + a placeholder gap that grows/shrinks into position, wiggle while dragging),
 *  live search with match highlight/dim + auto-scroll-snap between matches, and a pulse +
 *  mini-visualizer on the currently-playing card. */
const QueueScreen = (() => {
  let searchTerm = '';
  let matchIndices = [];
  let matchCursor = -1;
  let swipeGesture = null;
  const SWIPE_THRESHOLD = 90;

  /** Marks the Queue indexed page as "a track is currently in the user's hand" (either being
   *  drag-reordered or swiped to remove) — checked by app.js's page-level swipe-to-dismiss so a
   *  reorder-drag or a row swipe can never also be read as an attempt to close the whole screen,
   *  and vice versa: closing the screen never fights an in-progress row gesture, since dismissal
   *  is blocked outright for as long as this is set. */
  function setPageBusy(root, busy) {
    const page = root.closest('.indexed-page');
    if (page) page.dataset.suppressSwipeDismiss = busy ? '1' : '0';
  }

  function fmtDuration(ms) {
    const total = Math.floor((ms || 0) / 1000);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function highlight(text, term) {
    const safe = escapeHtml(text || '');
    if (!term) return safe;
    const idx = safe.toLowerCase().indexOf(term.toLowerCase());
    if (idx === -1) return safe;
    return `${safe.slice(0, idx)}<span class="search-highlight">${safe.slice(idx, idx + term.length)}</span>${safe.slice(idx + term.length)}`;
  }

  function content(root) {
    render(root);
  }

  function render(root) {
    const state = AppStore.get('queueState') || { queue: [], history: [], currentIndex: -1 };
    root.innerHTML = `
      <div class="indexed-page__mini-header">
        <div class="display" style="font-size:22px;">Queue</div>
        <div style="display:flex; gap:6px;">
          <button class="btn-glass glass" id="q-clear" style="height:36px; padding:0 14px; font-size:12px;">Clear Queue</button>
          <button class="icon-btn" id="q-close">${Icons.close(20)}</button>
        </div>
      </div>
      <div class="glass search-field" style="margin-bottom:14px;">
        ${Icons.search(16)}<input id="q-search" placeholder="Search queue" value="${escapeHtml(searchTerm)}">
        <button class="icon-btn" id="q-search-next" style="width:30px; height:30px; flex-shrink:0;">${Icons.chevronDown(16)}</button>
      </div>
      <div id="q-list"></div>
    `;
    root.querySelector('#q-close').onclick = () => closeIndexedPage('queue');
    root.querySelector('#q-clear').onclick = () => Bridge.call('queue.clear');

    const searchInput = root.querySelector('#q-search');
    searchInput.oninput = () => { searchTerm = searchInput.value.trim(); applySearch(root); };
    searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); jumpToNextMatch(root); } });
    root.querySelector('#q-search-next').onclick = () => jumpToNextMatch(root);

    renderList(root, state);
    applySearch(root);
  }

  function renderList(root, state) {
    const listEl = root.querySelector('#q-list');
    let html = '';
    if (state.history.length) {
      html += `<div class="divider-label">History</div>`;
      html += state.history.map((t, i) => `
        <div class="track-row" style="opacity:0.55;">
          ${t.artworkPath ? `<img class="track-row__art" src="${artworkUrl(t.artworkPath)}">` : `<div class="track-row__art"></div>`}
          <div class="track-row__body"><div class="track-row__title">${t.title}</div><div class="track-row__subtitle">${t.artist}</div></div>
          <button class="btn-glass glass" data-readd="${i}" style="height:30px; padding:0 10px; font-size:11px;">Re-add</button>
        </div>
      `).join('');
    }
    if (state.queue.length) {
      html += `<div class="divider-label">Up Next</div>`;
      html += `<div id="q-upnext">` + state.queue.map((t, i) => {
        const isPlaying = i === state.currentIndex;
        return `
        <div class="queue-row__placeholder-gap" data-gap="${i}"></div>
        <div class="track-swipe" data-swipe-index="${i}">
          <div class="track-swipe__bg track-swipe__bg--left">${Icons.trash(18)} Remove</div>
          <div class="track-swipe__bg track-swipe__bg--right">${Icons.trash(18)} Remove</div>
          <div class="track-row queue-row" data-play="${i}" data-index="${i}" style="${isPlaying ? 'background:rgba(255,255,255,0.06);' : ''}">
            <span class="icon-btn" style="width:20px; cursor:grab; color:var(--ink-mute);" data-handle="${i}" data-no-swipe-dismiss>${Icons.grip(16)}</span>
            ${t.artworkPath ? `<img class="track-row__art" src="${artworkUrl(t.artworkPath)}">` : `<div class="track-row__art"></div>`}
            <div class="track-row__body">
              <div class="track-row__title" data-title>${t.title}</div>
              <div class="track-row__subtitle" data-subtitle>${isPlaying ? `Now Playing<span class="queue-visualizer"><span></span><span></span><span></span></span>` : t.artist}</div>
            </div>
            <div class="track-row__meta">${fmtDuration(t.durationMs)}</div>
          </div>
        </div>
      `;
      }).join('') + `<div class="queue-row__placeholder-gap" data-gap="${state.queue.length}"></div></div>`;
    } else {
      html += `<div style="text-align:center; color:var(--ink-mute); padding:30px 0;">Queue is empty.</div>`;
    }
    listEl.innerHTML = html;

    listEl.querySelectorAll('[data-play]').forEach((row) => {
      row.addEventListener('click', () => { if (!row.dataset.suppressClick) Bridge.call('queue.playIndex', { index: Number(row.dataset.play) }); });
    });
    listEl.querySelectorAll('[data-readd]').forEach((btn) => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); Bridge.call('queue.reAddFromHistory', { historyIndex: Number(btn.dataset.readd) }); });
    });
    listEl.querySelectorAll('[data-handle]').forEach((handle) => {
      handle.addEventListener('pointerdown', (e) => startDrag(e, root, listEl, Number(handle.dataset.handle)));
    });
    const upNextForSwipe = root.querySelector('#q-upnext');
    if (upNextForSwipe) attachQueueSwipeGestures(root, upNextForSwipe);

    // Re-fetch state each time a currently-playing row needs its title/subtitle text refreshed
    // (search highlight rewrites innerHTML, so titles are re-highlighted from state.queue).
    listEl.__queueState = state.queue;
  }

  function applySearch(root) {
    const listEl = root.querySelector('#q-upnext');
    matchIndices = [];
    if (!listEl) return;
    const queue = root.querySelector('#q-list').__queueState || [];
    listEl.querySelectorAll('.queue-row').forEach((row) => {
      const idx = Number(row.dataset.index);
      const t = queue[idx];
      const titleEl = row.querySelector('[data-title]');
      const isPlaying = row.querySelector('.queue-visualizer') !== null;
      const term = searchTerm;
      const matches = !!term && (t.title || '').toLowerCase().includes(term.toLowerCase());
      titleEl.innerHTML = highlight(t.title, term);
      row.classList.toggle('is-dimmed', !!term && !matches);
      if (matches) matchIndices.push(idx);
    });
    matchCursor = -1;
    if (searchTerm && matchIndices.length > 0) scrollToMatch(root, matchIndices[0], false);
  }

  function jumpToNextMatch(root) {
    if (!matchIndices.length) return;
    matchCursor = (matchCursor + 1) % matchIndices.length;
    scrollToMatch(root, matchIndices[matchCursor], true);
  }

  function scrollToMatch(root, index, pulse) {
    const row = root.querySelector(`.queue-row[data-index="${index}"]`);
    if (!row) return;
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (pulse) {
      row.classList.remove('is-match-pulse');
      void row.offsetWidth;
      row.classList.add('is-match-pulse');
    }
  }

  // ---------------- drag to reorder ----------------
  function startDrag(e, root, listEl, fromIndex) {
    e.preventDefault();
    setPageBusy(root, true);
    if (e.pointerId != null && e.target.setPointerCapture) {
      try { e.target.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    }
    const upNext = root.querySelector('#q-upnext');
    const row = upNext.querySelector(`.queue-row[data-index="${fromIndex}"]`);
    if (!row) return;
    const rect = row.getBoundingClientRect();
    const rows = Array.from(upNext.querySelectorAll('.queue-row'));
    const gaps = Array.from(upNext.querySelectorAll('.queue-row__placeholder-gap'));

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

      // Walk rows in DOM order (already ascending by data-index) and stop at the first whose
      // vertical midpoint (viewport coords, so unaffected by any offsetParent quirks) the
      // pointer hasn't reached yet — the gap just before that row is the drop target. Falls
      // through to "after the last row" if the pointer is below everything.
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
      setPageBusy(root, false);
      // The browser dispatches a click right after pointerup — clear the suppression flag on
      // the next tick so that trailing click is swallowed instead of firing queue.playIndex.
      setTimeout(() => { delete row.dataset.suppressClick; }, 0);

      let toIndex = currentGapIndex;
      if (toIndex > fromIndex) toIndex -= 1;
      if (toIndex !== fromIndex) {
        Bridge.call('queue.reorder', { fromIndex, toIndex });
      }
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }

  /** Swipe LEFT or RIGHT on a queue row (not the drag handle) to remove it from the *queue*
   *  only — the Library track itself is untouched. Same pointer-delegation pattern as Library's
   *  swipe-to-trash (attachSwipeGestures in library.js), simplified: either direction commits
   *  the same "remove from queue" action rather than two different actions, since there's no
   *  trash/restore distinction here. */
  function attachQueueSwipeGestures(root, listEl) {
    if (listEl.__queueSwipeDelegated) return;
    listEl.__queueSwipeDelegated = true;

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
      setTimeout(() => Bridge.call('queue.remove', { index: g.index }), 180);
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
        setPageBusy(root, true); // owns this gesture now — page-level dismiss must not fire
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
      if (g.axis === 'x') setPageBusy(root, false);
    };
    listEl.addEventListener('pointerup', finish);
    listEl.addEventListener('pointercancel', finish);
  }

  Bridge.on('queue.changed', (state) => {
    AppStore.set({ queueState: state });
    const openPage = document.querySelector('.indexed-page[data-page="queue"].is-open');
    if (openPage) {
      const root = openPage.querySelector('.indexed-page__content');
      renderList(root, state);
      applySearch(root);
    }
  });

  return { content };
})();
