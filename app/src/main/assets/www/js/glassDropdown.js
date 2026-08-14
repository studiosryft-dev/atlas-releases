/** Generic glass dropdown — a chip-style trigger that opens a floating glass menu, same visual
 *  language as Now Playing's 3-dot menu (js/screens/nowPlaying.js's .np-dropdown): downward,
 *  fade+slide entrance, rounded item rows with a press state.
 *
 *  The panel is appended to `document.body` and positioned via the trigger's own
 *  getBoundingClientRect() rather than being a CSS-positioned child of the trigger — that's
 *  deliberate, not just stylistic. A dropdown living inside any ancestor with `overflow:hidden`
 *  (e.g. Settings' accordion-body-wrap, or Idle Compression's own grid-rows reveal wrapper) gets
 *  silently clipped the instant it needs to extend past that ancestor's box, which is exactly
 *  what was cutting off the "Compress after" duration picker. A body-level popover has no such
 *  ancestor to be clipped by, ever, regardless of where its trigger happens to live. */
// Shared between Discover's and Settings' audio-quality pickers so there's exactly one
// definition of what the 3 quality levels are called.
const QUALITY_OPTIONS = ['LOW', 'MEDIUM', 'HIGH'].map((q) => ({ value: q, label: q[0] + q.slice(1).toLowerCase() }));
const qualityLabel = (q) => (q ? q[0] + q.slice(1).toLowerCase() : 'Medium');

const GlassDropdown = (() => {
  let openState = null; // { trigger, panel, close }

  function closeCurrent() {
    if (openState) { openState.close(); openState = null; }
  }

  function html(id, label) {
    return `
      <button type="button" class="gd-trigger chip glass" id="${id}">
        <span class="gd-trigger__label">${label}</span>
        <span class="gd-trigger__chevron">${Icons.chevronDown(14)}</span>
      </button>
    `;
  }

  /** options: [{ value, label }]. onChange(value) fires on selection. */
  function wire(triggerId, options, selectedValue, onChange) {
    const trigger = document.getElementById(triggerId);
    if (!trigger) return;
    const labelEl = trigger.querySelector('.gd-trigger__label');
    trigger.onclick = (e) => {
      e.stopPropagation();
      if (openState && openState.trigger === trigger) { closeCurrent(); return; }
      closeCurrent();
      openState = openPanel(trigger, options, selectedValue, (value, label) => {
        selectedValue = value;
        if (labelEl) labelEl.textContent = label;
        onChange(value);
      });
    };
  }

  function openPanel(trigger, options, selectedValue, onSelect) {
    trigger.classList.add('is-open');
    const panel = document.createElement('div');
    panel.className = 'glass glass--strong gd-panel';
    panel.innerHTML = options.map((o) => `
      <button type="button" class="gd-panel__item ${String(o.value) === String(selectedValue) ? 'is-selected' : ''}" data-value="${o.value}">${o.label}</button>
    `).join('');
    document.body.appendChild(panel);

    const rect = trigger.getBoundingClientRect();
    const panelWidth = panel.offsetWidth;
    const panelHeight = panel.offsetHeight;
    const left = Math.max(10, Math.min(rect.right - panelWidth, window.innerWidth - panelWidth - 10));
    const openUpward = window.innerHeight - rect.bottom < panelHeight + 16 && rect.top > panelHeight + 16;
    panel.style.left = `${left}px`;
    panel.style.top = openUpward ? `${rect.top - panelHeight - 8}px` : `${rect.bottom + 8}px`;
    panel.style.transformOrigin = openUpward ? 'bottom right' : 'top right';
    if (openUpward) panel.classList.add('gd-panel--up');

    requestAnimationFrame(() => panel.classList.add('is-open'));

    const close = () => {
      trigger.classList.remove('is-open');
      panel.classList.remove('is-open');
      document.removeEventListener('click', outsideHandler, true);
      window.removeEventListener('scroll', close, true);
      setTimeout(() => panel.remove(), 200);
    };
    const outsideHandler = (e) => { if (!panel.contains(e.target) && e.target !== trigger) close(); };
    setTimeout(() => document.addEventListener('click', outsideHandler, true), 0);
    // Closes on any ancestor scroll (e.g. the Settings list itself scrolling) rather than
    // leaving a now-misaligned panel floating over the wrong spot.
    window.addEventListener('scroll', close, true);

    panel.querySelectorAll('.gd-panel__item').forEach((item) => {
      item.onclick = (e) => {
        e.stopPropagation();
        onSelect(item.dataset.value, item.textContent);
        close();
      };
    });

    return { trigger, panel, close };
  }

  return { html, wire };
})();
