import { segmentForeground, type Config } from '@imgly/background-removal'
import { fullRect, padRect, type Rect } from './image'

export type ModelQuality = 'isnet_quint8' | 'isnet_fp16' | 'isnet'

export const MODEL_OPTIONS: { value: ModelQuality; label: string }[] = [
  { value: 'isnet_quint8', label: 'Fast' },
  { value: 'isnet_fp16', label: 'Balanced' },
  { value: 'isnet', label: 'Best' },
]

export type Progress = { stage: string; current: number; total: number }

/** The model always works on a square of this size, whatever the input. */
const MODEL_SIZE = 1024
/** Only re-run on the subject when that gains at least this much resolution on both axes. */
const MIN_CROP_GAIN = 1.25
/** Context kept around the subject for the second pass, as a fraction of its longer side. */
const CROP_PADDING = 0.08
/** Raw pixels, so nothing is PNG-encoded on the way in or out of the model. */
const RAW_FORMAT = 'image/x-rgba8'

let gpuFailed = false
let gpuF16: Promise<boolean> | null = null

/** Whether WebGPU can run f16 shaders. Many GPUs can't (e.g. Chrome on Linux, even on recent NVIDIA). */
function hasF16(): Promise<boolean> {
  gpuF16 ??= (async () => {
    try {
      return !!(await navigator.gpu?.requestAdapter())?.features.has('shader-f16')
    } catch {
      return false
    }
  })()
  return gpuF16
}

async function preferredDevice(model: ModelQuality): Promise<'gpu' | 'cpu'> {
  if (gpuFailed || !('gpu' in navigator)) return 'cpu'
  // Without f16 support the fp16 model fails validation on the GPU and silently returns an empty mask.
  if (model === 'isnet_fp16' && !(await hasF16())) return 'cpu'
  return 'gpu'
}

/**
 * `rect` of the photo resized to the model's square, as raw RGBA. Big
 * reductions go in halving steps per axis so every source pixel counts;
 * imgly's own resize samples only 2×2 pixels and aliases fine detail.
 */
function modelInput(photo: ImageBitmap, rect: Rect): Uint8ClampedArray<ArrayBuffer> {
  let current: CanvasImageSource = photo
  let { x: sx, y: sy, width: cw, height: ch } = rect
  while (cw / 2 >= MODEL_SIZE || ch / 2 >= MODEL_SIZE) {
    const nw = cw / 2 >= MODEL_SIZE ? Math.round(cw / 2) : cw
    const nh = ch / 2 >= MODEL_SIZE ? Math.round(ch / 2) : ch
    const step = new OffscreenCanvas(nw, nh)
    const ctx = step.getContext('2d')!
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(current, sx, sy, cw, ch, 0, 0, nw, nh)
    current = step
    cw = nw
    ch = nh
    sx = sy = 0
  }
  const out = new OffscreenCanvas(MODEL_SIZE, MODEL_SIZE)
  const ctx = out.getContext('2d', { willReadFrequently: true })!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(current, sx, sy, cw, ch, 0, 0, MODEL_SIZE, MODEL_SIZE)
  return ctx.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE).data
}

async function isnetMask(
  rgba: Uint8ClampedArray<ArrayBuffer>,
  model: ModelQuality,
  device: 'gpu' | 'cpu',
  stage: string,
  onProgress: (p: Progress) => void,
): Promise<Uint8Array> {
  const config: Config = {
    model,
    device,
    output: { format: RAW_FORMAT },
    progress: (key, current, total) => {
      onProgress({ stage: key.startsWith('fetch:') ? 'Downloading model' : stage, current, total })
    },
  }
  const input = new Blob([rgba], { type: `${RAW_FORMAT};width=${MODEL_SIZE};height=${MODEL_SIZE}` })
  const out = new Uint8Array(await (await segmentForeground(input, config)).arrayBuffer())
  const mask = new Uint8Array(MODEL_SIZE * MODEL_SIZE)
  for (let i = 0; i < mask.length; i++) mask[i] = out[i * 4 + 3]
  return mask
}

/** Runs the model on `rect` of the photo. Returns its MODEL_SIZE² mask, 0–255. */
async function segment(photo: ImageBitmap, rect: Rect, model: ModelQuality, stage: string, onProgress: (p: Progress) => void): Promise<Uint8Array> {
  // imgly only reports download progress, so announce each pass here.
  onProgress({ stage, current: 0, total: 1 })
  const input = modelInput(photo, rect)
  const device = await preferredDevice(model)
  try {
    const mask = await isnetMask(input, model, device, stage, onProgress)
    // A GPU that can't run the model may report nothing and return all zeros.
    if (device === 'gpu' && mask.every((v) => v === 0)) throw new Error('WebGPU returned an empty mask')
    return mask
  } catch (err) {
    if (device !== 'gpu') throw err
    console.warn('WebGPU inference failed, retrying on CPU', err)
    gpuFailed = true
    return isnetMask(input, model, 'cpu', stage, onProgress)
  }
}

/** The area around the subject worth a second pass, or null when it wouldn't add detail. */
function subjectCrop(mask: Uint8Array, photo: ImageBitmap): Rect | null {
  const { width, height } = photo
  if (width <= MODEL_SIZE && height <= MODEL_SIZE) return null
  let minX = MODEL_SIZE, minY = MODEL_SIZE, maxX = -1, maxY = -1
  for (let y = 0; y < MODEL_SIZE; y++) {
    for (let x = 0; x < MODEL_SIZE; x++) {
      if (mask[y * MODEL_SIZE + x] < 128) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (maxX < 0) return null
  const sx = width / MODEL_SIZE, sy = height / MODEL_SIZE
  const x = Math.floor(minX * sx), y = Math.floor(minY * sy)
  const bounds = { x, y, width: Math.ceil((maxX + 1) * sx) - x, height: Math.ceil((maxY + 1) * sy) - y }
  const crop = padRect(bounds, Math.round(CROP_PADDING * Math.max(bounds.width, bounds.height)), photo)
  const gain = Math.min(width / crop.width, height / crop.height)
  return gain >= MIN_CROP_GAIN ? crop : null
}

/** Bilinear source indices and weights for resampling `from` samples to `to`, with pixel centers aligned. */
function linearTaps(from: number, to: number) {
  const i0 = new Int32Array(to)
  const i1 = new Int32Array(to)
  const t = new Float32Array(to)
  for (let i = 0; i < to; i++) {
    const f = Math.min(from - 1, Math.max(0, (i + 0.5) * (from / to) - 0.5))
    i0[i] = Math.floor(f)
    i1[i] = Math.min(from - 1, i0[i] + 1)
    t[i] = f - i0[i]
  }
  return { i0, i1, t }
}

/**
 * Scales the model's mask up to `width`×`height` as a white image with that
 * alpha. Unlike imgly's resize, pixel centers line up, so the edge lands where
 * the model put it instead of up to a few pixels off.
 */
function upscaleMask(mask: Uint8Array, width: number, height: number): ImageData {
  const n = MODEL_SIZE
  const hx = linearTaps(n, width)
  const hy = linearTaps(n, height)
  const rows = new Float32Array(n * width)
  for (let y = 0; y < n; y++) {
    const src = y * n, dst = y * width
    for (let x = 0; x < width; x++) {
      const a = mask[src + hx.i0[x]]
      rows[dst + x] = a + (mask[src + hx.i1[x]] - a) * hx.t[x]
    }
  }
  const out = new ImageData(width, height)
  const data = out.data
  data.fill(255)
  for (let y = 0; y < height; y++) {
    const r0 = hy.i0[y] * width, r1 = hy.i1[y] * width, t = hy.t[y]
    const row = y * width
    for (let x = 0; x < width; x++) {
      const a = rows[r0 + x]
      data[(row + x) * 4 + 3] = a + (rows[r1 + x] - a) * t
    }
  }
  return out
}

/**
 * Runs the segmentation model in the browser and returns the photo with the
 * background made transparent. Model files are fetched once, then cached by the browser.
 * Falls back to CPU if WebGPU is present but fails to initialize.
 *
 * The model squeezes the whole photo into 1024×1024, so a small subject gets
 * few pixels of edge. When the subject leaves a lot of background, the model
 * runs again on just the subject, which gives its edges up to several times
 * the detail. Everything outside that crop was background in the first pass.
 */
export async function cutOut(photo: ImageBitmap, model: ModelQuality, onProgress: (p: Progress) => void): Promise<ImageBitmap> {
  const first = await segment(photo, fullRect(photo), model, 'Processing', onProgress)
  const crop = subjectCrop(first, photo)
  const region = crop ?? fullRect(photo)
  const mask = crop ? await segment(photo, crop, model, 'Refining subject', onProgress) : first

  const regionMask = new OffscreenCanvas(region.width, region.height)
  regionMask.getContext('2d')!.putImageData(upscaleMask(mask, region.width, region.height), 0, 0)
  const out = new OffscreenCanvas(photo.width, photo.height)
  const ctx = out.getContext('2d')!
  ctx.drawImage(regionMask, region.x, region.y)
  ctx.globalCompositeOperation = 'source-in'
  ctx.drawImage(photo, 0, 0)
  return out.transferToImageBitmap()
}
