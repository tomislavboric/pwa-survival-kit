// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_COOLDOWN_MS,
  DEFAULT_MESSAGES,
  DEFAULT_OVERLAY_ID,
  DEFAULT_RELOAD_PARAM,
  DEFAULT_STORAGE_KEY,
  createUpdateRecovery,
  isChunkLoadError,
} from '../src/appUpdateRecovery.js'

// Deploy skew: a client running the previous build asks for its own hashed
// chunks, which the host no longer serves, and the lazy import 404s. One silent
// reload fixes it. What must NOT happen is a second failure rethrowing into an
// aborted navigation, which the user sees as a dead screen with no way forward.
const CHUNK_ERROR = new TypeError(
  'Failed to fetch dynamically imported module: https://app.example.com/assets/ReportsPage-abc123.js',
)

const OVERLAY_SELECTOR = `#${DEFAULT_OVERLAY_ID}`

let replaceSpy
let unregisterSpy
let cacheDeleteSpy
let deleteDatabaseSpy

function stubBrowser({ href = 'https://app.example.com/reports' } = {}) {
  replaceSpy = vi.fn()
  unregisterSpy = vi.fn(async () => true)
  cacheDeleteSpy = vi.fn(async () => true)
  deleteDatabaseSpy = vi.fn()

  vi.stubGlobal('location', { href, replace: replaceSpy })
  vi.stubGlobal('navigator', {
    serviceWorker: {
      getRegistrations: async () => [{ unregister: unregisterSpy }],
    },
  })
  vi.stubGlobal('caches', {
    keys: async () => ['workbox-precache-v2-https://app.example.com/', 'runtime-pages-v1'],
    delete: cacheDeleteSpy,
  })
  // Offline data lives here; a stale-CODE recovery must never touch it.
  vi.stubGlobal('indexedDB', { deleteDatabase: deleteDatabaseSpy })
}

function overlay() {
  return document.querySelector(OVERLAY_SELECTOR)
}

describe('isChunkLoadError', () => {
  it.each([
    'Failed to fetch dynamically imported module: https://x/a.js',
    'error loading dynamically imported module: https://x/a.js',
    'Importing a module script failed.',
    'Loading chunk 42 failed.',
    'ChunkLoadError: Loading chunk 7 failed',
    'Unable to preload CSS for /assets/Page-abc.css',
  ])('recognises %s', (message) => {
    expect(isChunkLoadError(new Error(message))).toBe(true)
  })

  it('ignores unrelated errors', () => {
    expect(isChunkLoadError(new Error('Navigation aborted'))).toBe(false)
    expect(isChunkLoadError(null)).toBe(false)
  })
})

describe('stale chunk recovery', () => {
  beforeEach(() => {
    stubBrowser()
    sessionStorage.clear()
  })

  afterEach(() => {
    overlay()?.remove()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('reloads once, carrying the reload marker a service worker can answer network-only', () => {
    const recovery = createUpdateRecovery()
    expect(recovery.recover(CHUNK_ERROR)).toBe(true)

    expect(replaceSpy).toHaveBeenCalledTimes(1)
    const target = new URL(replaceSpy.mock.calls[0][0])
    expect(target.searchParams.get(DEFAULT_RELOAD_PARAM)).toMatch(/^\d+$/)
    expect(target.pathname).toBe('/reports')

    // Marker persisted so the NEXT failure is recognised as a second attempt.
    expect(Number(sessionStorage.getItem(DEFAULT_STORAGE_KEY))).toBeGreaterThan(0)
    expect(overlay()).toBeNull()
  })

  it('treats further failures on the same page, while the reload is under way, as the same incident', () => {
    const recovery = createUpdateRecovery()
    recovery.recover(CHUNK_ERROR)

    // Parallel imports failing together must not escalate to the refresh screen.
    expect(recovery.recover(CHUNK_ERROR)).toBe(true)
    expect(replaceSpy).toHaveBeenCalledTimes(1)
    expect(overlay()).toBeNull()
  })

  it('does not reload twice: a second failure inside the cooldown shows the refresh screen', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    createUpdateRecovery().recover(CHUNK_ERROR)
    replaceSpy.mockClear()

    // The page reloaded (fresh instance) and landed on a shell just as stale.
    expect(createUpdateRecovery().recover(CHUNK_ERROR)).toBe(true)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('still missing after a recovery reload'))

    // Reloading again would loop — the user gets an explicit way out instead.
    expect(replaceSpy).not.toHaveBeenCalled()
    expect(overlay()).not.toBeNull()
    expect(overlay().querySelector('button')).not.toBeNull()
    expect(overlay().textContent).toContain(DEFAULT_MESSAGES.title)
  })

  it('gives an unrelated later failure its own reload once the cooldown has passed', () => {
    const stale = Date.now() - DEFAULT_COOLDOWN_MS - 1
    sessionStorage.setItem(DEFAULT_STORAGE_KEY, String(stale))

    expect(createUpdateRecovery().recover(CHUNK_ERROR)).toBe(true)

    expect(replaceSpy).toHaveBeenCalledTimes(1)
    expect(overlay()).toBeNull()
  })

  it('leaves errors that are not chunk-import failures alone', () => {
    expect(createUpdateRecovery().recover(new Error('Navigation aborted'))).toBe(false)

    expect(replaceSpy).not.toHaveBeenCalled()
    expect(overlay()).toBeNull()
  })

  it('shows the screen instead of auto-reloading when the marker cannot be persisted', () => {
    // Private mode / blocked storage: without a marker every failure would look
    // like a first failure, so an auto-reload could never stop.
    vi.stubGlobal('sessionStorage', {
      getItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('blocked') },
      removeItem: () => { throw new Error('blocked') },
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(createUpdateRecovery().recover(CHUNK_ERROR)).toBe(true)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cannot persist the reload marker'))

    expect(replaceSpy).not.toHaveBeenCalled()
    expect(overlay()).not.toBeNull()
  })

  it('renders the screen only once no matter how many chunks fail', () => {
    const recovery = createUpdateRecovery()
    expect(recovery.showScreen()).toBe(true)
    expect(recovery.showScreen()).toBe(true)

    expect(document.querySelectorAll(OVERLAY_SELECTOR)).toHaveLength(1)
  })

  it('refresh purges the worker and Cache Storage, keeps IndexedDB, and reloads clean', async () => {
    stubBrowser({ href: `https://app.example.com/reports?${DEFAULT_RELOAD_PARAM}=1754300000000` })
    sessionStorage.setItem(DEFAULT_STORAGE_KEY, '1754300000000')

    await createUpdateRecovery().hardReload()

    // The worker holding the stale shell must go, or the reload gets it back.
    expect(unregisterSpy).toHaveBeenCalledTimes(1)
    expect(cacheDeleteSpy).toHaveBeenCalledTimes(2)
    // Offline data is not stale code — wiping it would turn a refresh into data loss.
    expect(deleteDatabaseSpy).not.toHaveBeenCalled()

    expect(sessionStorage.getItem(DEFAULT_STORAGE_KEY)).toBeNull()
    const target = new URL(replaceSpy.mock.calls[0][0])
    expect(target.searchParams.has(DEFAULT_RELOAD_PARAM)).toBe(false)
    expect(target.pathname).toBe('/reports')
  })

  it('refresh still reloads when the browser exposes no service worker or caches', async () => {
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('caches', undefined)

    await createUpdateRecovery().hardReload()

    expect(replaceSpy).toHaveBeenCalledTimes(1)
  })

  it('purgeOnRefresh: false reloads without touching workers or caches', async () => {
    await createUpdateRecovery({ purgeOnRefresh: false }).hardReload()

    expect(unregisterSpy).not.toHaveBeenCalled()
    expect(cacheDeleteSpy).not.toHaveBeenCalled()
    expect(replaceSpy).toHaveBeenCalledTimes(1)
  })

  it('the refresh button triggers the hard reload', async () => {
    createUpdateRecovery().showScreen()
    const button = overlay().querySelector('button')

    button.click()

    expect(button.disabled).toBe(true)
    expect(button.textContent).toBe(DEFAULT_MESSAGES.actionBusy)
    await vi.waitFor(() => expect(replaceSpy).toHaveBeenCalledTimes(1))
  })

  it('honours custom storage key, param, messages (strings or functions), icon and navigate', () => {
    const navigate = vi.fn()
    const recovery = createUpdateRecovery({
      storageKey: 'my-app:reload',
      reloadParam: 'r',
      overlayId: 'my-recovery',
      iconUrl: '/icon.svg',
      navigate,
      messages: { title: () => 'Nova verzija', body: 'Osvježi.', action: 'Osvježi' },
    })

    recovery.recover(CHUNK_ERROR)
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(new URL(navigate.mock.calls[0][0]).searchParams.has('r')).toBe(true)
    expect(sessionStorage.getItem('my-app:reload')).not.toBeNull()
    expect(replaceSpy).not.toHaveBeenCalled()

    recovery.showScreen()
    const screen = document.getElementById('my-recovery')
    expect(screen.querySelector('h1').textContent).toBe('Nova verzija')
    expect(screen.querySelector('button').textContent).toBe('Osvježi')
    expect(screen.querySelector('img').getAttribute('src')).toBe('/icon.svg')
    screen.remove()
  })
})

describe('wrapImport and the Vite preloadError listener', () => {
  beforeEach(() => {
    stubBrowser()
    sessionStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('wrapImport passes a successful module through', async () => {
    const mod = { default: 'Page' }
    await expect(createUpdateRecovery().wrapImport(async () => mod)()).resolves.toBe(mod)
  })

  it('wrapImport rethrows errors that are not chunk failures', async () => {
    const error = new Error('SyntaxError in module')
    await expect(createUpdateRecovery().wrapImport(async () => { throw error })()).rejects.toBe(error)
  })

  it('wrapImport never settles once recovery has taken over', async () => {
    const pending = createUpdateRecovery().wrapImport(async () => { throw CHUNK_ERROR })()
    const outcome = await Promise.race([
      pending.then(() => 'settled', () => 'settled'),
      new Promise(resolve => setTimeout(() => resolve('pending'), 20)),
    ])
    expect(outcome).toBe('pending')
    expect(replaceSpy).toHaveBeenCalledTimes(1)
  })

  it('cancels vite:preloadError when it recovers, and can be removed', () => {
    const target = new EventTarget()
    const stop = createUpdateRecovery().listenForVitePreloadErrors(target)

    const event = new Event('vite:preloadError', { cancelable: true })
    event.payload = CHUNK_ERROR
    target.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(replaceSpy).toHaveBeenCalledTimes(1)

    stop()
    const later = new Event('vite:preloadError', { cancelable: true })
    later.payload = CHUNK_ERROR
    target.dispatchEvent(later)
    expect(later.defaultPrevented).toBe(false)
  })

  it('leaves vite:preloadError alone for errors it does not handle', () => {
    const target = new EventTarget()
    createUpdateRecovery().listenForVitePreloadErrors(target)

    const event = new Event('vite:preloadError', { cancelable: true })
    event.payload = new Error('something else')
    target.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })
})

describe('reload param cleanup', () => {
  beforeEach(() => {
    stubBrowser()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('strips the reload param from the address bar after a successful recovery load', () => {
    vi.stubGlobal('location', { href: `https://app.example.com/reports?tab=open&${DEFAULT_RELOAD_PARAM}=1754300000000#top` })
    const replaceStateSpy = vi.fn()
    vi.stubGlobal('history', { state: null, replaceState: replaceStateSpy })

    expect(createUpdateRecovery().stripReloadParam()).toBe(true)

    // A worker answers the marked URL network-only with no offline fallback, so
    // the marker must not survive into a bookmark or the next PWA launch.
    expect(replaceStateSpy).toHaveBeenCalledWith(null, '', '/reports?tab=open#top')
  })

  it('is a no-op on a normal load', () => {
    vi.stubGlobal('location', { href: 'https://app.example.com/reports' })
    const replaceStateSpy = vi.fn()
    vi.stubGlobal('history', { state: null, replaceState: replaceStateSpy })

    expect(createUpdateRecovery().stripReloadParam()).toBe(false)
    expect(replaceStateSpy).not.toHaveBeenCalled()
  })
})
