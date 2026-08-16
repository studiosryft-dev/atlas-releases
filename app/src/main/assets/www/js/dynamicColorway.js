/** "Dynamic" colorway (Settings > Appearance) — instead of a fixed [data-colorway] palette
 *  (backgrounds.css), the background tints itself to whatever's currently playing, derived from
 *  the track's own artwork via AlbumColor.extractPalette. Applied as inline custom properties on
 *  <html> (not the data-colorway attribute — that still stays on a real colorway underneath as a
 *  fallback for whenever nothing's playing / no artwork), so the same --bg-base/--bg-1/--bg-2/
 *  --bg-3 transition every other colorway switch already uses (backgrounds.css) crossfades this
 *  too, no separate animation system needed. Skips re-applying (and thus re-fading) when the new
 *  track's artwork is literally the same file as the last one, per spec — same cover, no fade. */
const DynamicColorway = (() => {
  let enabled = false;
  let lastUrl = undefined; // undefined = "never checked yet", distinct from null = "no artwork"

  function clearOverrides() {
    const s = document.documentElement.style;
    ['--bg-base', '--bg-1', '--bg-2', '--bg-3'].forEach((v) => s.removeProperty(v));
  }

  function applyForState(state) {
    if (!enabled) return;
    const url = state?.artworkPath ? artworkUrl(state.artworkPath) : null;
    if (url === lastUrl) return;
    lastUrl = url;
    if (!url) return; // nothing playing / no art yet — leave whatever's currently applied showing
    AlbumColor.extractPalette(url).then((palette) => {
      if (url !== lastUrl) return; // track changed again before this resolved
      if (!palette) {
        // Extraction failed — most commonly the artwork file not existing on disk yet the
        // instant a freshly-downloaded track starts playing (native pushes playback.state before
        // that write is guaranteed to have landed). lastUrl was already committed to this url
        // above (needed for the dedup/race guard while extraction was in flight), so without
        // this the `url !== lastUrl` guard would permanently no-op every future push for this
        // exact track, even after the artwork genuinely becomes available a moment later —
        // that's the actual "dynamic coloring gets out of sync" bug. Resetting it here means the
        // very next playback.state push for this track (native pushes on more than just track
        // changes) gets a real retry instead of silently giving up forever.
        lastUrl = undefined;
        return;
      }
      const s = document.documentElement.style;
      s.setProperty('--bg-base', palette.base);
      s.setProperty('--bg-1', palette.c1);
      s.setProperty('--bg-2', palette.c2);
      s.setProperty('--bg-3', palette.c3);
      WavesBackground.retint();
    });
  }

  function setEnabled(on) {
    enabled = !!on;
    if (!enabled) {
      clearOverrides();
      WavesBackground.retint();
      return;
    }
    lastUrl = undefined;
    applyForState(AppStore.get('playbackState'));
  }

  Bridge.on('playback.state', (s) => applyForState(s));

  return { setEnabled };
})();
