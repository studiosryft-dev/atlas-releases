/** Drives the "Download Update" -> Confirm App Update popup -> install flow, triggered from the
 *  Download Update button embedded in an update notification card (notificationCenter.js). */
const UpdateFlow = (() => {
  function fmtSize(bytes) {
    if (!bytes) return null;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function startDownload(info, btn) {
    if (btn.disabled) return;
    btn.disabled = true;
    const originalHtml = btn.innerHTML;
    btn.innerHTML = `<span class="notif-card__update-progress">Downloading… 0%</span>`;

    const unsub = Bridge.on('updates.downloadProgress', (data) => {
      const el = btn.querySelector('.notif-card__update-progress');
      if (el) el.textContent = `Downloading… ${data.percent}%`;
    });

    Bridge.call('updates.download', {
      version: info.version,
      versionCode: info.versionCode,
      apkUrl: info.apkUrl,
      sizeBytes: info.sizeBytes,
      releaseNotes: info.releaseNotes,
      mandatory: info.mandatory,
    }).then((res) => {
      unsub();
      btn.disabled = false;
      btn.innerHTML = originalHtml;
      if (res && res.success) {
        openConfirmPopup(info);
      } else {
        Notifications.show({ icon: 'info', title: 'Download failed', body: (res && res.error) || 'Please try again.', tone: 'danger' });
      }
    }).catch(() => {
      unsub();
      btn.disabled = false;
      btn.innerHTML = originalHtml;
      Notifications.show({ icon: 'info', title: 'Download failed', body: 'Please check your connection and try again.', tone: 'danger' });
    });
  }

  /** Styled to match the app's own modal chrome (.confirm-modal-overlay/.confirm-modal-card,
   *  same as promptDialog/confirmDialog) rather than a generic system dialog, per spec. */
  function openConfirmPopup(info) {
    const currentVersion = (AppStore.get('settings') || {}).appVersion || '?';
    const overlay = document.createElement('div');
    overlay.className = 'confirm-modal-overlay';
    const sizeText = fmtSize(info.sizeBytes);
    overlay.innerHTML = `
      <div class="glass glass--strong confirm-modal-card update-confirm-card">
        <button class="icon-btn update-confirm-card__close" id="uc-close">${Icons.close(18)}</button>
        <div class="display" style="font-size:18px; margin-bottom:12px;">Confirm App Update</div>
        <div class="update-confirm-card__versions">
          <span class="update-confirm-card__from">v${currentVersion}</span>
          <span class="update-confirm-card__arrow">&#8594;</span>
          <span class="update-confirm-card__to">v${info.version}</span>
        </div>
        ${sizeText ? `<div class="update-confirm-card__meta">${sizeText} download</div>` : ''}
        ${info.releaseNotes ? `<div class="update-confirm-card__notes">${info.releaseNotes}</div>` : ''}
        <div style="display:flex; gap:10px; margin-top:18px;">
          <button class="btn-glass glass" id="uc-cancel" style="flex:1;">Cancel</button>
          <button class="btn-primary" id="uc-accept" style="flex:1;">Update</button>
        </div>
      </div>
    `;
    const close = () => closeOverlayAnimated(overlay);
    overlay.querySelector('#uc-close').onclick = close;
    overlay.querySelector('#uc-cancel').onclick = close;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('#uc-accept').onclick = async () => {
      const res = await Bridge.call('updates.install').catch(() => null);
      if (res && res.needsPermission) {
        Notifications.show({
          icon: 'info',
          title: 'Allow installs from Atlas',
          body: 'Turn on "Allow from this source" on the screen that just opened, then tap Download Update again.',
        });
      } else if (!res || !res.started) {
        Notifications.show({ icon: 'info', title: 'Couldn’t start the install', body: (res && res.error) || 'Try downloading the update again.', tone: 'danger' });
      }
      close();
    };
    document.body.appendChild(overlay);
  }

  return { startDownload };
})();
