/**
 * Native-tab router: swaps whole-page content inside #page-viewport with a directional slide.
 * A prior version added a multi-sample motion-blur ghost trail on the outgoing page (several
 * cloned/blurred copies animating behind it) — removed entirely per explicit feedback: it caused
 * real lag (5 cloned DOM subtrees animating simultaneously per transition) and didn't read as
 * intended visually. Plain slide only, no clones.
 */
const Router = (() => {
  const viewport = document.getElementById('page-viewport');
  const pages = {}; // name -> render fn
  let current = null;
  let currentEl = null;

  const TRANSITION_MS = 320;

  function register(name, renderFn) {
    pages[name] = renderFn;
  }

  function show(name, opts = {}) {
    const renderFn = pages[name];
    if (!renderFn || name === current) return;

    const direction = opts.direction || 1; // 1 = slide in from right, -1 = from left
    const outgoingEl = currentEl;

    const nextEl = document.createElement('div');
    nextEl.className = 'page-slide';
    nextEl.style.cssText = `position:absolute; inset:0; transform: translateX(${direction * 100}%);`;
    viewport.appendChild(nextEl);
    renderFn(nextEl);

    requestAnimationFrame(() => {
      nextEl.style.transition = `transform ${TRANSITION_MS}ms cubic-bezier(0.22,1,0.36,1)`;
      nextEl.style.transform = 'translateX(0)';
      if (outgoingEl) {
        outgoingEl.style.transition = `transform ${TRANSITION_MS}ms cubic-bezier(0.22,1,0.36,1), opacity ${TRANSITION_MS}ms`;
        outgoingEl.style.transform = `translateX(${-direction * 60}%)`;
        outgoingEl.style.opacity = '0';
      }
    });

    setTimeout(() => {
      outgoingEl?.remove();
    }, TRANSITION_MS + 30);

    current = name;
    currentEl = nextEl;
    document.dispatchEvent(new CustomEvent('atlas:page-changed', { detail: { page: name } }));
  }

  return { register, show, get current() { return current; } };
})();
