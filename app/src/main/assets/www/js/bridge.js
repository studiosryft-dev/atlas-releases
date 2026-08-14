/**
 * Promise wrapper around the native `AtlasNative.invoke(action, argsJson, callId)` bridge.
 * Native resolves/rejects via window.__atlasResolve/__atlasReject with the result already
 * JSON-stringified (see WebAppBridge.kt's `resolve`/`reject`) — parsed back into an object here
 * so callers just get a plain value.
 */
const Bridge = (() => {
  let nextCallId = 1;
  const pending = new Map();

  window.__atlasResolve = (callId, resultJsonString) => {
    const entry = pending.get(callId);
    if (!entry) return;
    pending.delete(callId);
    try {
      entry.resolve(resultJsonString == null ? null : JSON.parse(resultJsonString));
    } catch (e) {
      entry.reject(e);
    }
  };

  window.__atlasReject = (callId, message) => {
    const entry = pending.get(callId);
    if (!entry) return;
    pending.delete(callId);
    entry.reject(new Error(message));
  };

  const pushListeners = new Map(); // event -> Set<fn>
  window.__atlasPush = (event, dataJsonString) => {
    const listeners = pushListeners.get(event);
    if (!listeners) return;
    let data = null;
    try { data = dataJsonString == null ? null : JSON.parse(dataJsonString); } catch (e) { console.error('bad push payload', e); return; }
    listeners.forEach((fn) => fn(data));
  };

  function call(action, args) {
    return new Promise((resolve, reject) => {
      const callId = String(nextCallId++);
      pending.set(callId, { resolve, reject });
      try {
        window.AtlasNative.invoke(action, JSON.stringify(args || {}), callId);
      } catch (e) {
        pending.delete(callId);
        reject(e);
      }
    });
  }

  function on(event, fn) {
    if (!pushListeners.has(event)) pushListeners.set(event, new Set());
    pushListeners.get(event).add(fn);
    return () => pushListeners.get(event)?.delete(fn);
  }

  return { call, on };
})();

/**
 * Local artwork (filesDir/artwork/<file>) is served over the WebView's own https origin at
 * /artwork/<file> — WebView has allowFileAccess=false (deliberately, see MainActivity.kt), so
 * `file://` <img src> never loads and just shows the broken-image icon. This maps a raw native
 * filesystem path (whatever TrackEntity.artworkPath holds) to the URL that actually works.
 */
function artworkUrl(path) {
  if (!path) return null;
  const filename = path.split('/').pop();
  return `https://appassets.androidplatform.net/artwork/${filename}`;
}
