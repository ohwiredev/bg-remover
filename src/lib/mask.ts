// The editable mask is a canvas where only the alpha channel matters:
// opaque = keep the pixel, transparent = removed.

export type BrushMode = 'erase' | 'restore'

export type Brush = {
  mode: BrushMode
  /** Radius in image pixels. */
  radius: number
  /** 0 = fully feathered edge, 1 = hard edge. */
  hardness: number
}

export type Point = { x: number; y: number }

/** Builds a mask from an image's alpha channel. */
export function maskFromAlpha(image: ImageBitmap): OffscreenCanvas {
  const mask = new OffscreenCanvas(image.width, image.height)
  const ctx = mask.getContext('2d')!
  ctx.drawImage(image, 0, 0)
  ctx.globalCompositeOperation = 'source-in'
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, mask.width, mask.height)
  return mask
}

/** Draws `original` cut out by `mask` into `ctx`, replacing whatever was there. */
export function drawMasked(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  original: ImageBitmap,
  mask: OffscreenCanvas,
) {
  ctx.save()
  ctx.globalCompositeOperation = 'copy'
  ctx.drawImage(mask, 0, 0)
  ctx.globalCompositeOperation = 'source-in'
  ctx.drawImage(original, 0, 0)
  ctx.restore()
}

export function applyMask(original: ImageBitmap, mask: OffscreenCanvas): ImageBitmap {
  const out = new OffscreenCanvas(original.width, original.height)
  drawMasked(out.getContext('2d')!, original, mask)
  return out.transferToImageBitmap()
}

/** Synchronous copy of the mask, for undo history. */
export function snapshot(mask: OffscreenCanvas): ImageBitmap {
  const copy = new OffscreenCanvas(mask.width, mask.height)
  copy.getContext('2d')!.drawImage(mask, 0, 0)
  return copy.transferToImageBitmap()
}

export function restoreSnapshot(mask: OffscreenCanvas, snap: ImageBitmap) {
  const ctx = mask.getContext('2d')!
  ctx.save()
  ctx.globalCompositeOperation = 'copy'
  ctx.drawImage(snap, 0, 0)
  ctx.restore()
}

/** Paints a stroke segment as a series of round dabs. */
export function strokeSegment(mask: OffscreenCanvas, from: Point, to: Point, brush: Brush) {
  const ctx = mask.getContext('2d')!
  ctx.save()
  ctx.globalCompositeOperation = brush.mode === 'erase' ? 'destination-out' : 'source-over'

  const spacing = Math.max(1, brush.radius * 0.15)
  const dist = Math.hypot(to.x - from.x, to.y - from.y)
  const steps = Math.max(1, Math.ceil(dist / spacing))
  for (let i = dist === 0 ? 0 : 1; i <= steps; i++) {
    const t = i / steps
    dab(ctx, from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, brush)
  }
  ctx.restore()
}

function dab(ctx: OffscreenCanvasRenderingContext2D, x: number, y: number, { radius, hardness }: Brush) {
  if (hardness >= 0.99) {
    ctx.fillStyle = '#fff'
  } else {
    const g = ctx.createRadialGradient(x, y, 0, x, y, radius)
    g.addColorStop(0, '#fff')
    g.addColorStop(Math.max(0, hardness), '#fff')
    g.addColorStop(1, 'rgb(255 255 255 / 0)')
    ctx.fillStyle = g
  }
  ctx.beginPath()
  ctx.arc(x, y, radius, 0, Math.PI * 2)
  ctx.fill()
}

/** The original washed with a color, drawn under the cut-out to highlight removed areas. */
export function tintedCopy(original: ImageBitmap, color: string, strength: number): OffscreenCanvas {
  const out = new OffscreenCanvas(original.width, original.height)
  const ctx = out.getContext('2d')!
  ctx.drawImage(original, 0, 0)
  ctx.globalCompositeOperation = 'source-atop'
  ctx.globalAlpha = strength
  ctx.fillStyle = color
  ctx.fillRect(0, 0, out.width, out.height)
  return out
}
