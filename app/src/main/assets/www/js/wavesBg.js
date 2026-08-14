/** Layered wave gradient background — replaces the old blob/sweep/twinkle system with soft
 *  animated wave bands, colored from the active colorway (--bg-1/--bg-2/--bg-3/--bg-base, the
 *  exact same custom properties Settings' colorway picker already drives — see
 *  backgrounds.css). The main instance mounts into #bg-root (behind the whole shell); every
 *  indexed page except Now Playing/Lyrics (which paint their own blurred-album-art background
 *  instead) mounts its own independent instance via mountInstance() — see app.js's
 *  openIndexedPage. Each indexed page owning a real opaque background of its own, rather than
 *  staying transparent so the shared #bg-root showed through, is what actually fixed indexed
 *  pages letting whatever's behind them (native page content, header, nav, mini player) bleed
 *  through — a transparent page has no way to know what else happens to be behind it at the
 *  shell level; an opaque one just doesn't need to.
 *
 *  Ported from a reference design (20 layers, per-layer blur filter + a duplicate shadow path
 *  per layer, i.e. ~40 filtered SVG elements animating every frame) but deliberately lightened
 *  for a mobile WebView running several of these behind different screens over an app session:
 *  fewer layers, no per-layer blur filter, no shadow duplicate. Still reads as the same "soft
 *  layered waves, slow independent drift" design. */
const WavesBackground = (() => {
  const svgNS = 'http://www.w3.org/2000/svg';
  const W = 800, H = 1600;
  const LAYER_COUNT = 7;
  const SEGMENTS = 5;
  const PALETTE_SETTLE_MS = 1150; // matches backgrounds.css's --bg-* custom-property transition

  // Every mounted instance (the main #bg-root one plus one per open-at-least-once indexed page)
  // — colorway/appearance changes retint all of them together, and the global enable/speed
  // controls (Settings > Appearance) apply to all of them too, not just the main one.
  const instances = [];
  let globalAnimationEnabled = true;
  let globalSpeedMultiplier = 1;

  function seededRandom(seed) {
    let s = seed % 2147483647;
    if (s <= 0) s += 2147483646;
    return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
  }

  function parseColor(str) {
    str = (str || '').trim();
    if (!str) return null;
    if (str[0] === '#') {
      const hex = str.length === 4 ? str.slice(1).split('').map((c) => c + c).join('') : str.slice(1);
      const num = parseInt(hex, 16);
      if (Number.isNaN(num)) return null;
      return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
    }
    const m = str.match(/rgba?\(([^)]+)\)/);
    if (m) {
      const parts = m[1].split(',').map((s) => parseFloat(s));
      return [parts[0], parts[1], parts[2]];
    }
    return null;
  }

  function mix(hexA, hexB, t) {
    const a = parseColor(hexA), b = parseColor(hexB);
    if (!a || !b) return hexA || hexB || '#3346d6';
    const r = Math.round(a[0] + (b[0] - a[0]) * t);
    const g = Math.round(a[1] + (b[1] - a[1]) * t);
    const bl = Math.round(a[2] + (b[2] - a[2]) * t);
    return `rgb(${r}, ${g}, ${bl})`;
  }

  function buildPalette() {
    const cs = getComputedStyle(document.documentElement);
    const c1 = cs.getPropertyValue('--bg-1').trim() || '#8b5cf6';
    const c2 = cs.getPropertyValue('--bg-2').trim() || '#6600ff';
    const c3 = cs.getPropertyValue('--bg-3').trim() || '#ff00c8';
    const base = cs.getPropertyValue('--bg-base').trim() || '#0a1440';
    // Top layer starts near the colorway's brightest tone, bottom layers settle toward its own
    // deep base — same top-bright/bottom-deep structure the reference design used, interpolated
    // from this app's actual active colorway instead of a fixed hardcoded array.
    const stops = [c1, c2, c3, base];
    const palette = [];
    for (let i = 0; i < LAYER_COUNT; i++) {
      const t = i / (LAYER_COUNT - 1);
      const segF = t * (stops.length - 1);
      const idx = Math.min(stops.length - 2, Math.floor(segF));
      palette.push(mix(stops[idx], stops[idx + 1], segF - idx));
    }
    return palette;
  }

  function buildPathD(points) {
    let d = `M 0 ${H} L 0 ${points[0]._y.toFixed(1)} `;
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i], p1 = points[i + 1];
      const midX = (p0.x + p1.x) / 2;
      d += `C ${midX.toFixed(1)} ${p0._y.toFixed(1)}, ${midX.toFixed(1)} ${p1._y.toFixed(1)}, ${p1.x.toFixed(1)} ${p1._y.toFixed(1)} `;
    }
    d += `L ${W} ${H} Z`;
    return d;
  }

  function buildInstance(host) {
    // preserveAspectRatio="none" (stretch to fill exactly) rather than "slice" — "slice" only
    // guarantees full COVERAGE when the container's aspect ratio is close to the viewBox's; on
    // an aspect ratio far enough off (this viewBox is a fixed 800x1600 portrait shape) it can
    // leave the wave field cropped down to a band that doesn't actually reach every edge of the
    // host — none guarantees the SVG always fills its box completely.
    host.innerHTML = `<svg class="wave-bg-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"></svg><div class="bg-vignette"></div>`;
    const svg = host.querySelector('.wave-bg-svg');

    const palette = buildPalette();
    const topMargin = H * 0.06;
    const usable = H - topMargin;
    const layers = [];

    for (let i = 0; i < LAYER_COUNT; i++) {
      const t = i / (LAYER_COUNT - 1);
      const baseY = topMargin + usable * Math.pow(t, 1.1);
      const amplitude = H * 0.07 + H * 0.05 * Math.sin(t * Math.PI);
      const rnd = seededRandom(i * 7 + 3);
      const points = [];
      for (let s = 0; s <= SEGMENTS; s++) {
        const x = (W / SEGMENTS) * s;
        const phase = rnd();
        const staticY = baseY - amplitude * (0.4 + 0.6 * Math.sin(phase * Math.PI * 2 + i)) * (0.5 + rnd() * 0.5);
        points.push({
          x, staticY,
          wobbleAmp: H * 0.018 + rnd() * H * 0.02,
          phaseA: rnd() * Math.PI * 2,
          phaseB: rnd() * Math.PI * 2,
        });
      }
      points[0].x = 0;
      points[points.length - 1].x = W;

      const path = document.createElementNS(svgNS, 'path');
      // Set as an inline style property, not an attribute — only style-property changes respect
      // the CSS transition on .wave-bg-svg path's fill (see backgrounds.css), which is what lets
      // a colorway switch crossfade the wave colors instead of snapping to the new palette.
      path.style.fill = palette[i];
      path.setAttribute('opacity', (0.32 + t * 0.34).toFixed(2));
      svg.appendChild(path);

      layers.push({
        points, path, speed: 0.12 + rnd() * 0.12,
        driftAmp: W * (0.01 + rnd() * 0.02),
        driftSpeed: 0.05 + rnd() * 0.07,
        driftPhase: rnd() * Math.PI * 2,
      });
    }

    return { host, svg, layers, virtualTimeMs: 0, lastRealTimeMs: null, rafHandle: null };
  }

  let perfMode = false;

  function tick(inst, realTime) {
    // Phone Heat Optimization — skip every other frame (redraw at ~half rate) instead of
    // computing/painting all 7 layers' wave paths every single rAF tick. The virtual clock still
    // advances by the real elapsed time either way, so the motion doesn't speed up or stutter in
    // a way that reads as broken — it just updates less often.
    if (perfMode && inst.skipFrame) {
      inst.skipFrame = false;
      inst.rafHandle = requestAnimationFrame((rt) => tick(inst, rt));
      return;
    }
    inst.skipFrame = true;
    if (inst.lastRealTimeMs == null) inst.lastRealTimeMs = realTime;
    const dt = realTime - inst.lastRealTimeMs;
    inst.lastRealTimeMs = realTime;
    inst.virtualTimeMs += dt * globalSpeedMultiplier;
    const t = inst.virtualTimeMs * 0.001;
    inst.layers.forEach((layer) => {
      layer.points.forEach((p) => {
        const wobble = p.wobbleAmp * (
          0.7 * Math.sin(t * layer.speed + p.phaseA) +
          0.3 * Math.sin(t * layer.speed * 1.8 + p.phaseB)
        );
        p._y = p.staticY + wobble;
      });
      layer.path.setAttribute('d', buildPathD(layer.points));
      const driftX = layer.driftAmp * Math.sin(t * layer.driftSpeed + layer.driftPhase);
      layer.path.style.transform = `translateX(${driftX.toFixed(1)}px)`;
    });
    inst.rafHandle = requestAnimationFrame((rt) => tick(inst, rt));
  }

  function resumeInstance(inst) {
    if (inst.rafHandle) return;
    inst.lastRealTimeMs = null; // resume cleanly instead of one huge dt jump
    inst.rafHandle = requestAnimationFrame((rt) => tick(inst, rt));
  }

  function pauseInstance(inst) {
    if (!inst.rafHandle) return;
    cancelAnimationFrame(inst.rafHandle);
    inst.rafHandle = null;
  }

  /** Settings > Appearance's "Animate background" toggle — applies to every mounted instance. */
  function setEnabled(on) {
    globalAnimationEnabled = !!on;
    instances.forEach((inst) => (globalAnimationEnabled ? resumeInstance(inst) : pauseInstance(inst)));
  }

  /** Settings > Appearance's speed slider — a multiplier on top of each layer's own base speed
   *  (not a replacement), applied to every mounted instance at once. */
  function setSpeed(multiplier) {
    globalSpeedMultiplier = Math.max(0, multiplier);
  }

  /** Settings > Phone Heat Optimization — halves how often every mounted instance actually
   *  redraws (see tick()'s frame-skip above). */
  function setPerfMode(on) {
    perfMode = !!on;
  }

  function retintAll() {
    const palette = buildPalette();
    instances.forEach((inst) => inst.layers.forEach((layer, i) => { layer.path.style.fill = palette[i]; }));
  }

  /** Mounts a new, independent wave instance into any container (an indexed page's own
   *  `.indexed-page__bg` div, typically) — same colorway, same global enable/speed state, own
   *  independent layer phases so it doesn't look like a literal clone of the main background.
   *  Indexed pages mount once (their DOM node is cached/reused across opens, see app.js) and
   *  keep animating for as long as that node exists, matching how cheap this already is for the
   *  single main instance. */
  function mountInstance(host) {
    if (!host) return null;
    const inst = buildInstance(host);
    instances.push(inst);
    if (globalAnimationEnabled) resumeInstance(inst);
    return inst;
  }

  function start() {
    const host = document.getElementById('bg-root');
    if (!host || instances.some((i) => i.host === host)) return;
    mountInstance(host);

    // Re-tint (not rebuild) whenever colorway/appearance changes — waited out to roughly match
    // backgrounds.css's own --bg-* transition duration so the wave colors land right as that
    // crossfade settles, rather than snapping to the new palette while it's still mid-fade.
    let settleTimer = null;
    const observer = new MutationObserver(() => {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(retintAll, PALETTE_SETTLE_MS);
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-colorway', 'data-appearance'] });
  }

  return { start, setEnabled, setSpeed, setPerfMode, mountInstance };
})();

WavesBackground.start();
