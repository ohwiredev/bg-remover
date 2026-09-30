import type { EdgeSettings } from './edgeRefine'
import type { EdgeRequest, EdgeResponse } from './edges.worker'

export { DEFAULT_EDGES, isIdentity, type EdgeSettings } from './edgeRefine'

type Job = {
  original: ImageBitmap
  base: ImageBitmap
  settings: EdgeSettings
  resolve: (bitmap: ImageBitmap | null) => void
  reject: (err: unknown) => void
}

let worker: Worker | null = null
let loaded: { original: ImageBitmap; base: ImageBitmap } | null = null
let nextId = 0
const replies = new Map<number, (res: EdgeResponse) => void>()
let running = false
let queued: Job | null = null

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./edges.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<EdgeResponse>) => {
      replies.get(e.data.id)?.(e.data)
      replies.delete(e.data.id)
    }
    // A crash (usually out of memory on a huge image) fails whatever is waiting
    // and starts a fresh worker next time.
    worker.onerror = (e) => {
      e.preventDefault()
      for (const [id, reply] of replies) reply({ id, error: e.message || 'Edge worker crashed' })
      replies.clear()
      worker?.terminate()
      worker = null
      loaded = null
    }
  }
  return worker
}

function pixels(bitmap: ImageBitmap, width: number, height: number): Uint8ClampedArray {
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(bitmap, 0, 0, width, height)
  return ctx.getImageData(0, 0, width, height).data
}

function send(msg: EdgeRequest, transfer: Transferable[] = []) {
  getWorker().postMessage(msg, transfer)
}

async function run({ original, base, settings }: Job): Promise<ImageBitmap> {
  const { width, height } = original
  if (loaded?.original !== original || loaded.base !== base) {
    const rgba = pixels(original, width, height)
    const baseData = pixels(base, width, height)
    const alpha = new Uint8Array(width * height)
    for (let i = 0; i < alpha.length; i++) alpha[i] = baseData[i * 4 + 3]
    send({ type: 'load', width, height, rgba: rgba.buffer as ArrayBuffer, alpha: alpha.buffer }, [rgba.buffer, alpha.buffer])
    loaded = { original, base }
  }
  const id = nextId++
  const res = await new Promise<EdgeResponse>((resolve) => {
    replies.set(id, resolve)
    send({ type: 'run', id, settings })
  })
  if ('error' in res) throw new Error(res.error)
  return createImageBitmap(new ImageData(new Uint8ClampedArray(res.rgba), width, height))
}

function pump() {
  if (running || !queued) return
  const job = queued
  queued = null
  running = true
  run(job)
    .then(job.resolve, job.reject)
    .finally(() => {
      running = false
      pump()
    })
}

/**
 * Refines the edges of `base`'s alpha against the `original` photo, off the main thread.
 * Only the latest request is kept while one is running; superseded ones resolve to null.
 */
export function refineEdges(original: ImageBitmap, base: ImageBitmap, settings: EdgeSettings): Promise<ImageBitmap | null> {
  return new Promise((resolve, reject) => {
    queued?.resolve(null)
    queued = { original, base, settings, resolve, reject }
    pump()
  })
}
