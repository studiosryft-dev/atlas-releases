/** Extracts a single representative accent color from a track's artwork — the one color-
 *  extraction system Now Playing uses for everything that's supposed to visually match the
 *  current album art (the background tint, the seek bar, the selected repeat-mode button).
 *  Built once and reused rather than three separate ad-hoc implementations.
 *
 *  Technique: draw the artwork into a tiny offscreen canvas (24x24 — plenty of signal for "one
 *  average color", cheap to read back), average every opaque pixel, then push that average into
 *  HSL space and clamp saturation/lightness into a range that always reads as a usable accent
 *  against this app's dark UI (never mud-brown-average-dull, never blown-out white/black).
 *  Artwork is served from this app's own origin (see js/bridge.js's artworkUrl), so the canvas
 *  read-back is never tainted by cross-origin restrictions. */
const AlbumColor = (() => {
  const cache = new Map(); // artwork url -> 'rgb(r, g, b)'
  const paletteCache = new Map(); // artwork url -> { base, c1, c2, c3 }
  // In-flight de-dup — rapid track skipping (or Dynamic colorway re-arming on re-enable) can
  // call extract()/extractPalette() again for a url whose first request hasn't resolved yet;
  // without this each call starts its own fresh Image() decode, and nothing stops them from
  // settling in a different order than they were requested in.
  const inFlight = new Map(); // artwork url -> Promise
  const paletteInFlight = new Map();
  const SAMPLE_SIZE = 24;

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    const d = max - min;
    if (d !== 0) {
      s = d / (1 - Math.abs(2 * l - 1));
      switch (max) {
        case r: h = ((g - b) / d) % 6; break;
        case g: h = (b - r) / d + 2; break;
        default: h = (r - g) / d + 4;
      }
      h *= 60;
      if (h < 0) h += 360;
    }
    return [h, s, l];
  }

  function hslToRgb(h, s, l) {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (h < 60) [r, g, b] = [c, x, 0];
    else if (h < 120) [r, g, b] = [x, c, 0];
    else if (h < 180) [r, g, b] = [0, c, x];
    else if (h < 240) [r, g, b] = [0, x, c];
    else if (h < 300) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
  }

  function boost(r, g, b) {
    const [h, s, l] = rgbToHsl(r, g, b);
    const boostedS = Math.max(s, 0.5);
    const clampedL = Math.min(Math.max(l, 0.42), 0.66);
    const [nr, ng, nb] = hslToRgb(h, boostedS, clampedL);
    return `rgb(${nr}, ${ng}, ${nb})`;
  }

  function extract(url) {
    if (!url) return Promise.resolve(null);
    if (cache.has(url)) return Promise.resolve(cache.get(url));
    if (inFlight.has(url)) return inFlight.get(url);
    const promise = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = SAMPLE_SIZE;
          canvas.height = SAMPLE_SIZE;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
          const data = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data;
          let r = 0, g = 0, b = 0, n = 0;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] < 128) continue;
            r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
          }
          if (!n) { resolve(null); return; }
          const color = boost(Math.round(r / n), Math.round(g / n), Math.round(b / n));
          cache.set(url, color);
          resolve(color);
        } catch (e) {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = url;
    });
    promise.finally(() => inFlight.delete(url));
    inFlight.set(url, promise);
    return promise;
  }

  /** Same average-color sampling as extract(), but returns a full 4-stop background palette
   *  (base/c1/c2/c3, matching backgrounds.css's per-colorway shape) instead of one accent —
   *  what the "Dynamic" colorway (Settings > Appearance) drives --bg-base/--bg-1/--bg-2/--bg-3
   *  from directly. Same hue as the artwork's average color, four lightness steps derived from
   *  it rather than four independently-sampled regions, which is what keeps the result reading
   *  as "one coherent tint" instead of four unrelated colors. */
  function extractPalette(url) {
    if (!url) return Promise.resolve(null);
    if (paletteCache.has(url)) return Promise.resolve(paletteCache.get(url));
    if (paletteInFlight.has(url)) return paletteInFlight.get(url);
    const promise = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = SAMPLE_SIZE;
          canvas.height = SAMPLE_SIZE;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
          const data = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data;
          let r = 0, g = 0, b = 0, n = 0;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] < 128) continue;
            r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
          }
          if (!n) { resolve(null); return; }
          const [h, s, l] = rgbToHsl(Math.round(r / n), Math.round(g / n), Math.round(b / n));
          const sat = Math.max(s, 0.55);
          const mk = (lv) => { const [nr, ng, nb] = hslToRgb(h, sat, lv); return `rgb(${nr}, ${ng}, ${nb})`; };
          const palette = {
            base: mk(0.05),
            c3: mk(0.14),
            c2: mk(0.28),
            c1: mk(Math.min(Math.max(l, 0.42), 0.62)),
          };
          paletteCache.set(url, palette);
          resolve(palette);
        } catch (e) {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = url;
    });
    promise.finally(() => paletteInFlight.delete(url));
    paletteInFlight.set(url, promise);
    return promise;
  }

  return { extract, extractPalette };
})();
