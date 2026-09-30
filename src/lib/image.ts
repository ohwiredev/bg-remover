export type Rect = { x: number; y: number; width: number; height: number }

export type OutputFormat = 'image/png' | 'image/webp' | 'image/jpeg'

export type RenderOptions = {
  source: ImageBitmap
  crop: Rect
  width: number
  height: number
  /** CSS color, or null for a transparent background. */
  background: string | null
  format: OutputFormat
  /** 0–1, used by webp and jpeg. */
  quality: number
}

export const FORMAT_EXTENSIONS: Record<OutputFormat, string> = {
  'image/png': 'png',
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
}

export function fullRect(bitmap: ImageBitmap): Rect {
  return { x: 0, y: 0, width: bitmap.width, height: bitmap.height }
}

/** Grows `rect` by `padding` on each side, clamped to the bitmap. */
export function padRect(rect: Rect, padding: number, bitmap: ImageBitmap): Rect {
  const x = Math.max(0, rect.x - padding)
  const y = Math.max(0, rect.y - padding)
  return {
    x,
    y,
    width: Math.min(bitmap.width, rect.x + rect.width + padding) - x,
    height: Math.min(bitmap.height, rect.y + rect.height + padding) - y,
  }
}

/**
 * Bounding box of the non-transparent pixels.
 * Returns the full image when nothing is opaque.
 */
export function findSubjectBounds(bitmap: ImageBitmap, alphaThreshold = 8): Rect {
  const { width, height } = bitmap
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(bitmap, 0, 0)
  const data = ctx.getImageData(0, 0, width, height).data

  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    const row = y * width * 4
    for (let x = 0; x < width; x++) {
      if (data[row + x * 4 + 3] > alphaThreshold) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return fullRect(bitmap)
  return { x: minX, y: minY, width: maxX + 1 - minX, height: maxY + 1 - minY }
}

/**
 * Crops and resizes. Large downscales are done in halving steps, which keeps
 * edges much cleaner than a single drawImage call.
 */
export async function renderImage(opts: RenderOptions): Promise<Blob> {
  const { source, crop, width, height } = opts

  let current: CanvasImageSource = source
  let cw = crop.width
  let ch = crop.height
  let sx = crop.x
  let sy = crop.y

  while (cw / 2 >= width && ch / 2 >= height) {
    const nw = Math.round(cw / 2)
    const nh = Math.round(ch / 2)
    const step = new OffscreenCanvas(nw, nh)
    const sctx = step.getContext('2d')!
    sctx.imageSmoothingQuality = 'high'
    sctx.drawImage(current, sx, sy, cw, ch, 0, 0, nw, nh)
    current = step
    cw = nw
    ch = nh
    sx = 0
    sy = 0
  }

  const out = new OffscreenCanvas(width, height)
  const ctx = out.getContext('2d')!
  // JPEG has no alpha channel; without a fill, transparent pixels turn black.
  const background = opts.background ?? (opts.format === 'image/jpeg' ? '#ffffff' : null)
  if (background) {
    ctx.fillStyle = background
    ctx.fillRect(0, 0, width, height)
  }
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(current, sx, sy, cw, ch, 0, 0, width, height)

  return out.convertToBlob({
    type: opts.format,
    quality: opts.format === 'image/png' ? undefined : opts.quality,
  })
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

export function outputFileName(inputName: string, format: OutputFormat, suffix: string): string {
  const base = inputName.replace(/\.[^.]+$/, '') || 'image'
  return `${base}${suffix}.${FORMAT_EXTENSIONS[format]}`
}
