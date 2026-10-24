// Recovery for the deploy-skew window.
//
// Between a new deploy going live and a running client reloading onto it, the
// old build still asks for ITS OWN content-hashed chunks — and a host that only
// serves the current deployment's assets answers 404, so a lazy route import
// fails. A service worker cannot paper over it either if lazy feature chunks are
// kept outside the precached app shell: a route the user has not opened this
// session has nothing cached to fall back to.
//
// First failure: reload once. The reload carries ?<reloadParam>=<timestamp>, a
// marker a service worker can answer network-only, so the reload is guaranteed
// to land on a shell that matches the assets now on the server. Silent, and
// almost always enough.
//
// Second failure moments later: the reload did NOT land on a newer shell, so
// reloading again would loop. Show an explicit way out instead. Rethrowing into
// an aborted navigation reads as a dead screen — a stuck splash on a cold load,
// or a tab that simply does nothing on tap.
//
// The screen is built from raw DOM ON PURPOSE: the failure being recovered from
// IS "a lazy chunk will not load", so the recovery UI must not need one — no
// framework component, no dynamic import. Import this module from the entry
// bundle.

export const DEFAULT_STORAGE_KEY = 'pwa-survival-kit:chunk-reload'
export const DEFAULT_RELOAD_PARAM = 'pwa-reload'
// Long enough that a slow shell fetch plus boot cannot be mistaken for a loop,
// short enough that two unrelated chunk failures in one session each get their
// own free reload.
export const DEFAULT_COOLDOWN_MS = 15000
export const DEFAULT_OVERLAY_ID = 'pwa-update-recovery'

export const DEFAULT_MESSAGES = Object.freeze({
  title: 'New version available',
  body: 'The app updated in the background, so this screen can no longer load. Refresh to continue on the new version.',
  action: 'Refresh the app',
  actionBusy: 'Refreshing…',
})

/**
 * True for the error messages browsers and bundlers produce when a dynamically
 * imported chunk cannot be fetched:
 *   Chromium  "Failed to fetch dynamically imported module"
 *   Firefox   "error loading dynamically imported module"
 *   Safari    "Importing a module script failed"
 *   webpack   "Loading chunk …" / ChunkLoadError
 *   Vite      "Unable to preload CSS for …" (a route's CSS chunk, same skew)
 */
export function isChunkLoadError(error) {
  const message = String(error?.message || error || '').toLowerCase()
  return message.includes('failed to fetch dynamically imported module')
    || message.includes('error loading dynamically imported module')
    || message.includes('importing a module script failed')
    || message.includes('loading chunk')
    || message.includes('chunkloaderror')
    || message.includes('unable to preload css')
}

function resolveMessage(value) {
  return typeof value === 'function' ? String(value()) : String(value)
}

// Inline <style>: needs a CSP whose style-src allows 'unsafe-inline'.
// Colours are CSS custom properties so an app can match its own splash screen;
// dark applies for [data-theme="dark"] on <html>, or for the OS preference unless
// <html data-theme="light"> says otherwise.
function overlayCss(id) {
  return `
#${id} {
  --pwa-recovery-bg: #F2F4F7; --pwa-recovery-title: #101828; --pwa-recovery-body: #475467;
  --pwa-recovery-accent: #0284C7; --pwa-recovery-on-accent: #FFFFFF;
  position: fixed; inset: 0; z-index: 2147483647;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  padding: 24px; text-align: center;
  background: var(--pwa-recovery-bg);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}
#${id} .pwa-update-recovery__mark { width: 64px; height: 64px; display: block; margin-bottom: 18px; }
#${id} .pwa-update-recovery__title {
  margin: 0; font-size: 18px; font-weight: 700;
  letter-spacing: -0.02em; color: var(--pwa-recovery-title);
}
#${id} .pwa-update-recovery__body {
  margin: 10px 0 0; max-width: 34ch; font-size: 14px; line-height: 1.5; color: var(--pwa-recovery-body);
}
#${id} .pwa-update-recovery__action {
  margin-top: 24px; min-height: 44px; padding: 0 24px;
  border: 0; border-radius: 10px; cursor: pointer;
  background: var(--pwa-recovery-accent); color: var(--pwa-recovery-on-accent);
  font: inherit; font-size: 15px; font-weight: 600;
}
#${id} .pwa-update-recovery__action:disabled { opacity: 0.6; cursor: default; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) #${id} {
    --pwa-recovery-bg: #111927; --pwa-recovery-title: #F5F5F6;
    --pwa-recovery-body: #98A2B3; --pwa-recovery-accent: #0BA5EC;
  }
}
[data-theme="dark"] #${id} {
  --pwa-recovery-bg: #111927; --pwa-recovery-title: #F5F5F6;
  --pwa-recovery-body: #98A2B3; --pwa-recovery-accent: #0BA5EC;
}
`
}

/**
 * Create a recovery instance. All options are optional.
 *
 * @param {object}   [options]
 * @param {string}   [options.storageKey]   sessionStorage key for the loop marker
 * @param {string}   [options.reloadParam]  query param added to the recovery reload
 * @param {number}   [options.cooldownMs]   a second failure within this window shows the screen
 * @param {object}   [options.messages]     { title, body, action, actionBusy } — strings or () => string
 * @param {string}   [options.iconUrl]      image shown above the title (use one that is already cached)
 * @param {string}   [options.overlayId]    id of the recovery screen element
 * @param {boolean}  [options.purgeOnRefresh] unregister service workers + clear Cache Storage on "Refresh"
 * @param {Function} [options.navigate]     (url) => void, defaults to location.replace(url)
 * @param {object}   [options.logger]       { warn } — defaults to console
 */
export function createUpdateRecovery(options = {}) {
  const {
    storageKey = DEFAULT_STORAGE_KEY,
    reloadParam = DEFAULT_RELOAD_PARAM,
    cooldownMs = DEFAULT_COOLDOWN_MS,
    iconUrl = '',
    overlayId = DEFAULT_OVERLAY_ID,
    purgeOnRefresh = true,
    navigate = (url) => window.location.replace(url),
    logger = console,
  } = options
  const messages = { ...DEFAULT_MESSAGES, ...(options.messages || {}) }

  // A reload has been requested from THIS page and is still under way. Any
  // further chunk failure before the page unloads (parallel imports, or the same
  // error seen by two handlers) belongs to the same incident.
  let reloadPending = false

  function readMarker() {
    try {
      return Number(sessionStorage.getItem(storageKey) || 0)
    } catch {
      return 0
    }
  }

  // Returns false when the marker could not be persisted. Callers must then NOT
  // auto-reload: without a marker the next failure looks like a first failure,
  // and the recovery would reload forever.
  function writeMarker(value) {
    try {
      sessionStorage.setItem(storageKey, String(value))
      return true
    } catch {
      return false
    }
  }

  function clearMarker() {
    try {
      sessionStorage.removeItem(storageKey)
    } catch {
      /* storage blocked (private mode / disabled cookies) — nothing to clear */
    }
  }

  /**
   * Handle a failed lazy-chunk import. Returns true when the failure has been
   * taken over (a reload is under way, or the recovery screen is up) and the
   * caller should stop propagating the error.
   */
  function recover(error) {
    if (!isChunkLoadError(error) || typeof window === 'undefined') return false
    if (reloadPending) return true

    const now = Date.now()
    const previous = readMarker()

    if (previous && now - previous < cooldownMs) {
      // Already reloaded moments ago and the chunk STILL will not load: whatever
      // shell this reload landed on is as stale as the one before it. Another
      // reload would loop.
      clearMarker()
      logger.warn?.('[update-recovery] chunk still missing after a recovery reload — offering a manual refresh')
      return showScreen()
    }

    if (!writeMarker(now)) {
      // No loop detection available, so an auto-reload is not safe to attempt.
      logger.warn?.('[update-recovery] cannot persist the reload marker — offering a manual refresh')
      return showScreen()
    }

    const url = new URL(window.location.href)
    url.searchParams.set(reloadParam, String(now))
    reloadPending = true
    navigate(url.toString())
    return true
  }

  /**
   * Full-screen "the app updated, refresh" screen. Idempotent — a second call
   * while it is already up is a no-op. Returns true once it is (or already was)
   * displayed.
   */
  function showScreen() {
    if (typeof document === 'undefined' || !document.body) return false
    if (document.getElementById(overlayId)) return true

    const style = document.createElement('style')
    style.textContent = overlayCss(overlayId)

    const overlay = document.createElement('div')
    overlay.id = overlayId
    overlay.setAttribute('role', 'alertdialog')
    overlay.setAttribute('aria-modal', 'true')
    overlay.setAttribute('aria-labelledby', `${overlayId}-title`)
    overlay.setAttribute('aria-describedby', `${overlayId}-body`)

    const children = [style]

    if (iconUrl) {
      // Use an image the browser already holds (favicon, splash mark): the
      // network has just failed, so a fresh fetch may not paint.
      const mark = document.createElement('img')
      mark.className = 'pwa-update-recovery__mark'
      mark.src = iconUrl
      mark.width = 64
      mark.height = 64
      mark.alt = ''
      children.push(mark)
    }

    const title = document.createElement('h1')
    title.className = 'pwa-update-recovery__title'
    title.id = `${overlayId}-title`
    title.textContent = resolveMessage(messages.title)

    const body = document.createElement('p')
    body.className = 'pwa-update-recovery__body'
    body.id = `${overlayId}-body`
    body.textContent = resolveMessage(messages.body)

    const action = document.createElement('button')
    action.className = 'pwa-update-recovery__action'
    action.type = 'button'
    action.textContent = resolveMessage(messages.action)
    action.addEventListener('click', () => {
      action.disabled = true
      action.textContent = resolveMessage(messages.actionBusy)
      hardReload()
    })

    children.push(title, body, action)
    overlay.append(...children)
    document.body.appendChild(overlay)
    action.focus()

    return true
  }

  /**
   * Drop every cached copy of the old build, then reload. The worker that
   * answered the failed navigation is the one holding the stale shell, so
   * leaving it registered would serve the same dead assets again.
   *
   * Only Cache Storage is purged. IndexedDB, localStorage and cookies are left
   * alone — this is a stale-CODE problem, and wiping the user's offline data
   * would turn a refresh into data loss.
   */
  async function hardReload() {
    if (purgeOnRefresh) {
      try {
        const registrations = await navigator.serviceWorker?.getRegistrations?.() || []
        await Promise.all(registrations.map(registration => (
          Promise.resolve(registration.unregister()).catch(() => false)
        )))
      } catch {
        /* no service-worker support, or access blocked — the reload below still helps */
      }

      try {
        const keys = await globalThis.caches?.keys?.() || []
        await Promise.all(keys.map(key => (
          Promise.resolve(globalThis.caches.delete(key)).catch(() => false)
        )))
      } catch {
        /* Cache Storage unavailable — nothing to purge */
      }
    }

    clearMarker()

    // Reload WITHOUT the recovery marker: the worker is gone, so the request goes
    // to the network anyway, and a clean URL is what the user should be left on.
    const url = new URL(window.location.href)
    url.searchParams.delete(reloadParam)
    navigate(url.toString())
  }

  /**
   * Drop the reload param from the address bar once the recovery load has
   * succeeded. A service worker that answers that URL network-only has no
   * offline fallback for it, so the marker must not survive into a bookmark, a
   * share, or the next launch of an installed PWA. Call BEFORE a client-side
   * router's first navigation so it never enters route state.
   */
  function stripReloadParam() {
    if (typeof window === 'undefined') return false

    const url = new URL(window.location.href)
    if (!url.searchParams.has(reloadParam)) return false

    url.searchParams.delete(reloadParam)
    try {
      window.history?.replaceState?.(
        window.history.state,
        '',
        `${url.pathname}${url.search}${url.hash}`,
      )
    } catch {
      return false
    }
    return true
  }

  /**
   * Wrap a lazy loader, e.g. `() => import('./Page.js')`. When recovery takes
   * over, the returned promise never settles: resolving would render a
   * half-broken route, rejecting would surface a raw chunk error underneath the
   * screen that was just put up. Any other error is rethrown.
   */
  function wrapImport(loader) {
    return () => loader().catch((error) => {
      if (recover(error)) return new Promise(() => {})
      throw error
    })
  }

  /**
   * Listen for Vite's `vite:preloadError` event (fired by Vite-built apps when a
   * dynamic import or one of its preloaded CSS/JS dependencies fails). When
   * recovery takes over, the event is cancelled so Vite does not rethrow.
   * Returns a function that removes the listener.
   */
  function listenForVitePreloadErrors(target = typeof window !== 'undefined' ? window : null) {
    if (!target?.addEventListener) return () => {}
    const onPreloadError = (event) => {
      if (recover(event.payload)) event.preventDefault()
    }
    target.addEventListener('vite:preloadError', onPreloadError)
    return () => target.removeEventListener('vite:preloadError', onPreloadError)
  }

  return {
    recover,
    showScreen,
    hardReload,
    stripReloadParam,
    wrapImport,
    listenForVitePreloadErrors,
    clearMarker,
    readMarker,
    options: Object.freeze({ storageKey, reloadParam, cooldownMs, overlayId }),
  }
}
