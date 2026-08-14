/** Auth screens (Login/Signup/License Key) — talk to Supabase Auth directly (signup/login/
 *  logout/password-reset) and to ryft-keystone (profile/keys) via fetch(), no native bridge
 *  involved. Session token lives in localStorage (this WebView's storage is sandboxed to the
 *  app, same trust boundary a native SessionManager would have). */
const KEYSTONE_BASE_URL = 'https://ryft-keystone.onrender.com/';
const SUPABASE_URL = 'https://vrdujtsvdmzemtosddmv.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'REPLACE_WITH_SB_PUBLISHABLE_KEY';

const Auth = (() => {
  const root = document.getElementById('auth-root');

  function getToken() { return localStorage.getItem('atlas_token'); }
  function setSession(token) { localStorage.setItem('atlas_token', token); }
  function clearSession() {
    localStorage.removeItem('atlas_token');
    localStorage.removeItem('atlas_account_cache');
    localStorage.removeItem('atlas_access_cache');
  }

  function cacheAccount(account) { localStorage.setItem('atlas_account_cache', JSON.stringify(account)); }
  function getCachedAccount() {
    try { return JSON.parse(localStorage.getItem('atlas_account_cache') || 'null'); } catch { return null; }
  }

  /** Stable per-install id — sent as deviceId/X-Device-Id so the backend's session-revocation
   *  and login-ping/keys-redeem device tracking has something consistent to key off of. */
  function deviceId() {
    let id = localStorage.getItem('atlas_device_id');
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem('atlas_device_id', id);
    }
    return id;
  }

  async function api(path, options = {}) {
    const token = getToken();
    let res;
    try {
      res = await fetch(KEYSTONE_BASE_URL + path, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          'X-Device-Id': deviceId(),
          ...(options.headers || {}),
        },
      });
    } catch (networkErr) {
      // fetch() itself rejecting (offline, DNS, timeout, Render cold-start not even responding
      // yet) — no HTTP status at all, so this can never be mistaken for a real auth rejection.
      const e = new Error('Network error — check your connection.');
      e.isNetworkError = true;
      throw e;
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(body.error || 'Something went wrong.');
      e.status = res.status;
      e.body = body;
      throw e;
    }
    return body;
  }

  /** Calls Supabase Auth directly (signup/token/logout/recover) — ryft-keystone has no /auth
   *  routes of its own; Supabase Auth owns the credential, ryft-keystone owns the profile. */
  async function supabaseAuth(path, body, extraHeaders = {}) {
    let res;
    try {
      res = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_PUBLISHABLE_KEY,
          ...extraHeaders,
        },
        body: JSON.stringify(body),
      });
    } catch (networkErr) {
      const e = new Error('Network error — check your connection.');
      e.isNetworkError = true;
      throw e;
    }
    const respBody = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(respBody.error_description || respBody.msg || respBody.error || 'Something went wrong.');
      e.status = res.status;
      e.body = respBody;
      throw e;
    }
    return respBody;
  }

  async function requestPasswordReset(email) {
    return supabaseAuth('recover', { email });
  }

  /** Whether the calling user currently holds a non-revoked, non-suspended key for Atlas. */
  async function hasAtlasAccess() {
    const { keys } = await api('keys/mine');
    return (keys || []).some((k) => k.product && k.product.slug === 'atlas' && !k.revoked && !k.suspended);
  }

  /** Shown synchronously the instant the app launches, before anything async (session-resume
   *  network call) has a chance to leave the screen blank. Root cause of "the login screen
   *  takes forever to appear": tryResumeSession() used to await a network round-trip to the
   *  Render-hosted backend (which can cold-start-sleep on the free tier and take 30-60s+ to
   *  wake) with #auth-root left completely empty the whole time — nothing was slow to compute,
   *  nothing was ever shown while waiting. This guarantees real UI paints immediately. */
  function renderLoading() {
    root.innerHTML = `
      <div class="auth-screen" style="align-items:center; justify-content:center;">
        <div class="display" style="font-size:28px; margin-bottom:18px;">Atlas</div>
        <div class="loading-spinner"></div>
      </div>
    `;
  }

  /** Password show/hide eye toggle — morphs eye-with-slash (hidden, the default) <-> plain eye
   *  (visible) via the shared .icon-morph-btn pattern, same technique Now Playing's 3-dot->X
   *  menu button uses. */
  function passwordFieldHtml(id, label, placeholder) {
    return `
      <div class="field">
        <label>${label}</label>
        <div class="password-field-wrap">
          <input type="password" id="${id}" placeholder="${placeholder}">
          <button type="button" class="icon-btn icon-morph-btn password-toggle" id="${id}-toggle" tabindex="-1">
            <span class="icon-morph-icon icon-morph-icon--a">${Icons.eyeOff(18)}</span>
            <span class="icon-morph-icon icon-morph-icon--b">${Icons.eye(18)}</span>
          </button>
        </div>
      </div>
    `;
  }
  function wirePasswordToggle(id) {
    const input = document.getElementById(id);
    const btn = document.getElementById(`${id}-toggle`);
    btn.onclick = () => {
      const nowVisible = input.type === 'password';
      input.type = nowVisible ? 'text' : 'password';
      btn.classList.toggle('is-open', nowVisible);
    };
  }

  /** Sign in / Create account / Unlock — swaps the button's label for a spinner while the
   *  request is in flight, so pressing it visibly does something instead of appearing to do
   *  nothing until the network call resolves. */
  async function submitWithSpinner(btn, fn) {
    const originalHtml = btn.innerHTML;
    btn.classList.add('is-loading');
    btn.innerHTML = '<span class="btn-spinner"></span>';
    try {
      await fn();
    } finally {
      btn.classList.remove('is-loading');
      btn.innerHTML = originalHtml;
    }
  }

  function renderLogin() {
    root.innerHTML = `
      <div class="auth-screen">
        <h1 class="display auth-title">Sign in with Ryft Keystone</h1>
        <p class="auth-sub">Your Ryft Keystone account unlocks Atlas and every future Ryft app.</p>
        <div class="glass glass--strong auth-card">
          <div class="field"><label>Email</label><input type="email" id="login-email" placeholder="you@example.com"></div>
          ${passwordFieldHtml('login-password', 'Password', '••••••••')}
          <div class="auth-error" id="login-error" hidden></div>
          <button class="btn-primary" id="login-submit" style="width:100%; margin-top:14px;">Sign In</button>
        </div>
        <button class="btn-glass" id="go-signup" style="margin-top:16px;">Don't have an account? Sign up</button>
      </div>
    `;
    wirePasswordToggle('login-password');
    document.getElementById('go-signup').onclick = renderSignup;
    document.getElementById('login-submit').onclick = async (e) => {
      const email = document.getElementById('login-email').value.trim();
      const password = document.getElementById('login-password').value;
      const errEl = document.getElementById('login-error');
      errEl.hidden = true;
      await submitWithSpinner(e.currentTarget, async () => {
        try {
          const tokenResp = await supabaseAuth('token?grant_type=password', { email, password });
          setSession(tokenResp.access_token);
          api('account/login-ping', { method: 'POST', body: JSON.stringify({ deviceId: deviceId() }) }).catch(() => {});
          const profile = await api('account/me');
          await proceedPastAuth(profile);
        } catch (err) {
          errEl.textContent = err.message; errEl.hidden = false;
        }
      });
    };
  }

  function renderSignup() {
    root.innerHTML = `
      <div class="auth-screen">
        <h1 class="display auth-title">Create your Ryft Keystone account</h1>
        <p class="auth-sub">One account for Atlas and every Ryft app to come.</p>
        <div class="glass glass--strong auth-card">
          <div class="field"><label>Username</label><input id="su-username" placeholder="username"></div>
          <div class="field"><label>Email</label><input type="email" id="su-email" placeholder="you@example.com"></div>
          ${passwordFieldHtml('su-password', 'Password', 'At least 8 characters')}
          <div class="auth-error" id="su-error" hidden></div>
          <button class="btn-primary" id="su-submit" style="width:100%; margin-top:14px;">Create Account</button>
        </div>
        <button class="btn-glass" id="go-login" style="margin-top:16px;">Already have an account? Sign in</button>
      </div>
    `;
    wirePasswordToggle('su-password');
    document.getElementById('go-login').onclick = renderLogin;
    document.getElementById('su-submit').onclick = async (e) => {
      const username = document.getElementById('su-username').value.trim();
      const email = document.getElementById('su-email').value.trim();
      const password = document.getElementById('su-password').value;
      const errEl = document.getElementById('su-error');
      errEl.hidden = true;
      await submitWithSpinner(e.currentTarget, async () => {
        try {
          const body = await supabaseAuth('signup', { email, password });
          if (!body.access_token) {
            // Email confirmation is required before a session is issued — nothing more to do
            // client-side until they confirm and come back to sign in.
            errEl.textContent = 'Check your email to confirm your account, then sign in.';
            errEl.hidden = false;
            setTimeout(renderLogin, 2200);
            return;
          }
          setSession(body.access_token);
          if (username) {
            // Best-effort: a taken/invalid username shouldn't block getting into the app —
            // the Account page's Rename flow can fix it later.
            await api('account/me', { method: 'PATCH', body: JSON.stringify({ username }) }).catch(() => {});
          }
          api('account/login-ping', { method: 'POST', body: JSON.stringify({ deviceId: deviceId() }) }).catch(() => {});
          const profile = await api('account/me');
          await proceedPastAuth(profile);
        } catch (err) {
          errEl.textContent = err.message; errEl.hidden = false;
        }
      });
    };
  }

  function renderLicenseKey() {
    root.innerHTML = `
      <div class="auth-screen">
        <h1 class="display auth-title">Enter your License Key</h1>
        <p class="auth-sub">Atlas is gated behind a license key (RYFT-XXXX-XXXX-XXXX-XXXX). Enter yours to continue.</p>
        <div class="glass glass--strong auth-card">
          <div class="field"><label>License Key</label><input id="lk-key" placeholder="RYFT-XXXX-XXXX-XXXX-XXXX" style="text-transform:uppercase"></div>
          <div class="auth-error" id="lk-error" hidden></div>
          <button class="btn-primary" id="lk-submit" style="width:100%; margin-top:14px;">Unlock Atlas</button>
        </div>
      </div>
    `;
    document.getElementById('lk-submit').onclick = async (e) => {
      const key = document.getElementById('lk-key').value.trim().toUpperCase();
      const errEl = document.getElementById('lk-error');
      errEl.hidden = true;
      await submitWithSpinner(e.currentTarget, async () => {
        try {
          await api('keys/redeem', { method: 'POST', body: JSON.stringify({ key, deviceId: deviceId() }) });
          if (await hasAtlasAccess()) {
            localStorage.setItem('atlas_access_cache', '1');
            enterShell();
          } else {
            errEl.textContent = "That key isn't valid for Atlas.";
            errEl.hidden = false;
          }
        } catch (err) {
          errEl.textContent = err.message; errEl.hidden = false;
        }
      });
    };
  }

  async function proceedPastAuth(profile) {
    cacheAccount(profile);
    AppStore.set({ account: profile });
    if (await hasAtlasAccess()) {
      localStorage.setItem('atlas_access_cache', '1');
      enterShell();
    } else {
      localStorage.removeItem('atlas_access_cache');
      renderLicenseKey();
    }
  }

  function enterShell() {
    root.hidden = true;
    document.getElementById('shell-root').hidden = false;
    AppStore.set({ authed: true });
    document.dispatchEvent(new CustomEvent('atlas:authed'));
  }

  /** Shown only for a genuine, confirmed revocation (account suspended/banned/deleted) — never
   *  for a network blip or an ordinary expired-token resume. Shows the raw status text from the
   *  backend rather than a guessed-at message, since that's the actual source of truth for
   *  *why* ("Account is suspended" etc., from ryft-keystone's requireAuth middleware). */
  function renderRevoked(reasonText) {
    document.getElementById('shell-root').hidden = true;
    root.hidden = false;
    root.innerHTML = `
      <div class="auth-screen" style="align-items:center; justify-content:center; text-align:center;">
        <div class="display" style="font-size:24px; margin-bottom:10px;">Your license has been ${escapeHtml(extractStatusWord(reasonText))}</div>
        <p class="auth-sub" style="margin-bottom:20px;">This device can't access Atlas until this is resolved. If you believe this is a mistake, contact support.</p>
        <div class="glass glass--strong auth-card" style="text-align:left;">
          <div style="font-family:var(--font-mono, monospace); font-size:12px; color:var(--ink-dim); white-space:pre-wrap; word-break:break-word;">${escapeHtml(lastRevokedRaw || reasonText || '')}</div>
        </div>
        <div style="display:flex; gap:10px; margin-top:18px; width:100%; max-width:340px;">
          <button class="btn-glass glass" id="revoked-refresh" style="flex:1;">Refresh</button>
          <button class="btn-glass glass" id="revoked-signout" style="flex:1; color:var(--danger);">Sign Out</button>
        </div>
      </div>
    `;
    document.getElementById('revoked-refresh').onclick = () => checkSessionInBackground();
    document.getElementById('revoked-signout').onclick = logout;
  }

  /** Backend sends "Account is suspended" for a 403 — pull just the status word out so the
   *  "Your license has been ___" heading reads naturally instead of doubling up the sentence. */
  function extractStatusWord(message) {
    const match = /is (\w+)/i.exec(message || '');
    return match ? match[1] : 'revoked';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  let lastRevokedRaw = '';
  let backgroundCheckInFlight = false;

  /** The actual fix for "I should NEVER have to sign in unless forced signed out" — runs
   *  silently against whatever's currently on screen (shell or revoked screen) instead of
   *  blocking with a spinner/login prompt. Only two outcomes ever interrupt the user:
   *  a 403 with a suspended/banned/deleted account (renderRevoked), or a 401 meaning
   *  the token itself is actually invalid/expired (a real sign-out condition, not a hiccup).
   *  Everything else — no network, Render cold-start, a 500, a timeout — is swallowed and
   *  retried on the next check, leaving the user exactly where they were. */
  async function checkSessionInBackground() {
    if (!getToken() || backgroundCheckInFlight) return;
    backgroundCheckInFlight = true;
    try {
      const profile = await api('account/me');
      cacheAccount(profile);
      AppStore.set({ account: profile });
      if (!root.hidden && AppStore.get('authed')) {
        // Was showing the revoked screen and it just cleared — hop back into the shell.
        enterShell();
      }
    } catch (e) {
      if (e.isNetworkError) {
        // Transient — say nothing, try again next time.
      } else if (e.status === 403) {
        lastRevokedRaw = (e.body && (e.body.error || JSON.stringify(e.body))) || e.message;
        renderRevoked(e.message);
      } else if (e.status === 401) {
        clearSession();
        AppStore.set({ authed: false, account: null });
        document.getElementById('shell-root').hidden = true;
        root.hidden = false;
        renderLogin();
      }
      // any other status (5xx etc.) — also transient from the app's point of view, ignore.
    } finally {
      backgroundCheckInFlight = false;
    }
  }

  /** Called from native (MainActivity.onResume) every time the app comes back to the
   *  foreground — the actual "recheck on resume" hook, entirely non-blocking. */
  function onAppResume() {
    checkSessionInBackground();
  }

  async function tryResumeSession() {
    const token = getToken();
    if (!token) { renderLogin(); return; }

    const cached = getCachedAccount();
    if (cached && localStorage.getItem('atlas_access_cache') === '1') {
      // Instant, optimistic entry — no network round-trip blocks the UI. The real check still
      // happens, just silently in the background afterward.
      AppStore.set({ account: cached });
      enterShell();
      checkSessionInBackground();
      return;
    }

    // No usable cache yet (first resume right after login on a fresh install) — nothing to
    // optimistically show, so this one time it's a real blocking check.
    renderLoading();
    try {
      const profile = await api('account/me');
      await proceedPastAuth(profile);
    } catch (e) {
      if (e.isNetworkError) {
        // Can't even reach the backend on a completely cold cache — nothing to fall back to,
        // so surface login rather than leaving a blank/frozen loading screen forever.
        renderLogin();
      } else if (e.status === 403) {
        lastRevokedRaw = (e.body && (e.body.error || JSON.stringify(e.body))) || e.message;
        renderRevoked(e.message);
      } else if (e.status === 401) {
        // The token itself is genuinely invalid/expired — the one real sign-out condition.
        clearSession();
        renderLogin();
      } else {
        // Anything else (5xx, a Render cold-start error page, a malformed response) is
        // transient, exactly like checkSessionInBackground() already treats it — NOT a reason
        // to sign out. Show login without discarding the token, so the next resume/relaunch
        // can still succeed with it.
        renderLogin();
      }
    }
  }

  function logout() {
    const token = getToken();
    clearSession();
    document.getElementById('shell-root').hidden = true;
    root.hidden = false;
    AppStore.set({ authed: false, account: null });
    renderLogin();
    if (token) {
      // Best-effort server-side invalidation — local sign-out already happened above regardless.
      supabaseAuth('logout', {}, { Authorization: `Bearer ${token}` }).catch(() => {});
    }
  }

  // Belt-and-suspenders alongside the native onResume hook — covers the case where the WebView
  // itself (not the whole Activity) toggles visibility, and gives a periodic recheck while the
  // app just sits open in the foreground for a long session.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkSessionInBackground(); });
  setInterval(() => { if (!document.hidden) checkSessionInBackground(); }, 15 * 60 * 1000);

  return { api, tryResumeSession, logout, getToken, onAppResume, requestPasswordReset };
})();
