// A photo is made small ON THE DEVICE before it goes anywhere: mobile users
// often have little signal, storage is paid by the gigabyte, and a phone's
// camera hands over 3–12 MB. What leaves is a JPEG whose long edge is at most
// `maxEdge` — plenty to see what is in the picture — at a quality lowered step
// by step until it fits `targetBytes`.
//
// Browser-only at CALL time (canvas, createImageBitmap / Image); nothing here
// touches a browser global when the module is imported, so it loads under SSR
// or a Node test runner. `fitWithin` is the pure part.

export const DEFAULT_MAX_EDGE = 1600
export const DEFAULT_QUALITY = 0.8
export const DEFAULT_MIN_QUALITY = 0.5
export const DEFAULT_TARGET_BYTES = 700 * 1024
const QUALITY_STEP = 0.1

/**
 * The size an image is drawn at: scaled down so its long edge is `maxEdge`,
 * never scaled up. Aspect ratio is kept; every side is at least 1px.
 */
export function fitWithin(width, height, maxEdge = DEFAULT_MAX_EDGE) {
  const w = Math.max(1, Math.round(Number(width) || 0))
  const h = Math.max(1, Math.round(Number(height) || 0))
  const longest = Math.max(w, h)
  if (longest <= maxEdge) return { width: w, height: h }
  const scale = maxEdge / longest
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) }
}

export function isImageFile(file) {
  return !!file && String(file.type || '').startsWith('image/')
}

function imageError(code, message) {
  return Object.assign(new Error(message), { code })
}

// The picture, decoded and upright. createImageBitmap honours the EXIF
// orientation when asked; an <img> does so by itself in current browsers —
// the fallback for the ones that refuse the option.
async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' })
    } catch {
      // fall through to <img>
    }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => { URL.revokeObjectURL(url); resolve(image) }
    image.onerror = () => { URL.revokeObjectURL(url); reject(imageError('IMAGE_UNREADABLE', 'Image could not be read')) }
    image.src = url
  })
}

function toJpeg(canvas, quality) {
  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality))
}

/**
 * Downscale and re-encode an image File/Blob as JPEG.
 *
 * Quality starts at `quality` and drops by 0.1 while the result is larger than
 * `targetBytes`, never below `minQuality`. If even `minQuality` is over target,
 * that smallest result is returned — the target is a goal, not a hard limit.
 *
 * @returns {Promise<{ blob: Blob, width: number, height: number, quality: number }>}
 * @throws  Error with `code`:
 *   NOT_AN_IMAGE      the file's MIME type is not image/*
 *   IMAGE_UNREADABLE  the device could not decode or encode it
 */
export async function compressImage(file, {
  maxEdge = DEFAULT_MAX_EDGE,
  quality = DEFAULT_QUALITY,
  minQuality = DEFAULT_MIN_QUALITY,
  targetBytes = DEFAULT_TARGET_BYTES,
  background = '#ffffff',
} = {}) {
  if (!isImageFile(file)) throw imageError('NOT_AN_IMAGE', 'Not an image')
  let source
  try {
    source = await decode(file)
  } catch (error) {
    throw error?.code ? error : imageError('IMAGE_UNREADABLE', 'Image could not be read')
  }
  const size = fitWithin(source.naturalWidth || source.width, source.naturalHeight || source.height, maxEdge)
  const canvas = document.createElement('canvas')
  canvas.width = size.width
  canvas.height = size.height
  const context = canvas.getContext('2d')
  if (!context) throw imageError('IMAGE_UNREADABLE', 'Canvas is not available')
  // A JPEG has no transparency: a see-through picture lands on `background`
  // (white by default), not black.
  context.fillStyle = background
  context.fillRect(0, 0, size.width, size.height)
  context.drawImage(source, 0, 0, size.width, size.height)
  source.close?.()

  let step = quality
  let blob = await toJpeg(canvas, step)
  while (blob && blob.size > targetBytes && step - QUALITY_STEP >= minQuality - 1e-9) {
    step = Math.round((step - QUALITY_STEP) * 10) / 10
    blob = await toJpeg(canvas, step)
  }
  if (!blob) throw imageError('IMAGE_UNREADABLE', 'Image could not be encoded')
  return { blob, width: size.width, height: size.height, quality: step }
}
