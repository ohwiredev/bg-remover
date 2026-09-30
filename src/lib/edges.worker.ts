import { adjustAlpha, compose, guidedAlpha, type EdgeSettings } from './edgeRefine'

export type EdgeRequest =
  | { type: 'load'; width: number; height: number; rgba: ArrayBuffer; alpha: ArrayBuffer }
  | { type: 'run'; id: number; settings: EdgeSettings }
export type EdgeResponse = { id: number; rgba: ArrayBuffer } | { id: number; error: string }

// The image stays loaded between runs, and the guided filter (the slow part)
// is cached, so dragging the shift/feather/contrast sliders stays quick.
let image: { width: number; height: number; rgba: Uint8ClampedArray; alpha: Float32Array; guided?: Float32Array } | null = null

self.onmessage = (e: MessageEvent<EdgeRequest>) => {
  const msg = e.data
  if (msg.type === 'load') {
    const raw = new Uint8Array(msg.alpha)
    const alpha = new Float32Array(raw.length)
    for (let i = 0; i < raw.length; i++) alpha[i] = raw[i] / 255
    image = { width: msg.width, height: msg.height, rgba: new Uint8ClampedArray(msg.rgba), alpha }
    return
  }

  try {
    if (!image) throw new Error('No image loaded')
    const { width: w, height: h, rgba } = image
    const s = msg.settings
    if (s.snap) image.guided ??= guidedAlpha(rgba, image.alpha, w, h)
    const alpha = (s.snap ? image.guided! : image.alpha).slice()
    adjustAlpha(alpha, w, h, s)
    const out = new Uint8ClampedArray(w * h * 4)
    compose(rgba, alpha, w, h, s.decontaminate, out)
    self.postMessage({ id: msg.id, rgba: out.buffer } satisfies EdgeResponse, { transfer: [out.buffer] })
  } catch (err) {
    self.postMessage({ id: msg.id, error: err instanceof Error ? err.message : String(err) } satisfies EdgeResponse)
  }
}
