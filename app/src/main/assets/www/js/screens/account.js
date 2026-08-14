const AccountScreen = (() => {
  async function render(el) {
    // Router.show() paints this tab's slide-in transition immediately and does NOT wait for
    // render() to resolve — without this, the tab would animate into view completely blank for
    // however long account/me takes, which reads as "the Account page takes forever to render"
    // whenever the device has been idle a while (a cold WebView network stack reconnecting) or
    // the backend itself is cold-starting (Render's free tier sleeps after inactivity).
    el.innerHTML = `
      <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; gap:14px; padding:80px 20px;">
        <div class="loading-spinner"></div>
        <div style="color:var(--ink-mute); font-size:13px;">Loading account…</div>
      </div>
    `;
    let me;
    try {
      me = await Auth.api('account/me');
    } catch (e) {
      el.innerHTML = `
        <div style="text-align:center; padding:60px 24px; color:var(--ink-dim);">
          <div style="margin-bottom:14px;">Couldn't load your account right now.</div>
          <button class="btn-glass glass" id="acc-retry">Retry</button>
        </div>
      `;
      document.getElementById('acc-retry').onclick = () => render(el);
      return;
    }
    const acc = me.account;
    const roleLabel = { developer: 'Developer', moderator: 'Moderator', beta_tester: 'Beta Tester' }[acc.role] || 'Commercial User';

    el.innerHTML = `
      <div class="glass" style="padding:18px; margin-bottom:16px;">
        <div class="glass glass--pill" style="display:inline-flex; padding:6px 14px; font-size:12px; font-weight:700; margin-bottom:10px;">${roleLabel}</div>
        <div class="display" style="font-size:22px;">${acc.username}</div>
        <div style="color:var(--ink-dim); font-size:13px;">${acc.email}</div>
        <div style="display:flex; gap:10px; margin-top:16px;">
          <button class="btn-glass glass" style="flex:1;" id="acc-rename">Rename</button>
          <button class="btn-glass glass" style="flex:1;" id="acc-reset">Reset Password</button>
        </div>
        <div style="display:flex; gap:10px; margin-top:10px;">
          <button class="btn-glass glass" style="flex:1;" id="acc-logout">Sign Out</button>
          <button class="btn-glass glass" style="flex:1;" id="acc-wipe">Wipe Local Data</button>
        </div>
        <button class="btn-glass glass" style="width:100%; margin-top:10px; color:var(--danger);" id="acc-delete">Delete Account</button>
      </div>

      <div class="glass" style="padding:16px; margin-bottom:16px;">
        <div style="display:flex; align-items:center;"><div class="section-title" style="flex:1;">Licenses</div><button class="icon-btn" id="acc-refresh">${Icons.restore(18)}</button></div>
        <div id="acc-codes" style="margin-top:8px;">
          ${(me.sparkCodes || []).map((c) => `
            <div style="display:flex; align-items:center; padding:8px 0;">
              <div style="flex:1;"><div class="reveal-code" data-code="${c.code}">${'•'.repeat(c.code.length)}</div><div style="font-size:12px; color:var(--ink-mute);">${c.product} · ${c.status}</div></div>
              <button class="icon-btn" data-reveal="${c.code}">${Icons.search(16)}</button>
            </div>
          `).join('') || `<div style="color:var(--ink-mute);">No Spark Codes linked.</div>`}
        </div>
      </div>
    `;

    el.querySelectorAll('[data-reveal]').forEach((btn) => {
      btn.onclick = () => {
        const codeEl = el.querySelector(`.reveal-code[data-code="${btn.dataset.reveal}"]`);
        codeEl.textContent = codeEl.textContent.startsWith('•') ? btn.dataset.reveal : '•'.repeat(btn.dataset.reveal.length);
      };
    });
    document.getElementById('acc-refresh').onclick = () => render(el);
    document.getElementById('acc-rename').onclick = async () => {
      const result = await promptDialog({ title: 'Rename Account', fields: [{ id: 'username', label: 'Username', value: acc.username }] });
      if (result && result.username) Auth.api('account/me', { method: 'PATCH', body: JSON.stringify({ username: result.username }) }).then(() => render(el));
    };
    document.getElementById('acc-reset').onclick = () => {
      Auth.api('auth/request-password-reset', { method: 'POST', body: JSON.stringify({ email: acc.email }) })
        .then(() => Notifications.push({ icon: 'info', title: 'Reset email sent' }));
    };
    document.getElementById('acc-logout').onclick = () => Auth.logout();
    document.getElementById('acc-wipe').onclick = async () => {
      const ok = await confirmDialog({ title: 'Wipe Local Data?', body: 'Tracks, playlists, trash, and settings on this device. Your account itself is not affected.', confirmLabel: 'Wipe', danger: true });
      if (!ok) return;
      await Bridge.call('settings.wipeLocalData');
      Auth.logout();
    };
    document.getElementById('acc-delete').onclick = async () => {
      const ok = await confirmDialog({ title: 'Delete Account?', body: 'Permanently deletes your account and all linked Spark Codes. This cannot be undone.', confirmLabel: 'Delete Account', danger: true });
      if (!ok) return;
      await Auth.api('account/me', { method: 'DELETE' });
      await Bridge.call('settings.wipeLocalData');
      Auth.logout();
    };
  }

  return { render };
})();
