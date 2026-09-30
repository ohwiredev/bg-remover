import { removeBackground, type Config } from '@imgly/background-removal'

export type ModelQuality = 'isnet_quint8' | 'isnet_fp16' | 'isnet'

export const MODEL_OPTIONS: { value: ModelQuality; label: string }[] = [
  { value: 'isnet_quint8', label: 'Fast' },
  { value: 'isnet_fp16', label: 'Balanced' },
  { value: 'isnet', label: 'Best' },
]

export type Progress = { stage: string; current: number; total: number }

let gpuFailed = false

function preferredDevice(): 'gpu' | 'cpu' {
  return !gpuFailed && 'gpu' in navigator ? 'gpu' : 'cpu'
}

/**
 * Runs the segmentation model in the browser and returns a PNG with the
 * background made transparent. Model files are fetched once, then cached by the browser.
 * Falls back to CPU if WebGPU is present but fails to initialize.
 */
export async function cutOut(
  image: Blob,
  model: ModelQuality,
  onProgress: (p: Progress) => void,
): Promise<Blob> {
  const run = (device: 'gpu' | 'cpu') => {
    const config: Config = {
      model,
      device,
      output: { format: 'image/png' },
      progress: (key, current, total) => {
        onProgress({ stage: key.startsWith('fetch:') ? 'Downloading model' : 'Processing', current, total })
      },
    }
    return removeBackground(image, config)
  }

  const device = preferredDevice()
  try {
    return await run(device)
  } catch (err) {
    if (device !== 'gpu') throw err
    console.warn('WebGPU inference failed, retrying on CPU', err)
    gpuFailed = true
    return run('cpu')
  }
}
