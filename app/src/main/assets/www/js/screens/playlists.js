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
      <div style="display:flex; align-items:center; margin-bottom:14px;">
        <div style="flex:1; font-family:var(--font-display); font-size:15px; color:var(--ink-dim);">${playlists.length} playlists</div>
        <button class="icon-btn glass" id="pl-create">${Icons.download(18)}</button>
      </div>
      <div id="pl-grid" style="display:grid; grid-template-columns:1fr 1fr; gap:16px;"></div>
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

  async function openDetail(id) {
    const p = (AppStore.get('playlists') || []).find(x => x.id === id);
    const tracks = await Bridge.call('playlists.getTracks', { id });
    openIndexedPage('playlistDetail', (content) => {
      content.innerHTML = `
        <div class="indexed-page__mini-header">
          <div class="display" style="font-size:22px;">${p?.name || 'Playlist'}</div>
          <div style="display:flex; gap:4px;">
            <button class="icon-btn" id="pd-close">${Icons.close(20)}</button>
          </div>
        </div>
        <div style="display:flex; gap:10px; margin-bottom:16px;">
          <button class="btn-primary" id="pd-play" style="flex:1;">${Icons.play(16)} Play</button>
          <button class="btn-primary" id="pd-shuffle" style="flex:1;">${Icons.shuffle(16)} Shuffle</button>
        </div>
        <div id="pd-list"></div>
      `;
      content.querySelector('#pd-close').onclick = () => closeIndexedPage('playlistDetail');
      const ids = tracks.map(t => t.id);
      content.querySelector('#pd-play').onclick = () => Bridge.call('playback.playQueue', { trackIds: ids, startIndex: 0, playlistContextId: id });
      content.querySelector('#pd-shuffle').onclick = () => Bridge.call('playback.playShuffled', { trackIds: ids, playlistContextId: id });
      content.querySelector('#pd-list').innerHTML = tracks.map((t) => `
        <div class="track-row" data-id="${t.id}">
          ${t.artworkPath ? `<img class="track-row__art" src="${artworkUrl(t.artworkPath)}">` : `<div class="track-row__art"></div>`}
          <div class="track-row__body"><div class="track-row__title">${t.title}</div><div class="track-row__subtitle">${t.artist}</div></div>
          <button class="icon-btn" data-remove="${t.id}">${Icons.close(16)}</button>
        </div>
      `).join('') || `<div style="text-align:center; color:var(--ink-mute); padding:30px 0;">No tracks in this playlist yet.</div>`;
      content.querySelectorAll('[data-remove]').forEach((btn) => {
        btn.addEventListener('click', () => Bridge.call('playlists.removeTrack', { playlistId: id, trackId: btn.dataset.remove }).then(() => openDetail(id)));
      });
    });
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
        <button class="btn-glass glass" id="atp-new" style="width:100%; margin-top:10px;">${Icons.download(16)} New Playlist</button>
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
