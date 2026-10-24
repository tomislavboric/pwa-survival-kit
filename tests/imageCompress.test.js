import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_MAX_EDGE,
  compressImage,
  fitWithin,
  isImageFile,
} from '../src/imageCompress.js'

describe('fitWithin', () => {
  it('scales a landscape photo so its long edge is maxEdge', () => {
    expect(fitWithin(4032, 3024)).toEqual({ width: DEFAULT_MAX_EDGE, height: 1200 })
  })

  it('scales a portrait photo by its height', () => {
    expect(fitWithin(3024, 4032)).toEqual({ width: 1200, height: DEFAULT_MAX_EDGE })
  })

  it('never scales up', () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 })
    expect(fitWithin(1600, 1600)).toEqual({ width: 1600, height: 1600 })
  })

  it('honours a custom maxEdge', () => {
    expect(fitWithin(4000, 2000, 1000)).toEqual({ width: 1000, height: 500 })
  })

  it('rounds to whole pixels and never collapses a side to 0', () => {
    expect(fitWithin(10000, 3, 1000)).toEqual({ width: 1000, height: 1 })
    expect(fitWithin(1001.4, 500.6, 2000)).toEqual({ width: 1001, height: 501 })
  })

  it('treats missing or invalid sizes as 1px', () => {
    expect(fitWithin(undefined, null)).toEqual({ width: 1, height: 1 })
    expect(fitWithin('abc', 0)).toEqual({ width: 1, height: 1 })
    expect(fitWithin('2000', '1000', 1000)).toEqual({ width: 1000, height: 500 })
  })
})

describe('isImageFile', () => {
  it('checks the MIME type', () => {
    expect(isImageFile({ type: 'image/heic' })).toBe(true)
    expect(isImageFile({ type: 'application/pdf' })).toBe(false)
    expect(isImageFile(null)).toBe(false)
  })
})

describe('compressImage (canvas stubbed)', () => {
  // A fake canvas whose JPEG size is proportional to the quality asked for, so
  // the quality search can be observed without a real encoder.
  function stubCanvas({ bytesAtFullQuality, nullBlob = false }) {
    const qualities = []
    const context = { fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() }
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => context,
      toBlob: (callback, type, quality) => {
        qualities.push(quality)
        callback(nullBlob ? null : { size: Math.round(bytesAtFullQuality * quality), type })
      },
    }
    const close = vi.fn()
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 4032, height: 3024, close })))
    vi.stubGlobal('document', { createElement: () => canvas })
    return { canvas, context, qualities, close }
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('rejects files that are not images', async () => {
    await expect(compressImage({ type: 'text/plain' })).rejects.toMatchObject({ code: 'NOT_AN_IMAGE' })
  })

  it('downscales, fills a white background and keeps the first quality that fits', async () => {
    const { canvas, context, qualities, close } = stubCanvas({ bytesAtFullQuality: 500 * 1024 })
    const result = await compressImage({ type: 'image/jpeg' })

    expect(canvas.width).toBe(1600)
    expect(canvas.height).toBe(1200)
    expect(context.fillStyle).toBe('#ffffff')
    expect(close).toHaveBeenCalled()
    expect(qualities).toEqual([0.8])
    expect(result).toMatchObject({ width: 1600, height: 1200, quality: 0.8 })
  })

  it('lowers quality in 0.1 steps until the blob fits the target', async () => {
    const { qualities } = stubCanvas({ bytesAtFullQuality: 1000 })
    const result = await compressImage({ type: 'image/png' }, { targetBytes: 650 })

    expect(qualities).toEqual([0.8, 0.7, 0.6])
    expect(result.quality).toBe(0.6)
    expect(result.blob.size).toBeLessThanOrEqual(650)
  })

  it('stops at minQuality and returns the smallest result when the target is unreachable', async () => {
    const { qualities } = stubCanvas({ bytesAtFullQuality: 1000 })
    const result = await compressImage({ type: 'image/jpeg' }, { targetBytes: 10, minQuality: 0.5 })

    expect(qualities).toEqual([0.8, 0.7, 0.6, 0.5])
    expect(result.quality).toBe(0.5)
    expect(result.blob.size).toBe(500)
  })

  it('honours maxEdge and background options', async () => {
    const { canvas, context } = stubCanvas({ bytesAtFullQuality: 10 })
    await compressImage({ type: 'image/jpeg' }, { maxEdge: 800, background: '#000000' })

    expect(canvas.width).toBe(800)
    expect(canvas.height).toBe(600)
    expect(context.fillStyle).toBe('#000000')
  })

  it('fails with IMAGE_UNREADABLE when the encoder returns nothing', async () => {
    stubCanvas({ bytesAtFullQuality: 10, nullBlob: true })
    await expect(compressImage({ type: 'image/jpeg' })).rejects.toMatchObject({ code: 'IMAGE_UNREADABLE' })
  })
})
