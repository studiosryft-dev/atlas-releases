/** Notification Center indexed page — persistent history of everything the toast system has
 *  shown (native download events, queue-add confirmations, account actions, etc.), backed by
 *  the native `notifications` table. Opened from the bell icon in the global header. */
const NotificationCenterScreen = (() => {
  function fmtRelative(ts) {
    const diffMs = Date.now() - ts;
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(ts).toLocaleDateString();
  }

  function content(root) {
    render(root);
    Bridge.call('notifications.markAllRead');
  }

  function render(root) {
    const list = AppStore.get('notifications') || [];
    root.innerHTML = `
      <div class="indexed-page__mini-header">
        <div class="display" style="font-size:22px;">Notifications</div>
        <div style="display:flex; gap:6px;">
          <button class="btn-glass glass" id="nc-check-updates" style="height:36px; padding:0 14px; font-size:12px;">Check for Updates</button>
          <button class="btn-glass glass" id="nc-clear" style="height:36px; padding:0 14px; font-size:12px;">Clear All</button>
          <button class="icon-btn" id="nc-close">${Icons.close(20)}</button>
        </div>
      </div>
      <div id="nc-list"></div>
    `;
    root.querySelector('#nc-close').onclick = () => closeIndexedPage('notificationCenter');
    root.querySelector('#nc-clear').onclick = () => Bridge.call('notifications.clear');
    root.querySelector('#nc-check-updates').onclick = async (e) => {
      const btn = e.currentTarget;
      if (btn.disabled) return;
      btn.disabled = true;
      const originalText = btn.textContent;
      btn.textContent = 'Checking…';
      try {
        await Bridge.call('updates.check');
        // The check result lands as a fresh row via the existing notifications.changed push
        // (see WebAppBridge's updates.check) — nothing else to do here.
      } finally {
        btn.disabled = false;
        btn.textContent = originalText;
      }
    };

    const listEl = root.querySelector('#nc-list');
    listEl.innerHTML = list.length ? list.map((n) => {
      if (n.icon === 'update' && n.dataJson) return renderUpdateCard(n);
      return `
      <div class="notif-card glass${n.isRead ? '' : ' is-unread'}" data-remove="${n.id}">
        <div class="notif-card__icon">${Icons[n.icon] ? Icons[n.icon](18) : Icons.info(18)}</div>
        <div class="notif-card__body">
          <div class="notif-card__title">${n.title}</div>
          ${n.body ? `<div class="notif-card__subtitle">${n.body}</div>` : ''}
          <div class="notif-card__meta">${fmtRelative(n.createdAt)}</div>
        </div>
        ${n.isRead ? '' : '<div class="notif-card__dot"></div>'}
      </div>
    `;
    }).join('') : `<div style="text-align:center; color:var(--ink-mute); padding:30px 0;">Nothing yet.</div>`;

    listEl.querySelectorAll('.notif-card[data-remove]').forEach((row) => {
      let startX = 0;
      row.addEventListener('touchstart', (e) => { startX = e.touches[0].clientX; }, { passive: true });
      row.addEventListener('touchend', (e) => {
        if (Math.abs(e.changedTouches[0].clientX - startX) > 80) Bridge.call('notifications.delete', { id: row.dataset.remove });
      });
    });

    listEl.querySelectorAll('[data-download-update]').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const info = JSON.parse(btn.dataset.downloadUpdate);
        UpdateFlow.startDownload(info, btn);
      };
    });
  }

  function renderUpdateCard(n) {
    let info;
    try { info = JSON.parse(n.dataJson); } catch (e) { return ''; }
    const sizeMb = info.sizeBytes ? (info.sizeBytes / (1024 * 1024)).toFixed(1) + ' MB' : null;
    return `
      <div class="notif-card notif-card--update glass${n.isRead ? '' : ' is-unread'}" data-remove="${n.id}">
        <div class="notif-card__icon">${Icons.update(18)}</div>
        <div class="notif-card__body">
          <div class="notif-card__title">${n.title}</div>
          ${n.body ? `<div class="notif-card__subtitle">${n.body}</div>` : ''}
          <div class="notif-card__meta">${sizeMb ? sizeMb + ' · ' : ''}${fmtRelative(n.createdAt)}</div>
          <button class="btn-primary notif-card__update-btn" data-download-update='${JSON.stringify(info).replace(/'/g, '&#39;')}'>${Icons.download(14)} Download Update</button>
        </div>
        ${n.isRead ? '' : '<div class="notif-card__dot"></div>'}
      </div>
    `;
  }

  function unreadCount(list) {
    return (list || []).filter((n) => !n.isRead).length;
  }

  function updateBadge() {
    const badge = document.getElementById('header-badge');
    if (!badge) return;
    badge.hidden = unreadCount(AppStore.get('notifications')) === 0;
  }

  Bridge.on('notifications.changed', (list) => {
    AppStore.set({ notifications: list });
    updateBadge();
    const openPage = document.querySelector('.indexed-page[data-page="notificationCenter"].is-open');
    if (openPage) render(openPage.querySelector('.indexed-page__content'));
  });

  return { content, updateBadge };
})();
