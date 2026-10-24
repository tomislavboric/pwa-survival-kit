import { describe, it, expect, vi, afterEach } from 'vitest'
import { armStandaloneViewportFix, expectedViewportHeight } from '../src/standaloneViewportFix.js'

// iOS standalone launch bug: the PWA opens with a browser-sized (short) layout
// viewport and nothing recomputes until the first swipe. The fix forces the
// recompute at boot — these tests pin its contracts:
//   1. safe under a Node runner (no browser globals touched until armed),
//   2. it retries while the viewport is short and STOPS once it corrects,
//   3. it gives up after bounded attempts (an iPad split-view window is
//      legitimately smaller than the screen — that must not loop forever).

const MAX_ATTEMPTS = 6

function makeStuckEnvironment({ standalone = true, ios = true, scrollHeight = 2000, portrait = true } = {}) {
  const documentElement = { style: { display: '', minHeight: '' }, offsetHeight: 0, scrollHeight }
  const win = {
    matchMedia: (query) => ({
      matches: query.includes('display-mode') ? standalone : portrait,
      addEventListener: () => {},
    }),
    navigator: { standalone: false },
    screen: { width: 393, height: 852 },
    innerHeight: 780, // short by a Safari chrome band — the stuck state
    scrollX: 0,
    scrollY: 0,
    scrollTo: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    // no requestAnimationFrame on purpose — exercises the setTimeout fallback
  }
  const doc = {
    documentElement,
    visibilityState: 'visible',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }
  vi.stubGlobal('window', win)
  vi.stubGlobal('document', doc)
  vi.stubGlobal('navigator', {
    userAgent: ios
      ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15'
      : 'Mozilla/5.0 (Linux; Android 14) Chrome/126',
    platform: ios ? 'iPhone' : 'Linux',
    maxTouchPoints: ios ? 5 : 0,
  })
  return { win, doc }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('standalone viewport fix', () => {
  it('is a no-op outside a browser (Node)', () => {
    expect(() => armStandaloneViewportFix()).not.toThrow()
    expect(typeof armStandaloneViewportFix()).toBe('function')
  })

  it('does nothing when not standalone or not iOS', () => {
    const { win } = makeStuckEnvironment({ standalone: false })
    vi.useFakeTimers()
    armStandaloneViewportFix()
    vi.advanceTimersByTime(10_000)
    expect(win.scrollTo).not.toHaveBeenCalled()

    vi.unstubAllGlobals()
    const android = makeStuckEnvironment({ ios: false })
    armStandaloneViewportFix()
    vi.advanceTimersByTime(10_000)
    expect(android.win.scrollTo).not.toHaveBeenCalled()
  })

  it('treats an iPad reporting a Mac user agent as iOS', () => {
    const { win } = makeStuckEnvironment()
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
      platform: 'MacIntel',
      maxTouchPoints: 5,
    })
    vi.useFakeTimers()
    armStandaloneViewportFix()
    vi.advanceTimersByTime(50)
    expect(win.scrollTo).toHaveBeenCalled()
  })

  it('nudges a stuck viewport and stops once it corrects', () => {
    const { win, doc } = makeStuckEnvironment()
    vi.useFakeTimers()
    armStandaloneViewportFix()

    // Past the double-rAF fallback: the first recompute attempt fires.
    vi.advanceTimersByTime(50)
    expect(win.scrollTo).toHaveBeenCalled()
    const attemptsWhileStuck = win.scrollTo.mock.calls.length

    // WebKit "applies" the recompute: the viewport reaches screen height.
    win.innerHeight = 852
    vi.advanceTimersByTime(10_000)
    // One more check ran and found nothing to do — no further nudges.
    expect(win.scrollTo.mock.calls.length).toBe(attemptsWhileStuck)
    // The reflow toggle always restores the root's display.
    expect(doc.documentElement.style.display).toBe('')
  })

  it('gives a document with nothing to scroll one pixel for the nudge, and takes it back', () => {
    // A layout that scrolls inside its own container leaves the document exactly
    // the viewport, so a bare scrollTo(+1) would do nothing.
    const { win, doc } = makeStuckEnvironment({ scrollHeight: 780 })
    const heightsAtScroll = []
    win.scrollTo.mockImplementation(() => heightsAtScroll.push(doc.documentElement.style.minHeight))
    vi.useFakeTimers()
    armStandaloneViewportFix()
    vi.advanceTimersByTime(50)
    expect(heightsAtScroll.length).toBeGreaterThan(0)
    expect(heightsAtScroll.every(h => h === 'calc(100% + 1px)')).toBe(true)
    expect(doc.documentElement.style.minHeight).toBe('')
  })

  it('leaves a document that scrolls on its own as it is', () => {
    const { win, doc } = makeStuckEnvironment({ scrollHeight: 2000 })
    const heightsAtScroll = []
    win.scrollTo.mockImplementation(() => heightsAtScroll.push(doc.documentElement.style.minHeight))
    vi.useFakeTimers()
    armStandaloneViewportFix()
    vi.advanceTimersByTime(50)
    expect(heightsAtScroll.length).toBeGreaterThan(0)
    expect(heightsAtScroll.every(h => h === '')).toBe(true)
  })

  it('gives up after bounded attempts when the viewport is legitimately small', () => {
    const { win } = makeStuckEnvironment()
    vi.useFakeTimers()
    armStandaloneViewportFix()
    // Never "corrects" — an iPad split-view window. Must stop, not spin.
    vi.advanceTimersByTime(60_000)
    // Each attempt scrolls twice (1px nudge + restore).
    expect(win.scrollTo.mock.calls.length).toBe(MAX_ATTEMPTS * 2)
  })

  it('honours maxAttempts and reports each attempt', () => {
    const { win } = makeStuckEnvironment()
    const onAttempt = vi.fn()
    vi.useFakeTimers()
    armStandaloneViewportFix({ maxAttempts: 2, onAttempt })
    vi.advanceTimersByTime(60_000)
    expect(win.scrollTo.mock.calls.length).toBe(4)
    expect(onAttempt).toHaveBeenCalledTimes(2)
    expect(onAttempt).toHaveBeenLastCalledWith({ attempt: 2, innerHeight: 780, expectedHeight: 852 })
  })

  it('re-kicks when the app returns to the foreground, and disarm removes the listeners', () => {
    const { win, doc } = makeStuckEnvironment()
    vi.useFakeTimers()
    const disarm = armStandaloneViewportFix({ maxAttempts: 1 })
    vi.advanceTimersByTime(60_000)
    expect(win.scrollTo.mock.calls.length).toBe(2)

    const onVisibility = doc.addEventListener.mock.calls.find(([type]) => type === 'visibilitychange')[1]
    onVisibility()
    vi.advanceTimersByTime(60_000)
    expect(win.scrollTo.mock.calls.length).toBe(4)

    disarm()
    expect(doc.removeEventListener).toHaveBeenCalledWith('visibilitychange', onVisibility)
    expect(win.removeEventListener).toHaveBeenCalledWith('pageshow', expect.any(Function))
  })

  it('expects the long screen side in portrait and the short side in landscape', () => {
    makeStuckEnvironment({ portrait: true })
    expect(expectedViewportHeight()).toBe(852)
    vi.unstubAllGlobals()
    makeStuckEnvironment({ portrait: false })
    expect(expectedViewportHeight()).toBe(393)
  })
})
