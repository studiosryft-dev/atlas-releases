const IDLE_DAYS_OPTIONS = [3, 7, 14, 30, 60].map((d) => ({ value: d, label: `${d} day${d === 1 ? '' : 's'}` }));
const idleDaysLabel = (d) => `${d} day${d === 1 ? '' : 's'}`;

/** Applied both here (on toggle) and once at app startup (app.js, right after settings.get) —
 *  a `data-perf-mode` attribute on <html> that base.css's blur-reduction rule keys off of, plus
 *  telling the wave background to halve its own redraw rate. */
function applyPerfMode(on) {
  if (on) document.documentElement.setAttribute('data-perf-mode', '1');
  else document.documentElement.removeAttribute('data-perf-mode');
  WavesBackground.setPerfMode(on);
}

const SettingsScreen = (() => {
  const COLORWAYS = ['crimson', 'vapor', 'tide', 'pulse', 'sunset', 'lagoon', 'cosmic', 'dynamic'];
  const openSections = new Set(); // persists across re-renders within a session

  function accordionIcon(name) {
    const icons = {
      downloads: `<svg viewBox="0 0 24 24" fill="none"><path d="M12 3v12m0 0l-4-4m4 4l4-4M5 19h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
      equalizer: Icons.tune(18),
      appearance: `<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M12 3a9 9 0 000 18z" fill="currentColor"/></svg>`,
      effects: `<svg viewBox="0 0 24 24" fill="none"><path d="M7 4l10 8-10 8V4z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
      lyrics: Icons.mic(18),
    };
    return icons[name] || Icons.tune(18);
  }

  function accordion(id, iconName, title, summary, bodyHtml) {
    const isOpen = openSections.has(id);
    return `
      <div class="glass accordion-section ${isOpen ? 'is-open' : ''}" data-accordion="${id}">
        <div class="accordion-header" data-accordion-toggle="${id}">
          <div class="accordion-header__icon">${accordionIcon(iconName)}</div>
          <div class="accordion-header__text">
            <div class="accordion-header__title">${title}</div>
            <div class="accordion-header__summary">${summary}</div>
          </div>
          <div class="accordion-chevron">${Icons.chevronDown(18)}</div>
        </div>
        <div class="accordion-body-wrap">
          <div class="accordion-body"><div class="accordion-body-inner">${bodyHtml}</div></div>
        </div>
      </div>
    `;
  }

  async function render(el) {
    const settings = await Bridge.call('settings.get');
    const stats = await Bridge.call('settings.storageStats');
    AppStore.set({ settings });

    const downloadsBody = `
      <div style="display:flex; align-items:center; margin:10px 0;">
        <div style="flex:1;">Download over Wi-Fi only</div>
        <div class="switch ${settings.wifiOnly ? 'is-on' : ''}" id="s-wifi"></div>
      </div>
      <div style="display:flex; align-items:center; margin:10px 0;">
        <div style="flex:1;">Audio quality</div>
        ${GlassDropdown.html('s-quality', qualityLabel(settings.audioQuality))}
      </div>
      <div style="display:flex; align-items:center; margin:10px 0;">
        <div style="flex:1; display:flex; align-items:center; gap:6px;">
          <span>Idle Compression</span>
          <button class="icon-btn" id="s-idle-compression-info" style="width:24px; height:24px;">${Icons.info(14)}</button>
        </div>
        <div class="switch ${settings.idleCompression ? 'is-on' : ''}" id="s-idle-compression"></div>
      </div>
      <div class="idle-compress-reveal ${settings.idleCompression ? 'is-open' : ''}" id="s-idle-compress-reveal">
        <div class="idle-compress-reveal__clip">
          <div class="idle-compress-reveal__inner" style="display:flex; align-items:center;">
            <div style="flex:1; color:var(--ink-dim); font-size:13px;">Remove local file after</div>
            ${GlassDropdown.html('s-idle-compress-days', idleDaysLabel(settings.idleCompressionDays || 14))}
          </div>
        </div>
      </div>
      <div class="divider"></div>
      <div style="display:flex; justify-content:space-between; margin:12px 0;">
        <div>
          <div class="track-row__title">${stats.trackCount} Tracks</div>
          <div class="track-row__subtitle">Downloaded Tracks</div>
        </div>
        <div style="text-align:right;">
          <div class="track-row__title">${formatBytes(stats.totalBytes)}</div>
          <div class="track-row__subtitle">Occupied Space</div>
        </div>
      </div>
      <button class="btn-glass glass" id="s-erase-library" style="width:100%; color:var(--danger); margin-top:6px;">${Icons.trash(16)} Erase Library</button>
    `;

    const equalizerBody = `<div id="s-eq-embed"></div>`;

    const crossfadeSec = settings.crossfadeSeconds || 0;
    const effectsBody = `
      <div style="display:flex; align-items:center; margin:10px 0;">
        <div style="flex:1;">
          <div>Auto-pause on Bluetooth disconnect</div>
          <div class="track-row__subtitle" style="margin-top:2px;">Pauses playback when headphones disconnect</div>
        </div>
        <div class="switch ${settings.bluetoothAutoPause ? 'is-on' : ''}" id="s-bt-autopause"></div>
      </div>
      <div class="divider"></div>
      <div style="margin:14px 0 4px;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <div>Crossfade</div>
          <div id="s-crossfade-value" style="color:var(--ink-mute); font-size:13px; font-variant-numeric:tabular-nums;">${crossfadeSec > 0 ? crossfadeSec.toFixed(1) + 's' : 'Off'}</div>
        </div>
        <div class="track-row__subtitle" style="margin:2px 0 12px;">Smoothly blends into the next track</div>
        <input type="range" id="s-crossfade-slider" class="atlas-slider" min="0" max="12" step="0.5" value="${crossfadeSec}" style="width:100%;" />
      </div>
    `;

    const appearanceBody = `
      <div style="display:flex; gap:8px; margin:10px 0;">
        ${['DARK', 'LIGHT', 'DEFAULT'].map(m => `<button class="chip glass ${settings.themeMode === m ? 'is-selected' : ''}" data-theme="${m}">${m[0]}${m.slice(1).toLowerCase()}</button>`).join('')}
      </div>
      <div style="color:var(--ink-mute); font-size:13px; margin:14px 0 6px;">Colorway</div>
      <div style="display:flex; flex-wrap:wrap; gap:10px;">
        ${COLORWAYS.map(c => `<div class="colorway-swatch ${settings.colorway === c ? 'is-selected' : ''}" data-swatch="${c}" data-colorway-pick="${c}"></div>`).join('')}
      </div>
      <div class="divider"></div>
      <div style="display:flex; align-items:center; margin:14px 0 0;">
        <div style="flex:1;">Animate background</div>
        <div class="switch ${settings.backgroundAnimationEnabled !== false ? 'is-on' : ''}" id="s-bg-anim-enabled"></div>
      </div>
      <div class="idle-compress-reveal ${settings.backgroundAnimationEnabled !== false ? 'is-open' : ''}" id="s-bg-anim-reveal">
        <div class="idle-compress-reveal__clip">
          <div class="idle-compress-reveal__inner">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <div>Background speed</div>
              <div id="s-bg-anim-speed-value" style="color:var(--ink-mute); font-size:13px; font-variant-numeric:tabular-nums;">${(settings.backgroundAnimationSpeed || 1).toFixed(2)}x</div>
            </div>
            <input type="range" id="s-bg-anim-speed" class="atlas-slider" min="0.25" max="2.5" step="0.05" value="${settings.backgroundAnimationSpeed || 1}" style="width:100%; margin-top:8px;" />
          </div>
        </div>
      </div>
      <div class="divider"></div>
      <div style="display:flex; align-items:center; gap:12px;">
        <div style="flex:1; min-width:0;">
          <div>Phone Heat Optimization</div>
          <div class="track-row__subtitle" style="margin-top:2px; white-space:normal; overflow:visible; text-overflow:clip;">Reduces blur and background animation to lower rendering load</div>
        </div>
        <div class="switch ${settings.phoneHeatOptimization ? 'is-on' : ''}" id="s-perf-mode" style="flex-shrink:0;"></div>
      </div>
    `;

    el.innerHTML = `
      ${accordion('downloads', 'downloads', 'Downloads', 'Wi-Fi only, Audio quality, Idle Compression', downloadsBody)}
      ${accordion('equalizer', 'equalizer', 'Equalizer & Settings', '5-band equalizer, presets, on/off toggle', equalizerBody)}
      ${accordion('effects', 'effects', 'Effects & Playback', 'Bluetooth auto-pause, Crossfade', effectsBody)}
      ${accordion('appearance', 'appearance', 'Appearance', 'Theme, Colorway, Performance', appearanceBody)}
    `;

    el.querySelectorAll('[data-accordion-toggle]').forEach((header) => {
      header.onclick = () => {
        const id = header.dataset.accordionToggle;
        const section = el.querySelector(`[data-accordion="${id}"]`);
        const willOpen = !section.classList.contains('is-open');
        section.classList.toggle('is-open', willOpen);
        if (willOpen) { openSections.add(id); if (id === 'equalizer') EmbeddedEqualizer.mount(document.getElementById('s-eq-embed')); }
        else openSections.delete(id);
      };
    });

    if (openSections.has('equalizer')) EmbeddedEqualizer.mount(document.getElementById('s-eq-embed'));

    // Every one of these updates AppStore + the one control that actually changed in place,
    // rather than calling render(el) again — a full re-render tears down and recreates every
    // glass/backdrop-filter element on the page for a change that only ever affects one row,
    // which is what was causing the whole settings list to visibly flicker on every toggle.
    bindSwitch('s-wifi', 'wifiOnly', 'settings.setWifiOnly');
    bindSwitch('s-idle-compression', 'idleCompression', 'settings.setIdleCompression');
    // bindSwitch's own onclick (assigned above) already updates AppStore synchronously before
    // its first await, so by the time this second listener runs (registered after, same click
    // dispatch) AppStore.get('settings').idleCompression already reflects the new value — this
    // just toggles the "Compress after" duration row's reveal to match, fading it in/out from
    // behind the Idle Compression row rather than snapping it open/closed.
    document.getElementById('s-idle-compression').addEventListener('click', () => {
      document.getElementById('s-idle-compress-reveal')?.classList.toggle('is-open', !!AppStore.get('settings').idleCompression);
    });
    GlassDropdown.wire('s-idle-compress-days', IDLE_DAYS_OPTIONS, settings.idleCompressionDays || 14, async (daysStr) => {
      const days = Number(daysStr);
      AppStore.set({ settings: { ...AppStore.get('settings'), idleCompressionDays: days } });
      await Bridge.call('settings.setIdleCompressionDays', { days });
    });
    bindSwitch('s-bt-autopause', 'bluetoothAutoPause', 'settings.setBluetoothAutoPause');
    document.getElementById('s-bg-anim-enabled').onclick = async (e) => {
      const cur = AppStore.get('settings');
      const next = cur.backgroundAnimationEnabled === false; // toggling ON if currently off
      e.currentTarget.classList.toggle('is-on', next);
      document.getElementById('s-bg-anim-reveal')?.classList.toggle('is-open', next);
      AppStore.set({ settings: { ...cur, backgroundAnimationEnabled: next } });
      WavesBackground.setEnabled(next);
      await Bridge.call('settings.setBackgroundAnimationEnabled', { enabled: next });
    };
    document.getElementById('s-perf-mode').onclick = async (e) => {
      const cur = AppStore.get('settings');
      const next = !cur.phoneHeatOptimization;
      e.currentTarget.classList.toggle('is-on', next);
      AppStore.set({ settings: { ...cur, phoneHeatOptimization: next } });
      applyPerfMode(next);
      await Bridge.call('settings.setPhoneHeatOptimization', { enabled: next });
    };
    const bgSpeedSlider = document.getElementById('s-bg-anim-speed');
    const bgSpeedValue = document.getElementById('s-bg-anim-speed-value');
    bgSpeedSlider.oninput = () => {
      const v = parseFloat(bgSpeedSlider.value);
      bgSpeedValue.textContent = `${v.toFixed(2)}x`;
      WavesBackground.setSpeed(v); // live preview while dragging
    };
    bgSpeedSlider.onchange = async () => {
      const v = parseFloat(bgSpeedSlider.value);
      AppStore.set({ settings: { ...AppStore.get('settings'), backgroundAnimationSpeed: v } });
      await Bridge.call('settings.setBackgroundAnimationSpeed', { speed: v });
    };

    GlassDropdown.wire('s-quality', QUALITY_OPTIONS, settings.audioQuality || 'HIGH', async (quality) => {
      AppStore.set({ settings: { ...AppStore.get('settings'), audioQuality: quality } });
      await Bridge.call('settings.setAudioQuality', { quality });
    });
    document.getElementById('s-idle-compression-info').onclick = () => {
      Notifications.show({
        icon: 'info',
        title: 'Idle Compression',
        body: 'Removes the local audio file for tracks you haven\'t played in a while to save space — they stay in your library and re-download automatically the moment you play or queue them again.',
      });
    };
    document.getElementById('s-erase-library').onclick = () => openEraseLibraryConfirm();

    const crossfadeSlider = document.getElementById('s-crossfade-slider');
    const crossfadeValue = document.getElementById('s-crossfade-value');
    crossfadeSlider.oninput = () => {
      const v = parseFloat(crossfadeSlider.value);
      crossfadeValue.textContent = v > 0 ? `${v.toFixed(1)}s` : 'Off';
    };
    crossfadeSlider.onchange = async () => {
      const seconds = parseFloat(crossfadeSlider.value);
      AppStore.set({ settings: { ...AppStore.get('settings'), crossfadeSeconds: seconds } });
      await Bridge.call('settings.setCrossfadeSeconds', { seconds });
    };

    el.querySelectorAll('[data-theme]').forEach((btn) => {
      btn.onclick = async () => {
        el.querySelectorAll('[data-theme]').forEach((b) => b.classList.toggle('is-selected', b === btn));
        applyAppearance(btn.dataset.theme);
        AppStore.set({ settings: { ...AppStore.get('settings'), themeMode: btn.dataset.theme } });
        await Bridge.call('settings.setThemeMode', { mode: btn.dataset.theme });
      };
    });
    el.querySelectorAll('[data-colorway-pick]').forEach((btn) => {
      btn.onclick = async () => {
        el.querySelectorAll('[data-colorway-pick]').forEach((b) => b.classList.toggle('is-selected', b === btn));
        const picked = btn.dataset.colorwayPick;
        if (picked === 'dynamic') {
          DynamicColorway.setEnabled(true);
        } else {
          // Attribute set BEFORE disabling Dynamic, not after: setEnabled(false) clears Dynamic's
          // inline --bg-* overrides and immediately retints from whatever data-colorway currently
          // resolves to. Setting the attribute first means that retint already lands on the real
          // target colorway; the other order retinted against the stale previous data-colorway
          // value (still "pulse", Dynamic's own fallback) for a moment — a visible flash of the
          // wrong color before the (also correct, but 1150ms-debounced) MutationObserver retint
          // caught up.
          document.documentElement.setAttribute('data-colorway', picked);
          DynamicColorway.setEnabled(false);
        }
        AppStore.set({ settings: { ...AppStore.get('settings'), colorway: picked } });
        await Bridge.call('settings.setColorway', { colorway: picked });
      };
    });

    // Shared binder for the plain on/off switches above — flips the .is-on class immediately
    // (the CSS transition on .switch already animates the knob), updates the store, then fires
    // the bridge call in the background.
    function bindSwitch(elId, settingsKey, bridgeAction) {
      document.getElementById(elId).onclick = async (e) => {
        const cur = AppStore.get('settings');
        const next = !cur[settingsKey];
        e.currentTarget.classList.toggle('is-on', next);
        AppStore.set({ settings: { ...cur, [settingsKey]: next } });
        await Bridge.call(bridgeAction, { enabled: next });
      };
    }
  }

  function openEraseLibraryConfirm() {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-modal-overlay';
    let moveToTrash = false;
    overlay.innerHTML = `
      <div class="glass glass--strong confirm-modal-card">
        <div class="display" style="font-size:18px; margin-bottom:8px;">Erase Library?</div>
        <div style="color:var(--ink-dim); font-size:14px; line-height:1.5; margin-bottom:16px;">
          Permanently deletes every downloaded track and playlist. This can't be undone unless
          "Move to Trash instead" is checked below.
        </div>
        <button style="display:flex; align-items:center; gap:10px; width:100%; padding:8px 0; margin-bottom:18px;" id="erase-trash-toggle">
          <span class="erase-checkbox">${Icons.check(13)}</span>
          <span style="font-size:13px; color:var(--ink-dim);">Move tracks to Trash instead of deleting permanently</span>
        </button>
        <div style="display:flex; gap:10px;">
          <button class="btn-glass glass" id="erase-cancel" style="flex:1;">Cancel</button>
          <button class="btn-glass glass" id="erase-confirm" style="flex:1; color:var(--danger);">Erase</button>
        </div>
      </div>
    `;
    const close = () => closeOverlayAnimated(overlay);
    overlay.querySelector('#erase-trash-toggle').onclick = (e) => {
      moveToTrash = !moveToTrash;
      e.currentTarget.querySelector('.erase-checkbox').classList.toggle('is-checked', moveToTrash);
    };
    overlay.querySelector('#erase-cancel').onclick = close;
    overlay.querySelector('#erase-confirm').onclick = async () => {
      await Bridge.call('library.eraseAll', { moveToTrash });
      close();
      Notifications.push({ icon: 'trash', title: 'Library erased' });
    };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.body.appendChild(overlay);
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 MB';
    const mb = bytes / (1024 * 1024);
    return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
  }

  function applyAppearance(mode) {
    const isDark = mode === 'DARK' || (mode === 'DEFAULT' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-appearance', isDark ? 'dark' : 'light');
  }

  return { render, applyAppearance };
})();
