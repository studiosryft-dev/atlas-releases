/** Shared close-animation helper for every ad-hoc overlay in the app (action sheets, bottom
 *  sheets, popups, confirm modals) — all of these are plain elements created via
 *  document.body.appendChild and torn down with .remove(). Their *entrance* already animates via
 *  a one-shot CSS @keyframes applied on mount (fadeSlideUp/fadeIn/etc.); what none of them had
 *  was an *exit* animation — they just vanished instantly on .remove(). This adds a `.is-closing`
 *  class (each overlay's CSS defines what that transitions to) and waits for the transition to
 *  actually finish — with a hard timeout fallback in case a browser quirk ever drops the event —
 *  before detaching the node(s) from the DOM. */
function closeOverlayAnimated(...els) {
  const targets = els.filter(Boolean);
  if (!targets.length) return;
  targets.forEach((el) => el.classList.add('is-closing'));
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    targets.forEach((el) => el.remove());
  };
  targets[0].addEventListener('transitionend', finish, { once: true });
  setTimeout(finish, 260);
}

/** Keeps a fixed, vertically-centered overlay's content from being covered by the on-screen
 *  keyboard. Android's visualViewport shrinks (its own height, distinct from the layout
 *  viewport) when the keyboard opens; syncing the overlay's own height/top to that shrunk value
 *  keeps its `align-items:center` centering within the space actually still visible above the
 *  keyboard, instead of centering against the full (now keyboard-covered) screen height — which
 *  was the actual accessibility issue: the input/buttons could end up rendered underneath the
 *  keyboard, out of reach. Returns a cleanup function to call once the overlay closes. */
function applyKeyboardAvoidance(overlay) {
  const vv = window.visualViewport;
  if (!vv) return () => {};
  const sync = () => {
    overlay.style.height = `${vv.height}px`;
    overlay.style.top = `${vv.offsetTop}px`;
  };
  sync();
  vv.addEventListener('resize', sync);
  vv.addEventListener('scroll', sync);
  return () => {
    vv.removeEventListener('resize', sync);
    vv.removeEventListener('scroll', sync);
  };
}

/** Custom styled, animated replacement for window.prompt() — one or more labeled text fields in
 *  a glass modal (same .confirm-modal-overlay/.confirm-modal-card chrome the Erase Library
 *  dialog already uses), Cancel/confirm buttons. Resolves to an object of {fieldId: value} on
 *  confirm, or null on cancel/outside-tap/dismiss. */
function promptDialog({ title, fields, confirmLabel = 'Save' }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-modal-overlay';
    const cleanupKeyboardAvoidance = applyKeyboardAvoidance(overlay);
    let resolved = false;
    const close = (result) => {
      if (resolved) return;
      resolved = true;
      cleanupKeyboardAvoidance();
      closeOverlayAnimated(overlay);
      resolve(result);
    };
    overlay.innerHTML = `
      <div class="glass glass--strong confirm-modal-card">
        <div class="display" style="font-size:18px; margin-bottom:14px;">${title}</div>
        ${fields.map((f) => `
          <div class="field">
            <label>${f.label}</label>
            <input id="pd-${f.id}" value="${String(f.value || '').replace(/"/g, '&quot;')}" placeholder="${f.placeholder || ''}">
          </div>
        `).join('')}
        <div style="display:flex; gap:10px; margin-top:8px;">
          <button class="btn-glass glass" id="pd-cancel" style="flex:1;">Cancel</button>
          <button class="btn-primary" id="pd-confirm" style="flex:1;">${confirmLabel}</button>
        </div>
      </div>
    `;
    overlay.querySelector('#pd-cancel').onclick = () => close(null);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
    overlay.querySelector('#pd-confirm').onclick = () => {
      const result = {};
      fields.forEach((f) => { result[f.id] = overlay.querySelector(`#pd-${f.id}`).value; });
      close(result);
    };
    const inputs = overlay.querySelectorAll('input');
    inputs.forEach((inp, i) => {
      inp.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        if (i < inputs.length - 1) inputs[i + 1].focus();
        else overlay.querySelector('#pd-confirm').click();
      });
    });
    document.body.appendChild(overlay);
    requestAnimationFrame(() => inputs[0]?.focus());
  });
}

/** Custom styled, animated replacement for window.confirm(). Resolves to true (confirmed) or
 *  false (cancelled/outside-tap/dismissed). */
function confirmDialog({ title, body, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-modal-overlay';
    let resolved = false;
    const close = (result) => {
      if (resolved) return;
      resolved = true;
      closeOverlayAnimated(overlay);
      resolve(result);
    };
    overlay.innerHTML = `
      <div class="glass glass--strong confirm-modal-card">
        <div class="display" style="font-size:18px; margin-bottom:8px;">${title}</div>
        ${body ? `<div style="color:var(--ink-dim); font-size:14px; line-height:1.5; margin-bottom:16px;">${body}</div>` : ''}
        <div style="display:flex; gap:10px;">
          <button class="btn-glass glass" id="cd-cancel" style="flex:1;">Cancel</button>
          <button class="btn-glass glass" id="cd-confirm" style="flex:1; ${danger ? 'color:var(--danger);' : ''}">${confirmLabel}</button>
        </div>
      </div>
    `;
    overlay.querySelector('#cd-cancel').onclick = () => close(false);
    overlay.querySelector('#cd-confirm').onclick = () => close(true);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
    document.body.appendChild(overlay);
  });
}
