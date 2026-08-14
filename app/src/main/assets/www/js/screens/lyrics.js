/** Lyrics panel — lives inside the Now Playing indexed page (see nowPlaying.js's np-slider).
 *  Synced lyrics: LRCLIB (lrclib.net, free, no account/key). Translations: MyMemory
 *  (api.mymemory.translated.net, free public API, also no account/key). Searches both the
 *  track's current (possibly renamed) title/artist and its original YouTube title/uploader for
 *  lyrics lookup, since a lyrics provider is far more likely to have an entry under the real
 *  song metadata than whatever a user renamed a track to. */
const LyricsScreen = (() => {
  const cache = new Map(); // trackId -> parsed lines (or 'none')
  let stateUnsub = null;
  let tickTimer = null;
  let localPositionMs = 0;
  let isPlayingLocal = false;
  let fullscreen = false;
  let lines = [];
  let activeIndex = -1;
  let container = null;
  let isPlainMode = false;
  let currentLineTexts = [];
  let translatedLineTexts = null;
  let translationsOn = false;

  function fmtTime(ms) {
    const total = Math.floor(Math.max(0, ms || 0) / 1000);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  function escapeHtmlLy(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /** Translates every lyric line via MyMemory (api.mymemory.translated.net) — a free public
   *  translation API that needs no account or API key. Its anonymous tier caps requests at ~500
   *  bytes each, so unlike the old single-batched-request approach this fires one request per
   *  line (in parallel) rather than joining the whole lyric sheet into one call. Source language
   *  is passed as "autodetect", which MyMemory supports directly. */
  async function translateLines(textLines) {
    const target = (navigator.language || 'en').split('-')[0];
    try {
      const results = await Promise.all(textLines.map(async (line) => {
        const trimmed = (line || '').trim();
        if (!trimmed) return '';
        try {
          const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(trimmed)}&langpair=autodetect|${encodeURIComponent(target)}`;
          const res = await fetch(url);
          const body = await res.json().catch(() => null);
          return body?.responseData?.translatedText || line;
        } catch (e) {
          return line; // this one line fails closed to the original text, not the whole batch
        }
      }));
      return results;
    } catch (e) {
      return null;
    }
  }

  async function fetchLrclibCandidate(title, artist) {
    if (!title || !artist) return null;
    try {
      const url = `https://lrclib.net/api/search?track_name=${encodeURIComponent(title)}&artist_name=${encodeURIComponent(artist)}`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const results = await res.json();
      // Was previously ONLY ever accepting a result with syncedLyrics, silently discarding the
      // whole search (falling through to "no lyrics found") whenever LRCLIB only had a
      // plainLyrics-only entry for a track — which is common on their catalog and exactly what
      // "the site clearly has lyrics for this song but the app shows none" was actually caused
      // by. Falls back to plain lyrics now instead of treating that as no match at all.
      const withSynced = (results || []).find((r) => r.syncedLyrics);
      if (withSynced) return { synced: true, text: withSynced.syncedLyrics };
      const withPlain = (results || []).find((r) => r.plainLyrics);
      if (withPlain) return { synced: false, text: withPlain.plainLyrics };
      return null;
    } catch (e) {
      return null;
    }
  }

  function parseLrc(lrc) {
    const parsed = [];
    lrc.split('\n').forEach((line) => {
      const matches = [...line.matchAll(/\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g)];
      if (!matches.length) return;
      const text = line.replace(/\[\d{1,2}:\d{2}(?:\.\d{1,3})?\]/g, '').trim();
      matches.forEach((m) => {
        const min = Number(m[1]);
        const sec = Number(m[2]);
        const frac = m[3] ? Number(m[3].padEnd(3, '0')) : 0;
        parsed.push({ timeMs: min * 60000 + sec * 1000 + frac, text });
      });
    });
    return parsed.sort((a, b) => a.timeMs - b.timeMs);
  }

  /** Strips common YouTube-title noise — "(Official Video)", "[Lyrics]", "ft. X", a trailing
   *  " - Topic" (YouTube Music's auto-generated channel suffix) or " VEVO", pipe-delimited
   *  trailing junk, etc. — before querying a lyrics provider. Raw video titles routinely carry
   *  this, and it's often enough on its own to make an otherwise-correct search return nothing,
   *  even when the provider genuinely has the song (confirmed case: a title like
   *  "trigga500k - Ether (Official Audio)" failing to match "Ether" on LRCLIB). */
  function cleanLyricsQuery(text) {
    if (!text) return text;
    let s = text;
    s = s.replace(/[([{][^)\]}]*[)\]}]/g, ' '); // (Official Video), [Lyrics], (HD), etc.
    s = s.replace(/\b(official\s*(music\s*)?video|official\s*audio|lyric\s*video|lyrics?|visualizer|explicit|clean\s*version|hd|hq|4k|full\s*song|audio)\b/gi, ' ');
    s = s.replace(/\b(prod\.?\s*by\s+[\w .&'-]+|ft\.?\s+[\w .&'-]+|feat\.?\s+[\w .&'-]+)/gi, ' ');
    s = s.split('|')[0];
    s = s.replace(/\s*-\s*topic$/i, '').replace(/\s*vevo$/i, '');
    s = s.replace(/\s{2,}/g, ' ').replace(/^[\s\-–—:]+|[\s\-–—:]+$/g, '').trim();
    return s || text; // never return an empty query
  }

  async function loadLyrics(track) {
    if (cache.has(track.id)) return cache.get(track.id);

    const hasOriginal = track.originalTitle && track.originalArtist &&
      (track.originalTitle !== track.title || track.originalArtist !== track.artist);

    // Every (title, artist) candidate worth trying, in order: current metadata, original
    // YouTube metadata, then cleaned versions of both (junk-stripped titles only help once the
    // raw ones have already failed — cleaning can occasionally strip something meaningful, so
    // it's a fallback, not the first attempt).
    const candidates = [[track.title, track.artist]];
    if (hasOriginal) candidates.push([track.originalTitle, track.originalArtist]);
    candidates.push([cleanLyricsQuery(track.title), track.artist]);
    if (hasOriginal) candidates.push([cleanLyricsQuery(track.originalTitle), track.originalArtist]);

    // LRCLIB — the only lyrics source now (free, no key), trying every candidate.
    let lrclib = null;
    for (const [t, a] of candidates) {
      lrclib = await fetchLrclibCandidate(t, a);
      if (lrclib) break;
    }
    if (lrclib) {
      const result = lrclib.synced ? parseLrc(lrclib.text) : { synced: false, lines: lrclib.text.split('\n').filter((l) => l.trim()) };
      cache.set(track.id, result);
      return result;
    }

    cache.set(track.id, 'none');
    return 'none';
  }

  function render(panelEl, track, onBack) {
    container = panelEl;
    fullscreen = false;
    lines = [];
    activeIndex = -1;
    isPlainMode = false;
    currentLineTexts = [];
    translatedLineTexts = null;
    translationsOn = false;

    const state = AppStore.get('playbackState') || {};
    localPositionMs = state.positionMs || 0;
    isPlayingLocal = !!state.isPlaying;

    panelEl.innerHTML = `
      <div class="ly-root">
        <div class="ly-header">
          <button class="icon-btn" id="ly-back">${Icons.chevronLeft(22)}</button>
          <div class="ly-header__meta">
            <div class="ly-header__title">${track.title}</div>
            <div class="ly-header__artist">${track.artist}</div>
          </div>
          <button class="icon-btn" id="ly-minimize">${Icons.chevronDown(22)}</button>
        </div>
        <div class="ly-actions">
          <button class="ly-action-btn" id="ly-translate">${Icons.translate(16)} Translations</button>
          <button class="ly-action-btn" id="ly-share">${Icons.share(16)} Share</button>
          <button class="ly-action-btn" id="ly-fullscreen">${Icons.expand(16)} Fullscreen</button>
        </div>
        <div class="ly-lines-frame">
          <div class="ly-lines" id="ly-lines">
            <div class="ly-loading">Searching for synced lyrics…</div>
          </div>
        </div>
        <div class="ly-time-row">
          <span>${fmtTime(localPositionMs)}</span>
          <span>${fmtTime(state.durationMs)}</span>
        </div>
      </div>
    `;

    panelEl.querySelector('#ly-back').onclick = () => { teardown(); onBack(); };
    panelEl.querySelector('#ly-minimize').onclick = () => { teardown(); closeIndexedPage('nowPlaying'); };
    panelEl.querySelector('#ly-translate').onclick = async () => {
      const btn = panelEl.querySelector('#ly-translate');
      if (!currentLineTexts.length) return;
      translationsOn = !translationsOn;
      btn.classList.toggle('is-active', translationsOn);
      if (translationsOn && !translatedLineTexts) {
        const linesEl = panelEl.querySelector('#ly-lines');
        if (linesEl) linesEl.style.opacity = '0.4';
        translatedLineTexts = await translateLines(currentLineTexts);
        if (linesEl) linesEl.style.opacity = '1';
        if (!translatedLineTexts) {
          translationsOn = false;
          btn.classList.remove('is-active');
          Notifications.push({ icon: 'info', title: 'Translation failed', body: 'Could not reach the translation service.' });
          return;
        }
      }
      renderLineEls();
      if (!isPlainMode) updateActiveLine(true);
    };
    panelEl.querySelector('#ly-share').onclick = () => {}; // deliberately not wired, per spec
    panelEl.querySelector('#ly-fullscreen').onclick = () => {
      fullscreen = !fullscreen;
      panelEl.querySelector('.ly-root').classList.toggle('is-fullscreen', fullscreen);
    };

    loadLyrics(track).then((result) => {
      const linesEl = panelEl.querySelector('#ly-lines');
      if (!linesEl) return; // panel torn down (user navigated away) before fetch resolved
      if (result === 'none') {
        linesEl.innerHTML = `<div class="ly-empty">No lyrics found for this track on LRCLIB.</div>`;
        return;
      }
      if (!Array.isArray(result)) {
        // Plain-text fallback (Musixmatch without synced-subtitle access on this API key) — no
        // timestamps to karaoke-highlight against, so just render static lines.
        isPlainMode = true;
        lines = [];
        currentLineTexts = result.lines;
        renderLineEls();
        return;
      }
      isPlainMode = false;
      lines = result;
      currentLineTexts = lines.map((l) => l.text);
      renderLineEls();
      updateActiveLine(true);
    });

    stateUnsub = Bridge.on('playback.state', (s) => {
      localPositionMs = s.positionMs || 0;
      isPlayingLocal = !!s.isPlaying;
      const timeRow = panelEl.querySelector('.ly-time-row span:first-child');
      if (timeRow) timeRow.textContent = fmtTime(localPositionMs);
    });
    tickTimer = setInterval(() => {
      if (isPlayingLocal) {
        localPositionMs += 250;
        updateActiveLine(false);
      }
    }, 250);
  }

  function renderLineEls() {
    const linesEl = container?.querySelector('#ly-lines');
    if (!linesEl) return;
    const texts = (translationsOn && translatedLineTexts) ? translatedLineTexts : currentLineTexts;
    linesEl.innerHTML = isPlainMode
      ? texts.map((t) => `<div class="ly-line is-plain">${escapeHtmlLy(t)}</div>`).join('')
      : texts.map((t, i) => `<div class="ly-line" data-i="${i}">${escapeHtmlLy(t) || '&nbsp;'}</div>`).join('');
  }

  function updateActiveLine(forceScroll) {
    if (!lines.length || !container) return;
    let idx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].timeMs <= localPositionMs) idx = i; else break;
    }
    if (idx === activeIndex && !forceScroll) return;
    activeIndex = idx;
    const linesEl = container.querySelector('#ly-lines');
    if (!linesEl) return;
    linesEl.querySelectorAll('.ly-line').forEach((el, i) => {
      el.classList.toggle('is-active', i === idx);
      el.classList.toggle('is-past', i < idx);
    });
    const activeEl = linesEl.querySelector('.ly-line.is-active');
    if (activeEl) activeEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function teardown() {
    stateUnsub?.();
    stateUnsub = null;
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  }

  return { render };
})();
