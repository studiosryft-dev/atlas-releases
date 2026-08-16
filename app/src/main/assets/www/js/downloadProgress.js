/** Live download progress panel in the global header (native pages only — it's part of
 *  #global-header, which indexed pages simply sit above). Crossfades in over the Discover/Queue
 *  nav tiles in the exact same slot (see .header-stats-slot, layout.css) whenever the download
 *  queue has active work, and back out once it's idle.
 *
 *  "Batch" tracking: downloadQueueDao.observeQueue() pushes the FULL download_queue table on
 *  every row change, including old COMPLETED rows nothing ever purges — so naively counting
 *  "done / total" over the whole push would count every download this install has ever done, not
 *  just the current playlist/multi-select. Instead, batchIds only ever grows by watching which
 *  ids are actively QUEUED/RESOLVING/DOWNLOADING on each push, so it only ever contains items
 *  that were part of *this* run of activity — ancient completed rows never entered it. Once
 *  nothing is active anymore, the finished state holds on screen briefly (so a 1-track download
 *  doesn't just vanish the instant it finishes) before crossfading back out and resetting. */
const DownloadProgress = (() => {
  const ACTIVE_STATUSES = new Set(['QUEUED', 'RESOLVING', 'DOWNLOADING']);
  const HOLD_MS = 1100;

  let batchIds = new Set();
  let hideTimer = null;
  let visible = false;

  function els() {
    return {
      stats: document.getElementById('header-stats'),
      panel: document.getElementById('header-dl-progress'),
      title: document.getElementById('hdp-title'),
      pct: document.getElementById('hdp-pct'),
      fill: document.getElementById('hdp-bar-fill'),
      countWrap: document.getElementById('hdp-count-wrap'),
      count: document.getElementById('hdp-count'),
    };
  }

  function show() {
    if (visible) return;
    visible = true;
    const { stats, panel } = els();
    if (!panel) return;
    stats.classList.remove('is-active');
    panel.classList.add('is-active');
  }

  function hide() {
    if (!visible) return;
    visible = false;
    const { stats, panel } = els();
    if (!panel) return;
    panel.classList.remove('is-active');
    stats.classList.add('is-active');
  }

  function render(batchItems, activeItems) {
    const { title, pct, fill, countWrap, count } = els();
    if (!title) return;

    const total = batchItems.length;
    const doneCount = batchItems.filter((i) => i.status === 'COMPLETED' || i.status === 'FAILED').length;
    const finishing = activeItems.length === 0;
    const current = activeItems.find((i) => i.status === 'DOWNLOADING') || activeItems[0];

    let name;
    let percent;
    if (finishing) {
      name = 'Finishing up…';
      percent = 100;
    } else if (current.status === 'DOWNLOADING') {
      name = current.resolvedTitle || 'Downloading…';
      percent = current.progressPercent;
    } else {
      name = current.resolvedTitle || 'Resolving…';
      percent = 0;
    }

    title.textContent = `Downloading: ${name}`;
    pct.textContent = `${percent}%`;
    fill.style.width = `${percent}%`;

    const showCount = total > 1;
    countWrap.classList.toggle('is-open', showCount);
    if (showCount) count.textContent = `Downloaded: ${doneCount}/${total}`;
  }

  function update(items) {
    const active = items.filter((i) => ACTIVE_STATUSES.has(i.status));

    if (active.length > 0) {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      active.forEach((i) => batchIds.add(i.id));
    } else if (batchIds.size === 0) {
      return; // idle, nothing to wind down
    }

    const batchItems = items.filter((i) => batchIds.has(i.id));
    if (!batchItems.length) { hide(); return; }

    render(batchItems, active);
    show();

    if (active.length === 0 && !hideTimer) {
      hideTimer = setTimeout(() => {
        hideTimer = null;
        batchIds = new Set();
        hide();
      }, HOLD_MS);
    }
  }

  Bridge.on('downloadQueue.changed', update);

  return {};
})();
