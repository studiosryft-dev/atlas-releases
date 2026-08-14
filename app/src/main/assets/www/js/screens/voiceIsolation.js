/** Voice Isolation/Removal flow — a bottom-sheet overlay (not a full indexed page, this is a
 *  short-lived action triggered from a track's 3-dot menu) that walks through: one-time model
 *  download (explicit, since it's a ~166MB fetch) -> pick Vocals/Instrumental/both -> progress
 *  while the on-device model runs -> done. Results land back in the Library via the normal
 *  `library.changed` push once WebAppBridge inserts them, same as any other new track. */
const VoiceIsolationFlow = (() => {
  function open(trackId, trackTitle) {
    const overlay = document.createElement('div');
    overlay.className = 'action-sheet-overlay';
    overlay.style.zIndex = '210';
    document.body.appendChild(overlay);

    Bridge.call('voiceIsolation.status').then((status) => {
      if (status.modelReady) renderPicker(overlay, trackId, trackTitle);
      else renderDownloadPrompt(overlay, trackId, trackTitle);
    });

    return overlay;
  }

  function card(overlay, innerHtml) {
    overlay.innerHTML = `
      <div class="glass glass--strong action-sheet-card" style="padding:20px;">
        ${innerHtml}
      </div>
    `;
  }

  function close(overlay) {
    overlay.__cleanup?.();
    closeOverlayAnimated(overlay);
  }

  function renderDownloadPrompt(overlay, trackId, trackTitle) {
    card(overlay, `
      <div class="display" style="font-size:18px; margin-bottom:8px;">Voice Isolation</div>
      <div style="color:var(--ink-dim); font-size:14px; line-height:1.5; margin-bottom:16px;">
        This needs a one-time ~166MB AI model download, fetched once and reused for every track after.
        Recommended on Wi-Fi.
      </div>
      <button class="btn-primary" id="vi-download" style="width:100%;">Download Model</button>
      <button class="btn-glass" id="vi-cancel" style="width:100%; margin-top:10px;">Cancel</button>
    `);
    overlay.querySelector('#vi-cancel').onclick = () => close(overlay);
    overlay.querySelector('#vi-download').onclick = () => renderDownloading(overlay, trackId, trackTitle);
  }

  function renderDownloading(overlay, trackId, trackTitle) {
    card(overlay, `
      <div class="display" style="font-size:18px; margin-bottom:12px;">Downloading model…</div>
      <div class="dq-global-bar"><div class="dq-global-bar__fill" id="vi-dl-fill" style="width:0%;"></div></div>
      <div style="text-align:center; color:var(--ink-mute); font-size:13px; margin-top:8px;" id="vi-dl-pct">0%</div>
    `);
    const offProgress = Bridge.on('voiceIsolation.modelDownloadProgress', (percent) => {
      const fill = overlay.querySelector('#vi-dl-fill');
      const pct = overlay.querySelector('#vi-dl-pct');
      if (!fill) return;
      fill.style.width = `${percent}%`;
      pct.textContent = `${percent}%`;
      if (percent >= 100) renderPicker(overlay, trackId, trackTitle);
    });
    const offFail = Bridge.on('voiceIsolation.modelDownloadFailed', ({ error }) => {
      card(overlay, `
        <div class="display" style="font-size:18px; margin-bottom:8px;">Download failed</div>
        <div style="color:var(--danger); margin-bottom:16px;">${error}</div>
        <button class="btn-glass" id="vi-close" style="width:100%;">Close</button>
      `);
      overlay.querySelector('#vi-close').onclick = () => close(overlay);
    });
    Bridge.call('voiceIsolation.downloadModel');
    overlay.__cleanup = () => { offProgress?.(); offFail?.(); };
  }

  function renderPicker(overlay, trackId, trackTitle) {
    overlay.__cleanup?.();
    card(overlay, `
      <div class="display" style="font-size:18px; margin-bottom:4px;">Voice Isolation</div>
      <div style="color:var(--ink-dim); font-size:13px; margin-bottom:16px;">${trackTitle}</div>
      <div style="display:flex; align-items:center; padding:10px 0;">
        <div style="flex:1;">Vocals only</div>
        <div class="switch is-on" id="vi-vocals"></div>
      </div>
      <div style="display:flex; align-items:center; padding:10px 0;">
        <div style="flex:1;">Instrumental only</div>
        <div class="switch" id="vi-instrumental"></div>
      </div>
      <div style="color:var(--ink-mute); font-size:12px; margin:8px 0 16px;">
        Runs entirely on this device — can take a few minutes depending on track length and your phone. You can keep using the app while it runs.
      </div>
      <button class="btn-primary" id="vi-start" style="width:100%;">Start</button>
      <button class="btn-glass" id="vi-cancel" style="width:100%; margin-top:10px;">Cancel</button>
    `);
    let vocals = true, instrumental = false;
    overlay.querySelector('#vi-vocals').onclick = (e) => { vocals = !vocals; e.target.classList.toggle('is-on', vocals); };
    overlay.querySelector('#vi-instrumental').onclick = (e) => { instrumental = !instrumental; e.target.classList.toggle('is-on', instrumental); };
    overlay.querySelector('#vi-cancel').onclick = () => close(overlay);
    overlay.querySelector('#vi-start').onclick = () => {
      if (!vocals && !instrumental) return;
      Bridge.call('voiceIsolation.process', { trackId, vocals, instrumental });
      renderProgress(overlay, trackId, trackTitle);
    };
  }

  function renderProgress(overlay, trackId, trackTitle) {
    card(overlay, `
      <div class="display" style="font-size:18px; margin-bottom:12px;">Isolating "${trackTitle}"…</div>
      <div class="dq-global-bar"><div class="dq-global-bar__fill" id="vi-proc-fill" style="width:0%;"></div></div>
      <div style="text-align:center; color:var(--ink-mute); font-size:13px; margin-top:8px;" id="vi-proc-pct">0%</div>
      <div style="color:var(--ink-mute); font-size:12px; margin-top:12px;">This keeps running in the background even if you close this sheet.</div>
      <button class="btn-glass" id="vi-dismiss" style="width:100%; margin-top:16px;">Run in Background</button>
    `);
    overlay.querySelector('#vi-dismiss').onclick = () => close(overlay);

    const off = Bridge.on('voiceIsolation.progress', (state) => {
      if (state.sourceTrackId !== trackId) return;
      const fill = overlay.querySelector('#vi-proc-fill');
      const pct = overlay.querySelector('#vi-proc-pct');
      if (fill) { fill.style.width = `${state.percent}%`; pct.textContent = `${state.percent}%`; }

      if (state.status === 'DONE') {
        Notifications.push({ icon: 'info', title: 'Voice Isolation complete', body: `"${trackTitle}" is ready in Library.` });
        close(overlay);
      } else if (state.status === 'FAILED') {
        Notifications.show({ icon: 'info', title: 'Voice Isolation failed', body: state.errorMessage || '' });
        close(overlay);
      }
    });
    overlay.__cleanup = () => off?.();
  }

  return { open };
})();
