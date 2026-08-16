/** First-launch walkthrough — a skippable, spotlight-style tour that points at the app's own
 *  real chrome (the Discover button, the Discover screen's own search field and Download button,
 *  the bottom nav) instead of a generic "next -> next -> next" popup stack. One .ob-spotlight div
 *  does the highlighting: its box-shadow's huge spread (0 0 0 9999px) IS the dark scrim, and the
 *  "hole" is just wherever the div itself is positioned/sized — so moving the spotlight between
 *  steps is a single left/top/width/height transition, no SVG mask needed. A couple of steps
 *  actually drive the app (opening/closing the real Discover sheet) so what's highlighted is the
 *  genuine screen, not a mockup of it. Runs once — completion is remembered in localStorage,
 *  same sandboxed-per-app storage the rest of auth.js already trusts for session state. */
const Onboarding = (() => {
  const STORAGE_KEY = 'atlas_onboarding_done';
  const MOVE_MS = 460;

  let root = null;
  let steps = [];
  let stepIndex = 0;

  function shouldShow() {
    return localStorage.getItem(STORAGE_KEY) !== '1';
  }

  function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

  function buildSteps() {
    return [
      {
        title: 'Welcome to Ryft',
        body: 'Paste a link, get a song, take it anywhere — offline, forever. Quick 20-second look around?',
        target: null,
      },
      {
        title: 'Discover',
        body: 'Tap here any time to search for a song or drop in a YouTube link.',
        target: () => document.getElementById('btn-discover'),
      },
      {
        title: 'Search or paste a link',
        body: "Type a song name, or paste a YouTube link straight in here — playlists work too.",
        before: async () => {
          if (typeof openIndexedPage === 'function' && typeof DiscoverScreen !== 'undefined') {
            openIndexedPage('discover', DiscoverScreen.content);
            await wait(440);
          }
        },
        target: () => document.getElementById('disc-search'),
      },
      {
        title: 'Download it',
        body: "Select what you want, hit Download, and it's yours — no ads, no connection needed after.",
        target: () => document.getElementById('disc-download'),
      },
      {
        title: 'Playlists',
        body: 'Group your favorites into playlists with their own art and vibe.',
        before: async () => {
          if (typeof closeIndexedPage === 'function') {
            closeIndexedPage('discover');
            await wait(420);
          }
        },
        target: () => document.querySelector('[data-nav="playlists"]'),
      },
      {
        title: 'Make it yours',
        body: 'Colorways, the equalizer, and everything else lives in Settings.',
        target: () => document.querySelector('[data-nav="settings"]'),
      },
      {
        title: "That's it",
        body: 'Go find something to listen to.',
        target: null,
      },
    ];
  }

  async function start() {
    // Guards against ever stacking a second overlay on top of a live one — if that happened, the
    // new instance's Skip/Next would work (it becomes the current `root`), but finish() would
    // then null out `root` while the FIRST, now-orphaned instance is still sitting underneath,
    // still visible once the new one closes, with its own Skip/Next silently no-op'ing against a
    // now-null `root`. Root cause fixed at the call site (app.js's initShell now runs at most
    // once), but this makes Onboarding itself safe against being started twice regardless.
    if (root) return;
    if (!shouldShow()) return;
    steps = buildSteps();
    stepIndex = 0;
    buildRoot();
    await renderStep();
  }

  function buildRoot() {
    root = document.createElement('div');
    root.id = 'onboarding-root';
    root.innerHTML = `
      <div class="ob-spotlight" id="ob-spotlight"></div>
      <button class="ob-skip" id="ob-skip" type="button">Skip</button>
      <div class="glass glass--strong ob-card" id="ob-card">
        <div class="ob-card__dots" id="ob-dots"></div>
        <div class="ob-card__title" id="ob-title"></div>
        <div class="ob-card__body" id="ob-body"></div>
        <button class="btn-primary ob-card__next" id="ob-next" type="button">Next</button>
      </div>
    `;
    document.body.appendChild(root);
    root.querySelector('#ob-skip').onclick = finish;
    root.querySelector('#ob-next').onclick = () => advance();
    requestAnimationFrame(() => root.classList.add('is-visible'));
  }

  async function advance() {
    stepIndex++;
    if (stepIndex >= steps.length) { finish(); return; }
    await renderStep();
  }

  async function renderStep() {
    const step = steps[stepIndex];
    const nextBtn = root.querySelector('#ob-next');
    nextBtn.disabled = true;
    if (step.before) await step.before();
    nextBtn.disabled = false;
    nextBtn.textContent = stepIndex === steps.length - 1 ? "Let's go" : 'Next';

    const titleEl = root.querySelector('#ob-title');
    const bodyEl = root.querySelector('#ob-body');
    // Restart the fade-in keyframe on every step by re-triggering the animation class.
    [titleEl, bodyEl].forEach((el) => { el.style.animation = 'none'; void el.offsetWidth; el.style.animation = ''; });
    titleEl.textContent = step.title;
    bodyEl.textContent = step.body;

    root.querySelector('#ob-dots').innerHTML = steps
      .map((_, i) => `<span class="ob-dot ${i === stepIndex ? 'is-active' : ''}"></span>`)
      .join('');

    positionSpotlightAndCard(step);
  }

  function positionSpotlightAndCard(step) {
    const spotlight = root.querySelector('#ob-spotlight');
    const card = root.querySelector('#ob-card');
    const target = step.target && step.target();
    const cardWidth = Math.min(320, window.innerWidth - 32);
    card.style.width = `${cardWidth}px`;

    if (!target) {
      spotlight.classList.remove('is-active');
      spotlight.style.left = `${window.innerWidth / 2}px`;
      spotlight.style.top = `${window.innerHeight / 2}px`;
      spotlight.style.width = '0px';
      spotlight.style.height = '0px';
      card.style.left = `${(window.innerWidth - cardWidth) / 2}px`;
      card.style.top = '50%';
      card.style.transform = 'translateY(-50%)';
      return;
    }

    const rect = target.getBoundingClientRect();
    const pad = 10;
    spotlight.style.left = `${rect.left - pad}px`;
    spotlight.style.top = `${rect.top - pad}px`;
    spotlight.style.width = `${rect.width + pad * 2}px`;
    spotlight.style.height = `${rect.height + pad * 2}px`;
    spotlight.classList.add('is-active');

    const cardLeft = Math.min(Math.max(rect.left + rect.width / 2 - cardWidth / 2, 16), window.innerWidth - cardWidth - 16);
    card.style.left = `${cardLeft}px`;
    const spaceBelow = window.innerHeight - rect.bottom;
    if (spaceBelow > 210) {
      card.style.top = `${rect.bottom + pad + 18}px`;
      card.style.transform = 'none';
    } else {
      card.style.top = `${rect.top - pad - 18}px`;
      card.style.transform = 'translateY(-100%)';
    }
  }

  function finish() {
    localStorage.setItem(STORAGE_KEY, '1');
    if (typeof closeIndexedPage === 'function') closeIndexedPage('discover');
    if (root) {
      root.classList.remove('is-visible');
      const el = root;
      setTimeout(() => el.remove(), 280);
      root = null;
    }
  }

  return { start };
})();
