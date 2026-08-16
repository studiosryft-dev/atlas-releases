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
    render(root, { animate: false });
    Bridge.call('notifications.markAllRead');
  }

  /** opts.animate: true whenever this is a re-render triggered by a live notifications.changed
   *  push while the page is already open (a new notification arriving, one getting cleared, a
   *  read-state flip) — false for the very first paint, where there's nothing to animate from.
   *  Uses FLIP: card positions are measured before the full innerHTML rebuild, then every
   *  surviving card gets an inverse transform removed via transition (the "slide down to make
   *  room" effect), while a card with no prior position (brand new) gets its own fade+drop-in
   *  instead of a position tween. Cheaper than diffing the list into per-item DOM patches, and
   *  this list is never long enough for the full-rebuild cost to matter. */
  function render(root, opts = {}) {
    const animate = opts.animate === true;
    const prevListEl = root.querySelector('#nc-list');
    const oldRects = animate && prevListEl ? new Map() : null;
    if (oldRects) {
      prevListEl.querySelectorAll('.notif-card[data-remove]').forEach((el) => {
        oldRects.set(el.dataset.remove, el.getBoundingClientRect());
      });
    }

    const list = AppStore.get('notifications') || [];
    root.innerHTML = `
      <div class="indexed-page__mini-header">
        <div class="display" style="font-size:22px;">Notifications</div>
        <button class="icon-btn" id="nc-close">${Icons.close(20)}</button>
      </div>
      <div class="nc-actions">
        <button class="nc-action-btn" id="nc-check-updates">${Icons.update(15)}<span id="nc-check-updates-label">Check for Updates</span></button>
        <button class="nc-action-btn" id="nc-clear">${Icons.trash(15)}<span>Clear All</span></button>
      </div>
      <div id="nc-list"></div>
    `;
    root.querySelector('#nc-close').onclick = () => closeIndexedPage('notificationCenter');
    root.querySelector('#nc-clear').onclick = async (e) => {
      const btn = e.currentTarget;
      if (btn.disabled) return;
      const cards = Array.from(root.querySelectorAll('#nc-list .notif-card'));
      if (!cards.length) { Bridge.call('notifications.clear'); return; }
      btn.disabled = true;
      cards.forEach((card, i) => {
        card.style.transition = `opacity 240ms var(--ease-standard) ${i * 25}ms, transform 240ms var(--ease-standard) ${i * 25}ms`;
        card.style.opacity = '0';
        card.style.transform = 'translateX(28px) scale(0.96)';
      });
      setTimeout(() => Bridge.call('notifications.clear'), 240 + cards.length * 25);
    };
    root.querySelector('#nc-check-updates').onclick = async (e) => {
      const btn = e.currentTarget;
      if (btn.disabled) return;
      btn.disabled = true;
      const label = btn.querySelector('#nc-check-updates-label');
      const originalText = label.textContent;
      label.textContent = 'Checking…';
      try {
        await Bridge.call('updates.check');
        // The check result lands as a fresh row via the existing notifications.changed push
        // (see WebAppBridge's updates.check) — nothing else to do here.
      } finally {
        btn.disabled = false;
        label.textContent = originalText;
      }
    };

    const listEl = root.querySelector('#nc-list');
    listEl.innerHTML = list.length ? list.map((n) => {
      if (n.icon === 'update' && n.dataJson) return renderUpdateCard(n);
      return `
      <div class="notif-card glass${n.isRead ? '' : ' is-unread'}" data-remove="${n.id}">
        <div class="notif-card__icon">${Icons[n.icon] ? Icons[n.icon](18) : Icons.info(18)}</div>
        <div class="notif-card__body">
          <div class="notif-card__row">
            <div class="notif-card__title">${n.title}</div>
            <div class="notif-card__time">${fmtRelative(n.createdAt)}</div>
          </div>
          ${n.body ? `<div class="notif-card__subtitle">${n.body}</div>` : ''}
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

    if (oldRects) playInsertAnimation(listEl, oldRects);
  }

  function playInsertAnimation(listEl, oldRects) {
    const cards = Array.from(listEl.querySelectorAll('.notif-card[data-remove]'));
    cards.forEach((card) => {
      const oldRect = oldRects.get(card.dataset.remove);
      card.style.transition = 'none';
      if (oldRect) {
        const dy = oldRect.top - card.getBoundingClientRect().top;
        if (Math.abs(dy) > 0.5) card.style.transform = `translateY(${dy}px)`;
      } else {
        // No prior position — this card is brand new, drop it in rather than sliding it.
        card.style.opacity = '0';
        card.style.transform = 'translateY(-14px) scale(0.97)';
      }
    });
    // Force layout so the browser commits the pre-animation state above before the transition
    // below is allowed to take effect — otherwise both would collapse into the same frame.
    void listEl.offsetHeight;
    requestAnimationFrame(() => {
      cards.forEach((card) => {
        card.style.transition = 'transform 380ms var(--ease-standard), opacity 320ms var(--ease-standard)';
        card.style.transform = '';
        card.style.opacity = '';
      });
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
          <div class="notif-card__row">
            <div class="notif-card__title">${n.title}</div>
            <div class="notif-card__time">${fmtRelative(n.createdAt)}</div>
          </div>
          ${n.body ? `<div class="notif-card__subtitle">${n.body}</div>` : ''}
          ${sizeMb ? `<div class="notif-card__meta">${sizeMb}</div>` : ''}
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
    if (openPage) render(openPage.querySelector('.indexed-page__content'), { animate: true });
  });

  return { content, updateBadge };
})();
