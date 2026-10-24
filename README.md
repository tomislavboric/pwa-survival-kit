# pwa-survival-kit

Three small, framework-agnostic browser utilities for PWA problems that only show up in production: chunk 404s after a deploy, the iOS home-screen short viewport, and multi-megabyte camera photos. Zero runtime dependencies.

**Live demo:** https://tomislavboric.github.io/pwa-survival-kit/

```js
import { createUpdateRecovery } from 'pwa-survival-kit/app-update-recovery'
import { armStandaloneViewportFix } from 'pwa-survival-kit/standalone-viewport-fix'
import { compressImage } from 'pwa-survival-kit/image-compress'
// or everything from 'pwa-survival-kit'
```

Not published to npm. Install from GitHub (`npm i github:tomislavboric/pwa-survival-kit`) or copy the file you need from `src/`. Each one is self-contained.

---

## 1. Deploy-skew recovery — `appUpdateRecovery.js`

### The problem

Between a new deploy going live and a running tab reloading onto it, the old build still asks for **its own** content-hashed chunks. A host that only serves the current deployment's assets answers 404, so the next lazy `import()` fails. A service worker usually can't help: lazy route chunks are often kept outside the precached shell, so a route the user hasn't opened yet has nothing cached.

The usual fix, "reload on chunk error", is half the story:

- **First failure → reload once**, with a `?pwa-reload=<timestamp>` marker on the URL. This almost always lands on the new build.
- **Second failure within the cooldown → don't reload again.** The reload landed on a shell that was just as stale, so another reload would loop. A full-screen "New version available → Refresh" screen comes up instead. **Refresh** unregisters service workers, clears Cache Storage and reloads. IndexedDB and localStorage are left alone, because this is a stale-code problem and wiping offline data would lose user data.
- **Storage blocked** (private mode): without a loop marker it's impossible to tell a first failure from a tenth, so the screen is shown and there is no auto-reload.

The screen is built from raw DOM on purpose. The failure being handled *is* "a lazy chunk won't load", so the recovery UI must not need one.

### Usage (Vite)

```js
// main.js — part of the entry bundle, never lazy-loaded
import { createUpdateRecovery } from 'pwa-survival-kit/app-update-recovery'

export const updateRecovery = createUpdateRecovery({
  iconUrl: '/icon.svg', // optional: use an image the browser already has cached
})

// 1. Clean ?pwa-reload from the address bar after a successful recovery load.
//    Call it before your router's first navigation so the param never enters route state.
updateRecovery.stripReloadParam()

// 2a. Let Vite report failed dynamic imports (and their CSS/JS preloads).
//     Vite fires `vite:preloadError`; when recovery takes over, the event is cancelled.
updateRecovery.listenForVitePreloadErrors()
```

When the `vite:preloadError` event is cancelled, Vite resolves that `import()` with `undefined` instead of throwing. If your router needs the import to *never settle* (so it neither renders a broken route nor shows a raw error under the recovery screen), wrap the lazy loaders instead:

```js
// 2b. Router integration (example with vue-router; any router with lazy loaders works)
const lazy = updateRecovery.wrapImport

const routes = [
  { path: '/reports', component: lazy(() => import('./pages/ReportsPage.vue')) },
]

router.onError((error) => {
  if (updateRecovery.recover(error)) return
  console.error(error)
})
```

Use one of 2a and 2b, or both. Several failures on the same page before it unloads count as one incident.

### Service worker (recommended)

If your service worker answers navigations with `NetworkFirst` or a precached `index.html`, the recovery reload could get the stale shell back. Answer the marked navigation network-only, and register it **before** your general navigation route. Example with Workbox:

```js
import { registerRoute } from 'workbox-routing'
import { NetworkOnly } from 'workbox-strategies'
import { matchPrecache } from 'workbox-precaching'

const recoveryRoute = registerRoute(
  ({ request, url }) => request.mode === 'navigate' && url.searchParams.has('pwa-reload'),
  new NetworkOnly(),
)
// Never fall back to the cached shell here. Offline is the one honest failure.
recoveryRoute.setCatchHandler(async () => (await matchPrecache('/offline.html')) || Response.error())
```

### API

`createUpdateRecovery(options?)` returns:

| Method | |
|---|---|
| `recover(error)` | Handle an error. Returns `true` if it was a chunk-load error and recovery took over (reload under way or screen shown). |
| `wrapImport(loader)` | Wraps `() => import(...)`. On a handled failure the promise never settles; other errors are rethrown. |
| `listenForVitePreloadErrors(target = window)` | Listens for `vite:preloadError`. Returns an unsubscribe function. |
| `stripReloadParam()` | Removes the reload param via `history.replaceState`. |
| `showScreen()` | Shows the refresh screen (idempotent). |
| `hardReload()` | Purges SW + Cache Storage (if `purgeOnRefresh`) and reloads to the clean URL. |
| `readMarker()` / `clearMarker()` | Inspect or reset the loop marker. |

| Option | Default | |
|---|---|---|
| `storageKey` | `'pwa-survival-kit:chunk-reload'` | sessionStorage key of the loop marker |
| `reloadParam` | `'pwa-reload'` | query param added to the recovery reload |
| `cooldownMs` | `15000` | a second failure within this window shows the screen instead of reloading |
| `messages` | English | `{ title, body, action, actionBusy }`. Strings, or functions for lazy i18n: `{ title: () => t('update.title') }` |
| `iconUrl` | none | image shown above the title |
| `overlayId` | `'pwa-update-recovery'` | element id of the screen |
| `purgeOnRefresh` | `true` | unregister service workers and clear Cache Storage on Refresh |
| `navigate` | `url => location.replace(url)` | how to reload |
| `logger` | `console` | receives `warn` messages |

Also exported: `isChunkLoadError(error)`, which recognises Chromium, Firefox, Safari, webpack and Vite chunk-load messages.

The screen's colours are CSS custom properties (`--pwa-recovery-bg`, `--pwa-recovery-title`, `--pwa-recovery-body`, `--pwa-recovery-accent`, `--pwa-recovery-on-accent`). Dark mode follows `<html data-theme="dark">`, or the OS preference unless `data-theme="light"` is set. The styles are injected as an inline `<style>`, so your CSP's `style-src` must allow `'unsafe-inline'`.

> Note: `purgeOnRefresh` affects **every** service worker and cache on the origin. If several apps share one origin, set it to `false` or handle the purge in `navigate`.

---

## 2. iOS standalone viewport fix — `standaloneViewportFix.js`

### The problem

iOS home-screen (standalone) PWAs sometimes **launch** with a browser-sized layout viewport. WebKit lays the web view out as if Safari's chrome were there, so `window.innerHeight`, `100dvh` and `env(safe-area-inset-bottom)` all come up short by the chrome band (~70–110px), and **nothing recomputes until the first scroll gesture**. You see a full-screen splash stopping above the bottom edge and a fixed bottom nav floating mid-screen until the user swipes once. Then everything snaps into place and stays. It is widely reported on iOS 26 (with variants back to iOS 17). It's an OS regression, not an app bug: CSS built on `dvh` is correct, the *viewport* is wrong.

### The fix

Force the recompute instead of waiting for the swipe:

- **Detection:** in standalone mode with a full-cover viewport, the layout viewport must equal the screen height (long or short side, depending on orientation), so any real shortfall means the stuck state.
- **Correction:** a 1px scroll nudge plus a `display: none → restore` reflow on `<html>`, both in one task, so nothing paints in between. If the document can't scroll (a layout that scrolls inside its own container), it gets one extra pixel just for the nudge, removed again in the same task.
- **Bounded retries** with growing backoff. In an iPad split-view / Stage Manager window the viewport is legitimately smaller than the screen, so after a few quiet attempts it concludes "not the bug" and stops.
- **Re-kicks** on `visibilitychange` → visible and on `pageshow` from the bfcache, because a resumed PWA can come back with the same stuck viewport.

### Usage

Arm it as early as possible at boot, so it runs while a static splash is still on screen:

```js
import { armStandaloneViewportFix } from 'pwa-survival-kit/standalone-viewport-fix'

armStandaloneViewportFix()
```

It does nothing outside an iOS/iPadOS standalone PWA and is safe to import under SSR or Node.

**Requirement:** detection assumes the full-cover setup, where the web view is supposed to fill the whole screen:

```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
```

Without it, the viewport is legitimately shorter than the screen, and the fix makes its bounded attempts and then stops.

### Options

| Option | Default | |
|---|---|---|
| `maxAttempts` | `6` | recomputes per kick before giving up |
| `retryStepMs` | `150` | attempt *n* waits *n* × step |
| `tolerancePx` | `2` | shortfall treated as rounding |
| `onAttempt` | none | `({ attempt, innerHeight, expectedHeight }) => void`, for logging |

Returns a `disarm()` function. Also exported: `isStandaloneDisplay()`, `isIosDevice()` (detects iPadOS' Mac user agent by touch points), `expectedViewportHeight()` and `forceViewportRecompute()`.

---

## 3. On-device image compression — `imageCompress.js`

### The problem

A phone camera hands over 3–12 MB per photo. Mobile users often have weak signal, and storage is paid by the gigabyte. Shrink the photo **on the device** before it goes anywhere: a JPEG whose long edge is at most 1600px, with quality lowered step by step until it fits a byte target.

### Usage

```js
import { compressImage } from 'pwa-survival-kit/image-compress'

input.addEventListener('change', async () => {
  try {
    const { blob, width, height, quality } = await compressImage(input.files[0])
    await upload(blob) // image/jpeg
  } catch (error) {
    if (error.code === 'NOT_AN_IMAGE') { /* … */ }
    if (error.code === 'IMAGE_UNREADABLE') { /* e.g. HEIC outside Safari */ }
  }
})
```

- Decodes with `createImageBitmap(file, { imageOrientation: 'from-image' })`, so EXIF rotation is applied. Falls back to `<img>`.
- Never upscales. Transparent images land on a white background (JPEG has no alpha).
- Quality starts at `quality` and drops by 0.1 while the result is over `targetBytes`, never below `minQuality`. If even that is over target, the smallest result is returned: the target is a goal, not a hard limit.

### Options

| Option | Default | |
|---|---|---|
| `maxEdge` | `1600` | max long edge in px |
| `targetBytes` | `700 * 1024` | size goal |
| `quality` | `0.8` | starting JPEG quality |
| `minQuality` | `0.5` | lowest quality tried |
| `background` | `'#ffffff'` | fill behind transparent pixels |

Also exported: `fitWithin(width, height, maxEdge)`, a pure function that returns the downscaled size, and `isImageFile(file)`.

---

## Development

```sh
npm install
npm test            # vitest
npm run demo        # demo dev server
npm run demo:build  # → demo-dist/
```

Origin: extracted from Camppy, a camp operations PWA, where they run in production.

## License

[MIT](LICENSE) © 2026 Tomislav Borić
