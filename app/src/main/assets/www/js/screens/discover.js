/** Discover indexed page — one search field (accepts either a text query or a pasted YouTube
 *  link), one tall embedded-scrolling results list, and a fixed bottom bar (Download + quality,
 *  Import Playlists as Playlists). Results animate in; the search field, header, and bottom bar
 *  never move/resize — same "fixed chrome + one internally-scrolling list" layout Library uses.
 *
 *  Selection is multi-select and persists across searches: selectedByUrl is a Map keyed by each
 *  result's own `url` (stable identity independent of which search produced it), so selecting 3
 *  tracks in one search and 2 in a completely different search leaves all 5 selected — checking
 *  a track already in the map (from a previous search whose results are no longer on screen)
 *  still shows as checked if it happens to reappear, and Deselect All/bulk download always act
 *  on the full cross-search set, not just what's currently visible. */
const DiscoverScreen = (() => {
  let results = [];
  let selectedByUrl = new Map(); // url -> result object (title/sub/thumbnailUrl/url/isPlaylist/entryCount)
  let importPlaylistsAsPlaylists = true;
  let selectedPanelOpen = false;

  function isUrlLike(q) {
    return /^https?:\/\//i.test(q) || /(youtube\.com|youtu\.be)/i.test(q);
  }

  function selectionCounts() {
    let playlistCount = 0, trackCount = 0, totalSongs = 0;
    selectedByUrl.forEach((r) => {
      if (r.isPlaylist) { playlistCount++; totalSongs += r.entryCount || 0; }
      else { trackCount++; totalSongs += 1; }
    });
    return { playlistCount, trackCount, totalSongs, total: selectedByUrl.size };
  }

  function content(root) {
    const settings = AppStore.get('settings') || {};
    root.style.display = 'flex';
    root.style.flexDirection = 'column';
    root.style.overflow = 'hidden';
    root.style.height = '100%';
    root.innerHTML = `
      <div style="flex-shrink:0;">
        <div class="indexed-page__mini-header" style="margin-bottom:12px;">
          <div class="display" style="font-size:22px;">Discover</div>
          <button class="icon-btn" id="disc-close">${Icons.close(20)}</button>
        </div>
        <div style="display:flex; gap:8px; margin-bottom:14px;">
          <div class="glass search-field" style="flex:1;">
            ${Icons.search(16)}<input id="disc-search" placeholder="Search YouTube or paste a link…">
          </div>
          <button class="icon-btn glass" id="disc-search-btn">${Icons.search(18)}</button>
        </div>
      </div>

      <div id="disc-select-region" style="position:relative; flex:1; min-height:0; display:flex; flex-direction:column;">
        <div class="glass embedded-scroll-frame embedded-scroll-frame--widget" style="flex:1; min-height:0;">
          <div class="embedded-scroll" id="disc-results"></div>
        </div>

        <div style="flex-shrink:0; display:flex; gap:8px; margin-top:10px;">
          <button class="btn-glass glass" id="disc-deselect-all" style="flex:1;">Deselect All</button>
          <button class="btn-glass glass" id="disc-view-selected" style="flex:1;">View Selected</button>
        </div>
      </div>

      <div style="flex-shrink:0; margin-top:14px;">
        <div style="display:flex; align-items:center; gap:10px;">
          <button class="btn-primary" id="disc-download" style="flex:1;" disabled>
            ${Icons.download(16)} <span class="disc-dl-label" id="disc-dl-label">Download Track</span>
          </button>
          ${GlassDropdown.html('disc-quality', qualityLabel(settings.audioQuality))}
        </div>
        <div id="disc-dl-subtext" class="disc-dl-subtext"></div>
        <div style="display:flex; align-items:center; margin-top:14px;">
          <div style="flex:1; display:flex; align-items:center; gap:6px;">
            <span>Import playlists as playlists</span>
            <button class="icon-btn" id="disc-playlist-info" style="width:24px; height:24px;">${Icons.info(14)}</button>
          </div>
          <div class="switch ${importPlaylistsAsPlaylists ? 'is-on' : ''}" id="disc-playlist-toggle"></div>
        </div>
      </div>
    `;

    root.querySelector('#disc-close').onclick = () => closeIndexedPage('discover');
    root.querySelector('#disc-search-btn').onclick = runSearch;
    root.querySelector('#disc-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });

    GlassDropdown.wire('disc-quality', QUALITY_OPTIONS, settings.audioQuality || 'HIGH', async (quality) => {
      AppStore.set({ settings: { ...AppStore.get('settings'), audioQuality: quality } });
      await Bridge.call('settings.setAudioQuality', { quality });
    });
    root.querySelector('#disc-playlist-info').onclick = () => {
      Notifications.show({
        icon: 'info',
        title: 'Import playlists as playlists',
        body: 'On: a downloaded YouTube playlist becomes its own playlist here. Off: every track downloads straight into your library individually.',
      });
    };
    root.querySelector('#disc-playlist-toggle').onclick = (e) => {
      importPlaylistsAsPlaylists = !importPlaylistsAsPlaylists;
      e.target.classList.toggle('is-on', importPlaylistsAsPlaylists);
    };
    root.querySelector('#disc-download').onclick = downloadSelected;
    root.querySelector('#disc-deselect-all').onclick = deselectAll;
    root.querySelector('#disc-view-selected').onclick = openSelectedPanel;

    results = [];
    selectedPanelOpen = false;
    renderResults();
    updateDownloadButton();
  }

  function renderResults() {
    const resultsEl = document.getElementById('disc-results');
    if (!resultsEl) return;
    resultsEl.innerHTML = results.length ? results.map((r, i) => `
      <div class="track-row disc-result-row ${selectedByUrl.has(r.url) ? 'is-selected' : ''}" data-url="${escapeAttr(r.url)}" style="animation:fadeSlideUp 260ms ${Math.min(i, 10) * 35}ms both;">
        ${r.thumbnailUrl ? `<img class="track-row__art" src="${r.thumbnailUrl}">` : `<div class="track-row__art"></div>`}
        <div class="track-row__body">
          <div class="track-row__title">${r.isPlaylist ? `<span class="playlist-badge">${Icons.playlist(13)}Playlist</span> ` : ''}${r.title}</div>
          <div class="track-row__subtitle">${r.isPlaylist ? `${r.entryCount} tracks` : r.sub}</div>
        </div>
        <span class="disc-result-check">${Icons.check(14)}</span>
      </div>
    `).join('') : `<div style="text-align:center; color:var(--ink-mute); padding:40px 20px;">Search YouTube or paste a link to get started.</div>`;

    resultsEl.querySelectorAll('[data-url]').forEach((row) => {
      row.onclick = () => {
        const r = results.find((x) => x.url === row.dataset.url);
        if (!r) return;
        toggleSelection(r);
        row.classList.toggle('is-selected', selectedByUrl.has(r.url));
        updateDownloadButton();
      };
    });
  }

  function escapeAttr(s) { return String(s).replace(/"/g, '&quot;'); }

  function toggleSelection(r) {
    if (selectedByUrl.has(r.url)) selectedByUrl.delete(r.url);
    else selectedByUrl.set(r.url, r);
  }

  function deselectAll() {
    if (!selectedByUrl.size) return;
    selectedByUrl.clear();
    renderResults();
    updateDownloadButton();
    if (selectedPanelOpen) closeSelectedPanel();
  }

  /** Crossfades the button label text (same technique as Library's Play/Shuffle <-> Recover/
   *  Delete swap) so the label morphing between "Download Track" / "Download N Tracks" /
   *  "Download P Playlist(s) and T Track(s)" reads as a smooth change, not a jump-cut. The
   *  "N Total Songs" subtext beneath fades/slides in only once a playlist is part of the
   *  selection (that's the only time "songs downloaded" and "items selected" actually differ). */
  function updateDownloadButton() {
    const btn = document.getElementById('disc-download');
    const label = document.getElementById('disc-dl-label');
    const subtext = document.getElementById('disc-dl-subtext');
    if (!btn || !label) return;
    const { playlistCount, trackCount, totalSongs, total } = selectionCounts();
    btn.disabled = total === 0;

    let next;
    if (total === 0) next = 'Download Track';
    else if (playlistCount === 0) next = trackCount === 1 ? 'Download Track' : `Download ${trackCount} Tracks`;
    else next = `Download ${playlistCount} Playlist${playlistCount === 1 ? '' : 's'} and ${trackCount} Track${trackCount === 1 ? '' : 's'}`;

    if (label.textContent !== next) {
      label.classList.add('is-swapping');
      setTimeout(() => { label.textContent = next; label.classList.remove('is-swapping'); }, 120);
    }
    if (subtext) {
      if (playlistCount > 0) {
        subtext.textContent = `${totalSongs} Total Song${totalSongs === 1 ? '' : 's'}`;
        subtext.classList.add('is-visible');
      } else {
        subtext.classList.remove('is-visible');
      }
    }
  }

  async function runSearch() {
    const input = document.getElementById('disc-search');
    const q = input.value.trim();
    const resultsEl = document.getElementById('disc-results');
    if (!q) return;
    resultsEl.innerHTML = `<div style="text-align:center; color:var(--ink-mute); padding:30px;">Searching…</div>`;
    try {
      if (isUrlLike(q)) {
        const info = await Bridge.call('youtube.getInfo', { url: q });
        const isPlaylist = !!info.entries;
        results = [{
          title: info.title,
          sub: info.artist,
          thumbnailUrl: info.thumbnailUrl,
          url: q,
          isPlaylist,
          entryCount: isPlaylist ? info.entries.length : 0,
        }];
      } else {
        const raw = await Bridge.call('youtube.search', { query: q });
        results = raw.map((r) => ({ title: r.title, sub: r.artist, thumbnailUrl: r.thumbnailUrl, url: r.url, isPlaylist: false, entryCount: 0 }));
      }
    } catch (e) {
      resultsEl.innerHTML = `<div style="color:var(--danger); padding:16px;">${e.message}</div>`;
      results = [];
    }
    renderResults();
    updateDownloadButton();
  }

  async function downloadSelected() {
    const items = [...selectedByUrl.values()];
    if (!items.length) return;
    const btn = document.getElementById('disc-download');
    btn.disabled = true;
    try {
      // No "download started" toast per item on purpose — the only notification is the native
      // "Download complete" one fired per completed item, which is what actually matters.
      await Promise.all(items.map((r) => Bridge.call('downloadQueue.enqueue', { url: r.url, asPlaylist: r.isPlaylist && importPlaylistsAsPlaylists })));
      selectedByUrl.clear();
      renderResults();
      if (selectedPanelOpen) closeSelectedPanel();
    } finally {
      updateDownloadButton();
    }
  }

  /** "View Selected" — the glass Deselect All + View Selected button row genuinely expands
   *  (FLIP: capture the row's real on-screen rect, animate width/height/position/radius from
   *  that rect up to fully covering the results frame + button row) into a full glassmorphic
   *  panel listing every selected item, rather than just opening a plain new overlay. Once the
   *  expand transition finishes, each row fades + slides in from the right, sequentially. Ticking
   *  a row's checkbox off animates it out to the left and the panel's own list reflows the rows
   *  below it up into its place. Closing reverses the same expand animation back down to the
   *  button row's own shape before removing the panel. */
  function openSelectedPanel() {
    if (selectedPanelOpen || !selectedByUrl.size) return;
    selectedPanelOpen = true;
    const region = document.getElementById('disc-select-region');
    const originBtn = document.getElementById('disc-view-selected');
    if (!region || !originBtn) return;
    const regionRect = region.getBoundingClientRect();
    const startRect = originBtn.getBoundingClientRect();

    const panel = document.createElement('div');
    panel.className = 'glass glass--strong disc-selected-panel';
    panel.id = 'disc-selected-panel';
    panel.style.left = `${startRect.left - regionRect.left}px`;
    panel.style.top = `${startRect.top - regionRect.top}px`;
    panel.style.width = `${startRect.width}px`;
    panel.style.height = `${startRect.height}px`;
    panel.style.borderRadius = 'var(--glass-radius-pill)';
    panel.style.opacity = '0';
    region.appendChild(panel);

    requestAnimationFrame(() => {
      panel.style.transition = 'left 380ms var(--ease-standard), top 380ms var(--ease-standard), width 380ms var(--ease-standard), height 380ms var(--ease-standard), border-radius 380ms var(--ease-standard), opacity 200ms var(--ease-standard)';
      panel.style.left = '0px';
      panel.style.top = '0px';
      panel.style.width = `${regionRect.width}px`;
      panel.style.height = `${regionRect.height}px`;
      panel.style.borderRadius = 'var(--glass-radius-lg)';
      panel.style.opacity = '1';
    });

    const onExpandDone = (e) => {
      if (e.target !== panel || e.propertyName !== 'width') return;
      panel.removeEventListener('transitionend', onExpandDone);
      renderSelectedPanelContent(panel);
    };
    panel.addEventListener('transitionend', onExpandDone);
  }

  function renderSelectedPanelContent(panel) {
    const items = [...selectedByUrl.values()];
    panel.innerHTML = `
      <div class="disc-selected-panel__header">
        <div class="display" style="font-size:16px;">Selected (${items.length})</div>
        <button class="icon-btn" id="dsp-close">${Icons.close(18)}</button>
      </div>
      <div class="embedded-scroll disc-selected-panel__list" id="dsp-list"></div>
    `;
    panel.querySelector('#dsp-close').onclick = closeSelectedPanel;
    const listEl = panel.querySelector('#dsp-list');
    listEl.innerHTML = items.map((r, i) => `
      <div class="track-row disc-selected-row" data-url="${escapeAttr(r.url)}" style="animation:dspRowIn 320ms ${i * 55}ms both;">
        ${r.thumbnailUrl ? `<img class="track-row__art" src="${r.thumbnailUrl}">` : `<div class="track-row__art"></div>`}
        <div class="track-row__body">
          <div class="track-row__title">${r.isPlaylist ? `<span class="playlist-badge">${Icons.playlist(13)}Playlist</span> ` : ''}${r.title}</div>
          <div class="track-row__subtitle">${r.isPlaylist ? `${r.entryCount} tracks` : r.sub}</div>
        </div>
        <span class="disc-result-check is-selected" style="opacity:1; transform:scale(1);">${Icons.check(14)}</span>
      </div>
    `).join('');
    listEl.querySelectorAll('.disc-selected-row').forEach((row) => {
      row.onclick = () => {
        const url = row.dataset.url;
        selectedByUrl.delete(url);
        row.classList.add('is-removing');
        row.style.height = `${row.getBoundingClientRect().height}px`;
        requestAnimationFrame(() => {
          row.style.height = '0px';
          row.style.marginTop = '0px';
          row.style.marginBottom = '0px';
          row.style.paddingTop = '0px';
          row.style.paddingBottom = '0px';
          row.style.overflow = 'hidden';
        });
        setTimeout(() => {
          row.remove();
          updateDownloadButton();
          renderResults(); // keep the base list's checkmarks in sync
          const remaining = document.querySelectorAll('#dsp-list .disc-selected-row').length;
          const countEl = panel.querySelector('.disc-selected-panel__header .display');
          if (countEl) countEl.textContent = `Selected (${remaining})`;
          if (remaining === 0) closeSelectedPanel();
        }, 260);
      };
    });
  }

  function closeSelectedPanel() {
    const panel = document.getElementById('disc-selected-panel');
    const region = document.getElementById('disc-select-region');
    const originBtn = document.getElementById('disc-view-selected');
    if (!panel || !region || !originBtn) { selectedPanelOpen = false; return; }
    const regionRect = region.getBoundingClientRect();
    const endRect = originBtn.getBoundingClientRect();
    panel.innerHTML = '';
    panel.style.transition = 'left 340ms var(--ease-standard), top 340ms var(--ease-standard), width 340ms var(--ease-standard), height 340ms var(--ease-standard), border-radius 340ms var(--ease-standard), opacity 280ms var(--ease-standard)';
    panel.style.left = `${endRect.left - regionRect.left}px`;
    panel.style.top = `${endRect.top - regionRect.top}px`;
    panel.style.width = `${endRect.width}px`;
    panel.style.height = `${endRect.height}px`;
    panel.style.borderRadius = 'var(--glass-radius-pill)';
    panel.style.opacity = '0';
    selectedPanelOpen = false;
    setTimeout(() => panel.remove(), 360);
  }

  return { content };
})();
