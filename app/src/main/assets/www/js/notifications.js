/**
 * In-app notification/toast system: fade+slide-down intro, auto-dismiss after 3.5s via a
 * visible progress bar, swipeable left/right/up to dismiss early. `show()` is the ephemeral
 * popup only; `push()` additionally records the notification into the persistent notification
 * center (native Room table) so it's still there after the toast dismisses. Native-triggered
 * notifications (e.g. a download finishing) arrive via the `notifications.new` bridge push and
 * are shown the same way, without a second persist round-trip since native already inserted them.
 */
const Notifications = (() => {
  const root = document.getElementById('notification-root');
  // Lengthened from 3.5s — combined with dropping the old countdown bar (which visually rushed
  // the reader), toasts now sit long enough to actually be read before they leave.
  const DEFAULT_MS = 5500;
  const TONES = {
    danger: 'var(--danger)', warning: 'var(--warning)', success: 'var(--success)', accent: 'var(--accent-b)',
  };
  function toneFor(icon, tone) {
    if (tone && TONES[tone]) return TONES[tone];
    if (/fail|error|danger/i.test(icon || '')) return TONES.danger;
    if (/complete|success|done/i.test(icon || '')) return TONES.success;
    return TONES.accent;
  }

  function push({ icon = 'info', title, body, durationMs = DEFAULT_MS, tone }) {
    show({ icon, title, body, durationMs, tone });
    Bridge.call('notifications.create', { icon, title, body: body || '' }).catch(() => {});
  }

  Bridge.on('notifications.new', (n) => show({ icon: n.icon, title: n.title, body: n.body }));

  function show({ icon = 'info', title, body, durationMs = DEFAULT_MS, tone }) {
    const toast = document.createElement('div');
    toast.className = 'toast glass glass--strong';
    toast.style.setProperty('--toast-tone', toneFor(icon, tone));
    toast.innerHTML = `
      <div class="toast__icon">${Icons[icon] ? Icons[icon](17) : ''}</div>
      <div class="toast__text">
        <div class="toast__row">${title}</div>
        ${body ? `<div class="toast__body">${body}</div>` : ''}
      </div>
    `;
    root.appendChild(toast);

    let dismissed = false;
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      toast.classList.add('is-leaving');
      setTimeout(() => toast.remove(), 340);
    };

    const timer = setTimeout(dismiss, durationMs);

    let startX = 0, startY = 0, dragging = false;
    toast.addEventListener('touchstart', (e) => {
      startX = e.touches[0].clientX; startY = e.touches[0].clientY; dragging = true;
      clearTimeout(timer);
    }, { passive: true });
    toast.addEventListener('touchmove', (e) => {
      if (!dragging) return;
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      toast.style.transform = `translate(${dx}px, ${Math.min(dy, 0)}px)`;
      toast.style.opacity = String(1 - Math.min(Math.abs(dx), Math.abs(Math.min(dy, 0))) / 160);
    }, { passive: true });
    toast.addEventListener('touchend', (e) => {
      dragging = false;
      const dx = e.changedTouches[0].clientX - startX;
      const dy = e.changedTouches[0].clientY - startY;
      if (Math.abs(dx) > 70 || dy < -60) {
        dismiss();
      } else {
        toast.style.transform = ''; toast.style.opacity = '';
        setTimeout(dismiss, 1200);
      }
    });

    return dismiss;
  }

  return { show, push };
})();
