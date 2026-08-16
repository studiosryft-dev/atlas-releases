/** Minimal reactive store — plain object + subscriber set, no framework needed for this size of app. */
class Store {
  constructor(initial) {
    this.state = initial;
    this.listeners = new Set();
  }
  get(key) { return this.state[key]; }
  set(patch) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((fn) => fn(this.state));
  }
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

const AppStore = new Store({
  authed: false,
  account: null,
  library: [],
  playlists: [],
  notifications: [],
  playbackState: { isPlaying: false, title: null, artist: null },
  queueState: { queue: [], history: [], currentIndex: -1 },
  settings: { wifiOnly: false, audioQuality: 'HIGH', themeMode: 'DARK', colorway: 'pulse' },
});
