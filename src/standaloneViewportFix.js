// iOS home-screen (standalone) PWAs sometimes LAUNCH with a browser-sized
// layout viewport: WebKit lays the web view out as if Safari's chrome existed,
// so `window.innerHeight` / `100dvh` / `env(safe-area-inset-bottom)` all come
// up short by the chrome band (~70–110px), and NOTHING recomputes until the
// first scroll gesture. The visible symptom is a full-screen splash stopping
// above the bottom edge and a fixed bottom nav floating mid-screen until the
// user swipes once — at which point everything snaps down and stays. Widely
// reported on iOS 26 (with variants back to iOS 17); an OS regression, not an
// app one: CSS built on dvh is correct — the VIEWPORT is wrong.
//
// The workaround is to force the recompute ourselves instead of waiting for
// the swipe. Detection: in standalone mode with a full-cover viewport
// (`apple-mobile-web-app-status-bar-style: black-translucent` +
// `viewport-fit=cover`) the layout viewport must equal the screen height, so
// any real shortfall means the stuck state. Correction: a 1px scroll nudge
// (a no-op on an unscrollable page, so also) a display:none→restore reflow on
// <html> — both within one task, so nothing paints in between and neither is
// visible. Retries are BOUNDED: in an iPad split-view / Stage Manager window
// the viewport is legitimately smaller than the screen, so after a few quiet
// attempts we conclude "not the bug" and stop.

export const DEFAULT_MAX_ATTEMPTS = 6
export const DEFAULT_RETRY_STEP_MS = 150
// The real shortfall is a whole chrome band; tolerance only absorbs rounding.
export const DEFAULT_SHORTFALL_TOLERANCE_PX = 2

// Every browser global is read lazily (never at module top level), so the
// module can be imported under SSR or a Node test runner.

/** Running as an installed, standalone PWA (any engine; `navigator.standalone` is iOS). */
export function isStandaloneDisplay() {
  if (typeof window === 'undefined') return false
  return window.matchMedia?.('(display-mode: standalone)')?.matches === true
    || window.navigator?.standalone === true
}

/** iPhone, iPod or iPad — including iPadOS, which reports a macOS user agent. */
export function isIosDevice() {
  const nav = typeof navigator !== 'undefined' ? navigator : null
  if (!nav) return false
  // iPadOS 13+ reports a macOS user agent; the touch-point check separates a
  // real Mac (0) from an iPad wearing its clothes (5).
  return /iphone|ipad|ipod/i.test(nav.userAgent || '')
    || (nav.platform === 'MacIntel' && (nav.maxTouchPoints || 0) > 1)
}

/**
 * What the layout viewport SHOULD measure in standalone full-cover mode: the
 * screen edge-to-edge. iOS keeps screen.width/height orientation-fixed while
 * other engines swap them, so derive from long/short side + live orientation
 * instead of trusting either convention. 0 when unknown.
 */
export function expectedViewportHeight() {
  if (typeof window === 'undefined') return 0
  const s = window.screen
  if (!s?.height) return 0
  const long = Math.max(s.width || 0, s.height || 0)
  const short = Math.min(s.width || 0, s.height || 0)
  const portrait = window.matchMedia?.('(orientation: portrait)')?.matches !== false
  return portrait ? long : short
}

function viewportIsShort(tolerancePx) {
  const expected = expectedViewportHeight()
  return expected > 0 && (window.innerHeight || 0) < expected - tolerancePx
}

/**
 * The correction itself: a 1px scroll nudge plus a synchronous reflow of the
 * root, both in one task. Exported for manual use; `armStandaloneViewportFix`
 * calls it only when the viewport is detected as short.
 */
export function forceViewportRecompute() {
  const root = document.documentElement
  // The classic nudge: any programmatic scroll can wake the recompute. Restore
  // immediately. A layout that scrolls inside a container of its own (say, a
  // sidebar shell with an inner scrolling main pane) leaves the document nothing
  // to scroll, so a bare nudge does nothing there and the short viewport stays
  // — a band of empty page under the layout — until the user scrolls a list.
  // For the length of the nudge the document is given one pixel to scroll, and
  // it is taken back in the same task: nothing is painted.
  const x = window.scrollX || 0
  const y = window.scrollY || 0
  const cannotScroll = (root.scrollHeight || 0) <= (window.innerHeight || 0)
  const minHeight = root.style.minHeight
  if (cannotScroll) root.style.minHeight = 'calc(100% + 1px)'
  window.scrollTo(x, y + 1)
  window.scrollTo(x, y)
  if (cannotScroll) root.style.minHeight = minHeight
  // The reliable half: detach and re-attach the root's layout in one task.
  // `void offsetHeight` forces the synchronous reflow between the two writes;
  // no frame is painted with display:none, so the toggle is invisible.
  const prev = root.style.display
  root.style.display = 'none'
  void root.offsetHeight
  root.style.display = prev
}

/**
 * Arm once at boot, as early as possible, so the fix runs while a static splash
 * is still up — the bug is visible on the splash too. Re-kicks when the app
 * returns to the foreground: a resumed PWA can come back with the same stuck
 * viewport it launched with.
 *
 * Does nothing outside an iOS standalone PWA. Returns a function that removes
 * the listeners and stops pending retries.
 *
 * @param {object}   [options]
 * @param {number}   [options.maxAttempts]  give up after this many recomputes per kick
 * @param {number}   [options.retryStepMs]  backoff step: attempt n waits n × step
 * @param {number}   [options.tolerancePx]  shortfall below this is treated as rounding
 * @param {Function} [options.onAttempt]    ({ attempt, innerHeight, expectedHeight }) => void
 */
export function armStandaloneViewportFix(options = {}) {
  const noop = () => {}
  if (typeof window === 'undefined' || typeof document === 'undefined') return noop
  if (!isStandaloneDisplay() || !isIosDevice()) return noop

  const {
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    retryStepMs = DEFAULT_RETRY_STEP_MS,
    tolerancePx = DEFAULT_SHORTFALL_TOLERANCE_PX,
    onAttempt,
  } = options

  const raf = typeof window.requestAnimationFrame === 'function'
    ? window.requestAnimationFrame.bind(window)
    : (cb) => setTimeout(cb, 16)

  let attempt = 0
  let pending = false
  let disarmed = false
  let timer = null

  function run() {
    timer = null
    if (disarmed) return
    if (!viewportIsShort(tolerancePx)) { pending = false; attempt = 0; return }
    if (attempt >= maxAttempts) { pending = false; return }
    attempt += 1
    onAttempt?.({ attempt, innerHeight: window.innerHeight, expectedHeight: expectedViewportHeight() })
    forceViewportRecompute()
    // Growing backoff: WebKit applies the recompute asynchronously, so give
    // each attempt a beat to land before concluding it did not.
    timer = setTimeout(run, retryStepMs * attempt)
  }

  function kick() {
    if (pending || disarmed) return
    pending = true
    attempt = 0
    // Double-rAF: past the first paint, where a forced recompute actually
    // sticks — nudging before layout settles just gets overwritten.
    raf(() => raf(run))
  }

  const onVisibility = () => {
    if (document.visibilityState === 'visible') kick()
  }
  const onPageShow = (event) => {
    if (event.persisted) kick()
  }

  kick()
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pageshow', onPageShow)

  return function disarm() {
    disarmed = true
    if (timer) clearTimeout(timer)
    document.removeEventListener?.('visibilitychange', onVisibility)
    window.removeEventListener?.('pageshow', onPageShow)
  }
}
