import {
  compressImage,
  createUpdateRecovery,
  armStandaloneViewportFix,
  isStandaloneDisplay,
  isIosDevice,
  expectedViewportHeight,
  DEFAULT_COOLDOWN_MS,
} from '../src/index.js'

const $ = (id) => document.getElementById(id)

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

function fillStats(dl, rows) {
  dl.replaceChildren(...rows.flatMap(([label, value]) => {
    const dt = document.createElement('dt')
    dt.textContent = label
    const dd = document.createElement('dd')
    dd.textContent = value
    return [dt, dd]
  }))
}

function makeLogger(list) {
  return (message, kind = 'info') => {
    const li = document.createElement('li')
    li.dataset.kind = kind
    const time = document.createElement('time')
    time.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    const msg = document.createElement('span')
    msg.className = 'msg'
    msg.textContent = message
    li.append(time, msg)
    list.append(li)
    list.scrollTop = list.scrollHeight
  }
}

/* ───────────── 1. Image compression ───────────── */

const urls = { orig: null, comp: null }

async function readDimensions(file) {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
    const size = { width: bitmap.width, height: bitmap.height }
    bitmap.close?.()
    return size
  } catch {
    return null
  }
}

async function handleFile(file) {
  const error = $('image-error')
  error.hidden = true
  if (!file) return

  const maxEdge = Math.max(64, Number($('max-edge').value) || 1600)
  const targetBytes = Math.max(20, Number($('target-kb').value) || 700) * 1024

  try {
    const started = performance.now()
    const result = await compressImage(file, { maxEdge, targetBytes })
    const elapsed = performance.now() - started
    const original = await readDimensions(file)

    for (const key of Object.keys(urls)) if (urls[key]) URL.revokeObjectURL(urls[key])
    urls.orig = URL.createObjectURL(file)
    urls.comp = URL.createObjectURL(result.blob)
    $('orig-img').src = urls.orig
    $('comp-img').src = urls.comp
    $('download').href = urls.comp

    fillStats($('orig-stats'), [
      ['Dimensions', original ? `${original.width} × ${original.height}` : 'n/a'],
      ['Size', formatBytes(file.size)],
      ['Type', file.type || 'unknown'],
    ])
    fillStats($('comp-stats'), [
      ['Dimensions', `${result.width} × ${result.height}`],
      ['Size', formatBytes(result.blob.size)],
      ['JPEG quality', result.quality.toFixed(1)],
      ['Time', `${elapsed.toFixed(0)} ms`],
      ['Target', result.blob.size <= targetBytes ? `met (≤ ${formatBytes(targetBytes)})` : `over — at min quality`],
    ])
    const saved = 1 - result.blob.size / file.size
    $('saving').textContent = saved > 0 ? `−${(saved * 100).toFixed(0)}%` : 'no gain'
    $('compare').hidden = false
  } catch (err) {
    error.textContent = err.code === 'NOT_AN_IMAGE'
      ? 'That file is not an image.'
      : 'This browser could not decode that image (HEIC, for example, only decodes in Safari).'
    error.hidden = false
  }
}

let lastFile = null
$('file').addEventListener('change', (event) => {
  lastFile = event.target.files?.[0] || null
  handleFile(lastFile)
})
for (const id of ['max-edge', 'target-kb']) {
  $(id).addEventListener('change', () => { if (lastFile) handleFile(lastFile) })
}
const drop = $('drop')
drop.addEventListener('dragover', (event) => { event.preventDefault(); drop.classList.add('is-over') })
drop.addEventListener('dragleave', () => drop.classList.remove('is-over'))
drop.addEventListener('drop', (event) => {
  event.preventDefault()
  drop.classList.remove('is-over')
  lastFile = event.dataTransfer?.files?.[0] || null
  handleFile(lastFile)
})

/* ───────────── 2. Deploy-skew recovery ───────────── */

const log = makeLogger($('log'))
const STORAGE_KEY = 'pwa-survival-kit-demo:chunk-reload'

// A real app keeps the defaults. The demo swaps `navigate` for a logger so
// nothing actually reloads, and skips the service-worker/cache purge, which
// would otherwise reach every app sharing this origin.
function makeRecovery() {
  return createUpdateRecovery({
    storageKey: STORAGE_KEY,
    iconUrl: `${import.meta.env.BASE_URL}icon.svg`,
    purgeOnRefresh: false,
    navigate: onNavigate,
    logger: { warn: (message) => log(message, 'warn') },
  })
}

let recovery = makeRecovery()

function onNavigate(url) {
  const overlay = document.getElementById(recovery.options.overlayId)
  if (overlay) {
    overlay.remove()
    log(`Refresh → (real app: unregister service worker, clear Cache Storage) → location.replace("${url}")`, 'action')
    log('Recovered. Simulation reset.', 'ok')
  } else {
    log(`Reload requested → location.replace("${url}")`, 'action')
    log('Simulated: the page "reloaded". If the new shell is just as stale, the next failure shows the refresh screen.', 'info')
  }
  // A real reload starts a fresh page; mirror that with a fresh instance.
  recovery = makeRecovery()
  renderMarker()
}

$('simulate').addEventListener('click', async () => {
  const missing = new URL(`./assets/Page-${Date.now().toString(36)}.js`, window.location.href).href
  try {
    await import(/* @vite-ignore */ missing)
    log('Unexpected: the missing chunk loaded.', 'warn')
  } catch (error) {
    log(`import() failed: ${error.message}`, 'error')
    const handled = recovery.recover(error)
    if (!handled) log('Not recognised as a chunk-load error — rethrown to the app.', 'warn')
    else if (document.getElementById(recovery.options.overlayId)) log('Refresh screen shown instead of a second reload.', 'warn')
  }
  renderMarker()
})

$('reset').addEventListener('click', () => {
  recovery.clearMarker()
  document.getElementById(recovery.options.overlayId)?.remove()
  recovery = makeRecovery()
  $('log').replaceChildren()
  renderMarker()
})

function renderMarker() {
  const pill = $('marker')
  const marker = recovery.readMarker()
  const remaining = marker ? DEFAULT_COOLDOWN_MS - (Date.now() - marker) : 0
  if (marker && remaining > 0) {
    pill.textContent = `Marker set · next failure shows the screen for ${Math.ceil(remaining / 1000)} s`
    pill.classList.add('is-hot')
  } else {
    pill.textContent = marker ? 'Marker expired · next failure reloads again' : 'No reload marker'
    pill.classList.remove('is-hot')
  }
}
setInterval(renderMarker, 500)
renderMarker()

/* ───────────── 3. iOS viewport fix ───────────── */

const vpLog = makeLogger($('vp-log'))
const disarm = armStandaloneViewportFix({
  onAttempt: ({ attempt, innerHeight, expectedHeight }) => {
    vpLog(`Attempt ${attempt}: innerHeight ${innerHeight}px, expected ${expectedHeight}px → recompute forced`, 'action')
  },
})
void disarm

function px(value) {
  return Number.isFinite(value) ? `${Math.round(value * 10) / 10}px` : 'n/a'
}

function renderViewport() {
  const standalone = isStandaloneDisplay()
  const ios = isIosDevice()
  const expected = expectedViewportHeight()
  const vv = window.visualViewport
  const shortfall = expected ? expected - window.innerHeight : NaN

  fillStats($('vp-values'), [
    ['innerHeight', px(window.innerHeight)],
    ['innerWidth', px(window.innerWidth)],
    ['visualViewport.height', vv ? px(vv.height) : 'n/a'],
    ['visualViewport.scale', vv ? String(Math.round(vv.scale * 100) / 100) : 'n/a'],
    ['100dvh', px($('probe-dvh').getBoundingClientRect().height)],
    ['100vh', px($('probe-vh').getBoundingClientRect().height)],
    ['safe-area-inset-bottom', px(parseFloat(getComputedStyle($('probe-safe')).paddingBottom))],
    ['screen (w × h)', `${screen.width} × ${screen.height}`],
    ['expected height', standalone ? px(expected) : 'n/a (not standalone)'],
    ['shortfall', standalone && Number.isFinite(shortfall) ? px(shortfall) : 'n/a'],
    ['display-mode: standalone', String(window.matchMedia('(display-mode: standalone)').matches)],
    ['navigator.standalone', String(navigator.standalone ?? 'undefined')],
    ['iOS / iPadOS', String(ios)],
    ['orientation', window.matchMedia('(orientation: portrait)').matches ? 'portrait' : 'landscape'],
  ])

  const verdict = $('verdict')
  if (standalone && ios) {
    const short = Number.isFinite(shortfall) && shortfall > 2
    verdict.dataset.state = short ? 'short' : 'armed'
    verdict.textContent = short
      ? `Armed — the viewport is ${Math.round(shortfall)}px short of the screen right now.`
      : 'Armed — the viewport matches the screen. Nothing to fix.'
  } else {
    verdict.dataset.state = 'idle'
    verdict.textContent = ios
      ? 'Not armed: this is iOS, but not a home-screen launch. Add the page to your Home Screen to try it.'
      : 'Not armed: the fix only runs in an iOS / iPadOS standalone PWA. Elsewhere it is a no-op.'
  }
}

window.addEventListener('resize', renderViewport)
window.visualViewport?.addEventListener('resize', renderViewport)
window.addEventListener('orientationchange', renderViewport)
renderViewport()
