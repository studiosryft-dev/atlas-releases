/** Equalizer — a real fixed-bandwidth graphic equalizer: 5 draggable points at fixed frequency
 *  positions (60Hz/250Hz/1kHz/4kHz/12kHz), each only draggable vertically (gain/volume at that
 *  band), never horizontally (bandwidth is fixed, not user-movable). Two entry points share the
 *  same rendering core:
 *   - `EmbeddedEqualizer.mount(rootEl)` — the global equalizer, embedded directly inside
 *     Settings' "Equalizer & Effects" accordion body, no indexed-page/close chrome.
 *   - `EqualizerScreen.open(ownerId, ownerType, title)` — per-track/per-playlist overrides,
 *     still opened as an Indexed Page overlay (unchanged call signature from before this rework
 *     — Library's 3-dot menu and the Playlist header both call this).
 *  Native side: WebAppBridge's equalizer.* actions, EqualizerController (system
 *  android.media.audiofx.Equalizer, reactively applied) — see EqualizerPresets.kt for exactly
 *  where the 5 fixed frequencies/gain-to-device-band interpolation happens. */
const EqualizerCore = (() => {
  const GRAPH_HEIGHT = 130; // matches the reference graph's 320x130 aspect ratio
  const RANGE_DB = 15; // UI always shows +-15dB regardless of what the device itself supports

  function render(root, ctx, embedded) {
    load(root, ctx, embedded);
  }

  async function load(root, ctx, embedded) {
    const state = await Bridge.call('equalizer.getConfig', { ownerId: ctx.ownerId || '', ownerType: ctx.ownerType || '' });
    const presets = await Bridge.call('equalizer.presets'); // [[id, label], ...]
    draw(root, ctx, embedded, state, presets);
  }

  function draw(root, ctx, embedded, state, presets) {
    const gains = state.gainsDb && state.gainsDb.length === 5 ? state.gainsDb.slice() : [0, 0, 0, 0, 0];
    const freqLabels = ['60', '250', '1K', '4K', '12K'];

    root.innerHTML = `
      ${embedded ? '' : `
        <div class="indexed-page__mini-header">
          <div class="display" style="font-size:20px;">${ctx.title}</div>
          <button class="icon-btn" id="eq-close">${Icons.close(20)}</button>
        </div>
      `}
      <div style="display:flex; align-items:center; margin-bottom:14px;">
        <div style="flex:1;">Enabled</div>
        <div class="switch ${state.enabled ? 'is-on' : ''}" id="eq-enabled"></div>
      </div>
      <div class="glass" style="padding:18px 16px 10px;">
        <div id="eq-graph"></div>
        <div id="eq-freq-labels" style="position:relative; height:16px; margin-top:6px; font-size:11px; color:var(--ink-mute);"></div>
      </div>
      <div style="display:flex; gap:10px; margin-top:14px;">
        ${state.hasOwnOverride ? `<button class="btn-glass glass" style="flex:1;" id="eq-use-global">Use Global Default</button>` : ''}
        <button class="btn-glass glass" style="flex:1;" id="eq-reset">${Icons.restore(16)} Reset</button>
        <button class="btn-primary" style="flex:1;" id="eq-save">Save</button>
      </div>
      <div style="color:var(--ink-mute); font-size:12px; margin:16px 0 8px;">Presets</div>
      <div style="display:flex; gap:8px; overflow-x:auto; padding-bottom:4px;">
        ${presets.map((p) => `<button class="chip glass ${state.presetId === p[0] ? 'is-selected' : ''}" data-preset="${p[0]}">${p[1]}</button>`).join('')}
      </div>
    `;

    if (!embedded) root.querySelector('#eq-close').onclick = () => { Bridge.call('equalizer.clearLive'); closeIndexedPage('equalizer'); };

    root.querySelector('#eq-enabled').onclick = (e) => {
      state.enabled = !state.enabled;
      e.target.classList.toggle('is-on', state.enabled);
      pushLive(ctx, state.enabled, state.presetId, gains);
    };
    root.querySelector('#eq-reset').onclick = async () => {
      if (ctx.ownerId) {
        // Per-track/playlist "reset" = fall back to global default rather than a separate concept.
        await Bridge.call('equalizer.useGlobalDefault', { ownerId: ctx.ownerId, ownerType: ctx.ownerType });
      } else {
        await Bridge.call('equalizer.reset');
      }
      load(root, ctx, embedded);
    };
    root.querySelector('#eq-save').onclick = async () => {
      await Bridge.call('equalizer.saveAndApply', {
        ownerId: ctx.ownerId || '', ownerType: ctx.ownerType || '',
        enabled: state.enabled, presetId: state.presetId || '', gainsDb: gains,
      });
      if (!embedded) closeIndexedPage('equalizer');
    };
    const useGlobalBtn = root.querySelector('#eq-use-global');
    if (useGlobalBtn) useGlobalBtn.onclick = async () => {
      await Bridge.call('equalizer.useGlobalDefault', { ownerId: ctx.ownerId, ownerType: ctx.ownerType });
      if (!embedded) closeIndexedPage('equalizer'); else load(root, ctx, embedded);
    };
    root.querySelectorAll('[data-preset]').forEach((btn) => {
      btn.onclick = async () => {
        state.presetId = btn.dataset.preset;
        // Ask native to resolve this preset's actual gain values at our 5 fixed frequencies so
        // the graph reflects it, rather than duplicating EqualizerPresets.kt's curves in JS.
        const resolved = await Bridge.call('equalizer.getConfig', { ownerId: ctx.ownerId || '', ownerType: ctx.ownerType || '', previewPresetId: state.presetId });
        draw(root, ctx, embedded, { ...state, gainsDb: resolved.gainsDb || gains }, presets);
        pushLive(ctx, state.enabled, state.presetId, resolved.gainsDb || gains);
      };
    });

    const { xFracFor } = drawGraph(root.querySelector('#eq-graph'), ctx, state, gains, () => {
      state.presetId = null; // any manual drag detaches from a named preset
      root.querySelectorAll('[data-preset]').forEach((b) => b.classList.remove('is-selected'));
      pushLive(ctx, state.enabled, null, gains);
    });

    // Positioned via the exact same log-frequency X mapping the dots themselves use (including
    // the same edge padding), instead of an evenly-split flexbox row — band centers are NOT
    // evenly spaced on a log scale, so a naive even split put these labels visibly out of line
    // with the dots they're meant to caption.
    const labelsHost = root.querySelector('#eq-freq-labels');
    labelsHost.innerHTML = freqLabels.map((f, i) => `<span style="position:absolute; top:0; left:${(xFracFor(i) * 100).toFixed(2)}%; transform:translateX(-50%);">${f}</span>`).join('');
  }

  // Band center frequencies this graph is fixed to — same 5 values EqualizerPresets.kt/
  // CUSTOM_CURVE_FREQS_HZ use. Ported structure-for-structure (including color, --eq-accent in
  // tokens.css) from the older Compose-era reference app's own editable EQ curve
  // (app-embyr-atlas/v-1.1/.../settings.js buildEqCurveGraph + screens.css's .eq-curve-* rules)
  // — SVG instead of canvas, log-scaled frequency on the X axis, a dashed 0dB line, a live
  // filled backdrop under the curve, and dark-ringed draggable points — rather than the ad-hoc
  // canvas version this replaced, which is what was reading as visually rough.
  const BAND_FREQS_HZ = [60, 250, 1000, 4000, 12000];
  const GRAPH_W = 320;

  function svgEl(tag, attrs) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const k in attrs || {}) el.setAttribute(k, attrs[k]);
    return el;
  }

  // Catmull-Rom -> cubic Bezier smooth path through an ordered list of {x,y} points — the
  // standard 1/6-tangent conversion, passes exactly through every point (each draggable dot's
  // real position) rather than approximating them.
  function smoothPathD(points) {
    if (points.length === 0) return '';
    if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
    let d = `M ${points[0].x} ${points[0].y}`;
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i === 0 ? 0 : i - 1];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[i + 2 < points.length ? i + 2 : i + 1];
      const c1x = p1.x + (p2.x - p0.x) / 6;
      const c1y = p1.y + (p2.y - p0.y) / 6;
      const c2x = p2.x - (p3.x - p1.x) / 6;
      const c2y = p2.y - (p3.y - p1.y) / 6;
      d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`;
    }
    return d;
  }

  function drawGraph(container, ctx, state, gains, onDrag) {
    const h = GRAPH_HEIGHT;
    const w = GRAPH_W;
    // Edge padding on every side — without it, a dot/curve at the very first or last band (or
    // at the +/-15dB extremes) sits exactly ON the viewBox edge, and since SVG clips content to
    // its viewBox by default, half the dot/stroke was getting cut off there. This is what read
    // as "the whole bar getting cropped within a box."
    const PAD = 10;

    // Log-scaled X (bass bands spread out, treble bands compress) — matches how a real
    // parametric-EQ graph reads, rather than evenly-spaced-by-index.
    const logFreqs = BAND_FREQS_HZ.map((f) => Math.log(f));
    const logMin = Math.min(...logFreqs), logMax = Math.max(...logFreqs);
    const logSpan = Math.max(logMax - logMin, 0.0001);
    const xFor = (i) => PAD + ((logFreqs[i] - logMin) / logSpan) * (w - PAD * 2);
    const yFor = (db) => PAD + (h - PAD * 2) / 2 - (db / RANGE_DB) * ((h - PAD * 2) / 2);
    // 0..1 fraction of the graph's rendered width — includes the same PAD every dot is inset
    // by, so a label positioned at xFracFor(i)*100% of the container lines up exactly under
    // that dot, not just under its un-padded log-frequency position.
    const xFracFor = (i) => xFor(i) / w;

    container.innerHTML = '';
    const svg = svgEl('svg', {
      viewBox: `0 0 ${w} ${h}`, width: w, height: h,
      preserveAspectRatio: 'xMidYMid meet', class: 'eq-curve-graph',
    });
    container.appendChild(svg);

    const zeroY = yFor(0);
    svg.appendChild(svgEl('line', { x1: 0, y1: zeroY, x2: w, y2: zeroY, class: 'eq-curve-zero-line' }));

    const curveAreaPath = svgEl('path', { class: 'eq-curve-area', d: '' });
    svg.appendChild(curveAreaPath);
    const curvePath = svgEl('path', { class: 'eq-curve-line' });
    svg.appendChild(curvePath);

    const points = gains.map((db, i) => ({ x: xFor(i), y: yFor(db) }));

    function redrawCurve() {
      const d = smoothPathD(points);
      curvePath.setAttribute('d', d);
      // Same smooth line, closed down to the 0dB line and back along it — a filled band-shaped
      // area that bulges above/below the zero line exactly where the live curve does.
      curveAreaPath.setAttribute('d', `${d} L ${points[points.length - 1].x} ${zeroY} L ${points[0].x} ${zeroY} Z`);
    }
    redrawCurve();

    points.forEach((p, i) => {
      const handle = svgEl('circle', { cx: p.x, cy: p.y, r: 6, class: 'eq-curve-point' });
      svg.appendChild(handle);

      let dragging = false;
      const onMove = (clientY) => {
        const rect = svg.getBoundingClientRect();
        const svgY = ((clientY - rect.top) / rect.height) * h;
        const y = Math.min(Math.max(svgY, 0), h);
        const db = Math.round(((h / 2 - y) / (h / 2)) * RANGE_DB * 10) / 10;
        gains[i] = db;
        p.y = yFor(db);
        handle.setAttribute('cy', p.y);
        redrawCurve();
        onDrag();
      };
      handle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        dragging = true;
        handle.setPointerCapture(e.pointerId);
        handle.classList.add('is-dragging');
      });
      handle.addEventListener('pointermove', (e) => { if (dragging) onMove(e.clientY); });
      const stop = () => { dragging = false; handle.classList.remove('is-dragging'); };
      handle.addEventListener('pointerup', stop);
      handle.addEventListener('pointercancel', stop);
    });

    return { xFracFor };
  }

  function pushLive(ctx, enabled, presetId, gains) {
    Bridge.call('equalizer.setLive', {
      ownerId: ctx.ownerId || '', ownerType: ctx.ownerType || '',
      enabled, presetId: presetId || '', gainsDb: gains,
    });
  }

  return { render };
})();

const EqualizerScreen = (() => {
  function open(ownerId, ownerType, title) {
    const ctx = { ownerId, ownerType, title };
    openIndexedPage('equalizer', (root) => EqualizerCore.render(root, ctx, false));
  }
  return { open };
})();

const EmbeddedEqualizer = (() => {
  function mount(root) {
    if (!root) return;
    EqualizerCore.render(root, { ownerId: null, ownerType: null, title: 'Equalizer' }, true);
  }
  return { mount };
})();
