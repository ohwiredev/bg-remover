import { useCallback, useEffect, useMemo, useState } from 'react'
import { ColorPicker } from './components/ColorPicker'
import { Chip, NumberInput, Section, Segmented, SliderInput, Switch } from './components/controls'
import { DragOverlay, EmptyState } from './components/DropZone'
import { Icon } from './components/Icon'
import { MaskEditor } from './components/MaskEditor'
import { useImageInput } from './hooks/useImageInput'
import {
  FORMAT_EXTENSIONS,
  findSubjectBounds,
  formatBytes,
  fullRect,
  outputFileName,
  padRect,
  renderImage,
  type OutputFormat,
  type Rect,
  type RenderOptions,
} from './lib/image'
import { DEFAULT_EDGES, isIdentity, refineEdges, type EdgeSettings } from './lib/edges'
import { cutOut, MODEL_OPTIONS, type ModelQuality, type Progress } from './lib/removal'

// Browsers start failing to allocate canvases somewhere above this.
const MAX_DIMENSION = 8192

type Source = { file: File; bitmap: ImageBitmap }
type Cutout = { key: string; bitmap: ImageBitmap }
/** A brush-edited cut-out, tied to the image + model it was made from. */
type Refined = Cutout
/** The final cut-out after edge refinement, tied to the bitmap and settings it came from. */
type Edged = { base: ImageBitmap; key: string; bitmap: ImageBitmap | null; error?: string }
type Result = { blob: Blob; url: string; width: number; height: number; inputs: RenderOptions }
/** Either a fraction of the (cropped) image size, or exact pixels the user typed. */
type OutputSize = { kind: 'scale'; factor: number } | { kind: 'custom'; width: number; height: number }

const SIZE_PRESETS = [
  { factor: 0.25, label: '25%' },
  { factor: 0.5, label: '50%' },
  { factor: 0.75, label: '75%' },
  { factor: 1, label: 'Original' },
]
const FILLS: { value: string | null; label: string }[] = [
  { value: null, label: 'Transparent' },
  { value: '#ffffff', label: 'White' },
  { value: '#000000', label: 'Black' },
]

export function App() {
  const [source, setSource] = useState<Source | null>(null)
  const [cutout, setCutout] = useState<Cutout | null>(null)
  const [removeBg, setRemoveBg] = useState(true)
  const [model, setModel] = useState<ModelQuality>('isnet_fp16')
  const [progress, setProgress] = useState<Progress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  const [cropToSubject, setCropToSubject] = useState(false)
  const [padding, setPadding] = useState(0)
  const [size, setSize] = useState<OutputSize>({ kind: 'scale', factor: 1 })
  const [lockAspect, setLockAspect] = useState(true)

  const [background, setBackground] = useState<string | null>(null)
  const [format, setFormat] = useState<OutputFormat>('image/png')
  const [quality, setQuality] = useState(0.92)

  const [result, setResult] = useState<Result | null>(null)
  const [showOriginal, setShowOriginal] = useState(false)
  const [refined, setRefined] = useState<Refined | null>(null)
  const [editing, setEditing] = useState(false)
  const [edges, setEdges] = useState<EdgeSettings>(DEFAULT_EDGES)
  const [edged, setEdged] = useState<Edged | null>(null)

  const fileKey = source ? `${source.file.name}:${source.file.size}:${source.file.lastModified}` : ''
  const cutoutKey = `${fileKey}:${model}`
  // With removal off, the brush works directly on the original.
  const refineKey = removeBg ? cutoutKey : `${fileKey}:manual`
  const hasCutout = removeBg && cutout?.key === cutoutKey
  const hasRefined = !!source && refined?.key === refineKey
  const working = removeBg && !!source && !hasCutout && !error

  const onFile = useCallback((file: File) => {
    setError(null)
    createImageBitmap(file)
      .then((bitmap) => {
        setSource((prev) => {
          prev?.bitmap.close()
          return { file, bitmap }
        })
        setSize({ kind: 'scale', factor: 1 })
      })
      .catch(() => setError(`Couldn't open "${file.name}". Try a PNG, JPEG or WebP image.`))
  }, [])
  const { dragging, openPicker, input } = useImageInput(onFile)

  // Run the model whenever the image or model changes (and removal is on).
  useEffect(() => {
    if (!source || !removeBg || cutout?.key === cutoutKey) return
    let cancelled = false
    setError(null)
    setProgress({ stage: 'Starting', current: 0, total: 1 })
    cutOut(source.file, model, (p) => !cancelled && setProgress(p))
      .then((blob) => createImageBitmap(blob))
      .then((bitmap) => {
        if (cancelled) return bitmap.close()
        setCutout((prev) => {
          prev?.bitmap.close()
          return { key: cutoutKey, bitmap }
        })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        console.error(err)
        setError(`Background removal failed. ${err instanceof Error ? err.message : String(err)}`)
      })
      .finally(() => !cancelled && setProgress(null))
    return () => {
      cancelled = true
    }
  }, [source, removeBg, model, cutoutKey, cutout?.key, attempt])

  const unrefinedBitmap = hasCutout ? cutout!.bitmap : removeBg ? null : (source?.bitmap ?? null)
  const baseBitmap = hasRefined ? refined!.bitmap : unrefinedBitmap
  const hasTransparency = hasCutout || hasRefined

  // Edge refinement runs on top of the brush edits, so the brush always edits
  // the raw mask. While new settings are processing, the previous result stays up.
  const edgesKey = JSON.stringify(edges)
  const refiningEdges = hasTransparency && !!baseBitmap && !isIdentity(edges)
  const edgedCurrent = refiningEdges && edged?.base === baseBitmap ? edged : null
  const edgesPending = refiningEdges && edgedCurrent?.key !== edgesKey
  const outputBitmap = edgedCurrent?.bitmap ?? baseBitmap

  useEffect(() => {
    if (!refiningEdges || !source || !baseBitmap || (edged?.base === baseBitmap && edged.key === edgesKey)) return
    let cancelled = false
    const timer = setTimeout(() => {
      refineEdges(source.bitmap, baseBitmap, JSON.parse(edgesKey) as EdgeSettings)
        .then((bitmap) => {
          if (!bitmap) return
          if (cancelled) return bitmap.close()
          setEdged((prev) => {
            prev?.bitmap?.close()
            return { base: baseBitmap, key: edgesKey, bitmap }
          })
        })
        .catch((err: unknown) => {
          console.error(err)
          if (cancelled) return
          const error = err instanceof Error ? err.message : String(err)
          setEdged((prev) => {
            prev?.bitmap?.close()
            return { base: baseBitmap, key: edgesKey, bitmap: null, error }
          })
        })
    }, 150)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [refiningEdges, source, baseBitmap, edgesKey, edged])

  // Scanning pixels is the slow part, so it's memoized separately from padding.
  const subjectBounds = useMemo(
    () => (hasTransparency && cropToSubject && outputBitmap ? findSubjectBounds(outputBitmap) : null),
    [outputBitmap, hasTransparency, cropToSubject],
  )
  const crop: Rect | null = useMemo(() => {
    if (!outputBitmap) return null
    return subjectBounds ? padRect(subjectBounds, padding, outputBitmap) : fullRect(outputBitmap)
  }, [outputBitmap, subjectBounds, padding])

  const target = useMemo(() => {
    if (!crop) return null
    if (size.kind === 'custom') return { width: clampDim(size.width), height: clampDim(size.height) }
    return { width: clampDim(crop.width * size.factor), height: clampDim(crop.height * size.factor) }
  }, [crop, size])

  // Re-render the output whenever any option changes. Debounced so typing in
  // the size fields doesn't re-encode on every keystroke.
  const renderInputs: RenderOptions | null = useMemo(
    () => (outputBitmap && crop && target ? { source: outputBitmap, crop, ...target, background, format, quality } : null),
    [outputBitmap, crop, target, background, format, quality],
  )
  const resultIsStale = result?.inputs !== renderInputs

  useEffect(() => {
    if (!renderInputs) return
    let cancelled = false
    const timer = setTimeout(() => {
      renderImage(renderInputs)
        .then((blob) => {
          if (cancelled) return
          const url = URL.createObjectURL(blob)
          setResult((prev) => {
            if (prev) URL.revokeObjectURL(prev.url)
            return { blob, url, width: renderInputs.width, height: renderInputs.height, inputs: renderInputs }
          })
        })
        .catch((err: unknown) => !cancelled && setError(`Export failed. ${String(err)}`))
    }, 120)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [renderInputs])

  const originalUrl = useMemo(() => (source ? URL.createObjectURL(source.file) : null), [source])
  useEffect(() => () => void (originalUrl && URL.revokeObjectURL(originalUrl)), [originalUrl])

  const setWidth = (w: number) => {
    if (!crop || !target) return
    setSize({ kind: 'custom', width: w, height: lockAspect ? Math.round((w * crop.height) / crop.width) : target.height })
  }
  const setHeight = (h: number) => {
    if (!crop || !target) return
    setSize({ kind: 'custom', width: lockAspect ? Math.round((h * crop.width) / crop.height) : target.width, height: h })
  }
  const toggleLock = () => {
    const next = !lockAspect
    setLockAspect(next)
    if (next && target) setWidth(target.width)
  }

  const canDownload = !!result && !working && !resultIsStale && !edgesPending
  const download = useCallback(() => {
    if (!result || !source) return
    const a = document.createElement('a')
    a.href = result.url
    a.download = outputFileName(source.file.name, format, hasTransparency ? '-nobg' : `-${result.width}x${result.height}`)
    a.click()
  }, [result, source, format, hasTransparency])

  // Ctrl/Cmd+S downloads, since that's where hands go to "save".
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && !editing) {
        e.preventDefault()
        if (canDownload) download()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canDownload, download, editing])

  const finishEditing = (bitmap: ImageBitmap) => {
    setEditing(false)
    setRefined((prev) => {
      prev?.bitmap.close()
      return { key: refineKey, bitmap }
    })
  }
  const clearRefinement = () => {
    setRefined((prev) => {
      prev?.bitmap.close()
      return null
    })
  }

  const showingOriginal = showOriginal || working || (!!error && !result)
  const previewUrl = showingOriginal ? originalUrl : result?.url
  const customFill = background !== null && !FILLS.some((f) => f.value === background)

  return (
    <div className="flex h-dvh flex-col">
      {input}
      {dragging && <DragOverlay />}

      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
        <div className="flex items-center gap-2.5">
          <img src="/favicon.svg" alt="" className="h-6 w-6" />
          <h1 className="font-semibold tracking-tight">BG Remover</h1>
        </div>
        {source && (
          <p className="hidden min-w-0 truncate text-sm text-fg-muted sm:block">
            <span className="mx-2 text-border">/</span>
            {source.file.name}
            <span className="ml-2 tabular-nums">
              {source.bitmap.width} × {source.bitmap.height}
            </span>
          </p>
        )}
        {source && (
          <button
            type="button"
            onClick={openPicker}
            className="pressable ml-auto flex h-9 items-center gap-2 rounded-[10px] px-3 text-sm text-fg-muted hover:bg-bg-sunken hover:text-fg"
          >
            <Icon name="upload" size={16} />
            New image
          </button>
        )}
      </header>

      {!source ? (
        <main className="flex flex-1 flex-col overflow-y-auto">
          {error && <ErrorBanner message={error} />}
          <EmptyState onBrowse={openPicker} />
        </main>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          {/* Stage */}
          <main className="relative h-[46dvh] shrink-0 bg-bg-sunken lg:h-auto lg:flex-1">
            <div className="absolute inset-x-4 top-4 bottom-18 flex items-center justify-center sm:inset-x-8 sm:top-8">
              {previewUrl && (
                <img
                  src={previewUrl}
                  alt={showingOriginal ? 'Original image' : 'Result'}
                  draggable={false}
                  className={`max-h-full max-w-full rounded-lg image-outline ${working ? 'scanning' : 'checker'}`}
                />
              )}
            </div>

            <div className="absolute inset-x-0 bottom-3 flex justify-center px-4 sm:bottom-4">
              {working ? (
                <ProgressPill progress={progress} />
              ) : error ? (
                <div className="flex items-center gap-3 rounded-2xl bg-bg-elevated py-1.5 pr-1.5 pl-4 text-sm shadow-float">
                  <Icon name="alert" size={16} />
                  <span className="max-w-[40ch] truncate">{error}</span>
                  <button
                    type="button"
                    onClick={() => {
                      setError(null)
                      setAttempt((n) => n + 1)
                    }}
                    className="pressable h-9 rounded-[10px] bg-accent px-3 font-medium text-accent-fg hover:opacity-90"
                  >
                    Try again
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-1 rounded-2xl bg-bg-elevated p-1 shadow-float">
                  <button
                    type="button"
                    onPointerDown={() => setShowOriginal(true)}
                    onPointerUp={() => setShowOriginal(false)}
                    onPointerLeave={() => setShowOriginal(false)}
                    onKeyDown={(e) => e.key === ' ' && setShowOriginal(true)}
                    onKeyUp={() => setShowOriginal(false)}
                    title="Hold to see the original"
                    className={`pressable flex h-10 items-center gap-2 rounded-xl px-3.5 text-sm select-none ${
                      showOriginal ? 'bg-accent-soft text-accent' : 'text-fg-muted hover:bg-bg-sunken hover:text-fg'
                    }`}
                  >
                    <Icon name="eye" size={16} />
                    Compare
                  </button>
                  <button
                    type="button"
                    disabled={!baseBitmap}
                    onClick={() => setEditing(true)}
                    className="pressable flex h-10 items-center gap-2 rounded-xl px-3.5 text-sm font-medium hover:bg-bg-sunken disabled:opacity-40"
                  >
                    <Icon name="brush" size={16} />
                    {hasRefined ? 'Edit refinements' : 'Refine edges'}
                  </button>
                  {hasRefined && (
                    <button
                      type="button"
                      onClick={clearRefinement}
                      title="Discard brush edits"
                      aria-label="Discard brush edits"
                      className="pressable flex h-10 w-10 items-center justify-center rounded-xl text-fg-muted hover:bg-bg-sunken hover:text-fg"
                    >
                      <Icon name="reset" size={16} />
                    </button>
                  )}
                </div>
              )}
            </div>
          </main>

          {/* Options */}
          <aside className="flex min-h-0 flex-1 flex-col border-t border-border bg-bg lg:w-[340px] lg:flex-none lg:border-t-0 lg:border-l">
            <div className="flex-1 divide-y divide-border overflow-y-auto px-5 pt-5">
              <Section title="Background">
                <Switch checked={removeBg} onChange={setRemoveBg} label="Remove background" />
                {removeBg && (
                  <Segmented
                    label="Detection quality"
                    value={model}
                    onChange={setModel}
                    options={MODEL_OPTIONS.map((m) => ({ value: m.value, label: m.label }))}
                  />
                )}
                {(removeBg || hasRefined) && (
                  <Switch checked={cropToSubject} onChange={setCropToSubject} label="Crop to subject" />
                )}
                {cropToSubject && (removeBg || hasRefined) && (
                  <SliderInput label="Padding" value={padding} min={0} max={1000} onChange={setPadding} suffix="px" />
                )}
                <div
                  className={`flex min-h-10 items-center gap-2 ${cropToSubject && (removeBg || hasRefined) ? 'mt-2.5' : ''}`}
                  role="radiogroup"
                  aria-label="Fill"
                >
                  <span className="mr-auto text-sm text-fg-muted">Fill</span>
                  {FILLS.map((f) => (
                    <Swatch key={f.label} label={f.label} color={f.value} selected={background === f.value} onClick={() => setBackground(f.value)} />
                  ))}
                  {/* Keyed by file so a new image (dropped/pasted, with no outside click) closes the picker. */}
                  <ColorPicker key={fileKey} value={customFill ? background : null} selected={customFill} onChange={setBackground} />
                </div>
              </Section>

              {hasTransparency && (
                <Section
                  title="Edges"
                  aside={
                    JSON.stringify(DEFAULT_EDGES) !== edgesKey && (
                      <button type="button" onClick={() => setEdges(DEFAULT_EDGES)} className="pressable text-sm text-fg-muted hover:text-fg">
                        Reset
                      </button>
                    )
                  }
                >
                  <Switch checked={edges.snap} onChange={(snap) => setEdges((e) => ({ ...e, snap }))} label="Snap to fine detail" />
                  <Switch
                    checked={edges.decontaminate}
                    onChange={(decontaminate) => setEdges((e) => ({ ...e, decontaminate }))}
                    label="Remove color fringe"
                  />
                  <SliderInput label="Shift edge" value={edges.shift} min={-10} max={10} onChange={(shift) => setEdges((e) => ({ ...e, shift }))} suffix="px" />
                  <SliderInput label="Feather" value={edges.feather} min={0} max={20} onChange={(feather) => setEdges((e) => ({ ...e, feather }))} suffix="px" />
                  <SliderInput label="Contrast" value={edges.contrast} min={0} max={100} onChange={(contrast) => setEdges((e) => ({ ...e, contrast }))} suffix="%" />
                  {edgedCurrent?.error && <p className="text-sm text-danger">Edge refinement failed: {edgedCurrent.error}</p>}
                </Section>
              )}

              <Section title="Size">
                <div className="flex flex-wrap gap-1.5">
                  {SIZE_PRESETS.map((p) => (
                    <Chip
                      key={p.factor}
                      active={size.kind === 'scale' && size.factor === p.factor}
                      onClick={() => setSize({ kind: 'scale', factor: p.factor })}
                    >
                      {p.label}
                    </Chip>
                  ))}
                </div>
                <div className="flex items-center gap-1.5">
                  <NumberInput
                    label="W"
                    ariaLabel="Width"
                    value={target?.width ?? source.bitmap.width}
                    disabled={!target}
                    min={1}
                    max={MAX_DIMENSION}
                    onChange={setWidth}
                    className="flex-1"
                  />
                  <button
                    type="button"
                    onClick={toggleLock}
                    aria-pressed={lockAspect}
                    title={lockAspect ? 'Aspect ratio locked' : 'Aspect ratio unlocked'}
                    aria-label="Lock aspect ratio"
                    className={`pressable flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] ${
                      lockAspect ? 'text-accent' : 'text-fg-muted hover:text-fg'
                    }`}
                  >
                    <Icon name={lockAspect ? 'link' : 'unlink'} size={16} />
                  </button>
                  <NumberInput
                    label="H"
                    ariaLabel="Height"
                    value={target?.height ?? source.bitmap.height}
                    disabled={!target}
                    min={1}
                    max={MAX_DIMENSION}
                    onChange={setHeight}
                    className="flex-1"
                  />
                </div>
              </Section>

              <Section title="Format">
                <Segmented
                  label="Format"
                  value={format}
                  onChange={setFormat}
                  options={[
                    { value: 'image/png', label: 'PNG' },
                    { value: 'image/webp', label: 'WebP' },
                    { value: 'image/jpeg', label: 'JPEG' },
                  ]}
                />
                {format !== 'image/png' && (
                  <label className="flex items-center gap-3 text-sm">
                    <span className="text-fg-muted">Quality</span>
                    <input
                      type="range"
                      min={0.3}
                      max={1}
                      step={0.01}
                      value={quality}
                      onChange={(e) => setQuality(Number(e.target.value))}
                      className="flex-1 accent-(--color-accent)"
                    />
                    <span className="w-8 text-right tabular-nums">{Math.round(quality * 100)}</span>
                  </label>
                )}
                {format === 'image/jpeg' && background === null && (
                  <p className="text-sm text-fg-muted">JPEG can't be transparent, so it gets a white fill.</p>
                )}
              </Section>
            </div>

            <div className="flex flex-col gap-2 border-t border-border px-5 py-4">
              <p className="flex justify-between text-sm text-fg-muted tabular-nums">
                <span>
                  {FORMAT_EXTENSIONS[format].toUpperCase()}
                  {target && ` · ${target.width} × ${target.height}`}
                </span>
                <span>{result && !resultIsStale ? formatBytes(result.blob.size) : '…'}</span>
              </p>
              <button
                type="button"
                disabled={!canDownload}
                onClick={download}
                title="Download (Ctrl+S)"
                className="pressable flex h-12 items-center justify-center gap-2 rounded-xl bg-accent font-medium text-accent-fg hover:opacity-90 disabled:opacity-40"
              >
                <Icon name="download" size={18} />
                {working ? 'Removing background…' : edgesPending ? 'Refining edges…' : result && resultIsStale ? 'Updating…' : 'Download'}
              </button>
            </div>
          </aside>
        </div>
      )}

      {editing && source && baseBitmap && (
        <MaskEditor original={source.bitmap} current={baseBitmap} onDone={finishEditing} onCancel={() => setEditing(false)} />
      )}
    </div>
  )
}

function clampDim(n: number): number {
  return Math.min(MAX_DIMENSION, Math.max(1, Math.round(n) || 1))
}

function Swatch({ label, color, selected, onClick }: { label: string; color: string | null; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`pressable h-8 w-8 rounded-full ring-offset-2 ring-offset-bg image-outline ${color === null ? 'checker' : ''} ${
        selected ? 'ring-2 ring-accent' : ''
      }`}
      style={color ? { background: color } : undefined}
    />
  )
}

function ProgressPill({ progress }: { progress: Progress | null }) {
  const downloading = progress?.stage === 'Downloading model' && progress.total > 1
  const pct = downloading ? Math.round((progress.current / progress.total) * 100) : null
  return (
    <div role="status" className="flex w-64 flex-col gap-2 rounded-2xl bg-bg-elevated px-4 py-3 shadow-float">
      <div className="flex justify-between text-sm">
        <span className="font-medium">{downloading ? 'Downloading model' : 'Removing background'}</span>
        {pct !== null && <span className="text-fg-muted tabular-nums">{pct}%</span>}
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-bg-sunken">
        <div
          className={`h-full rounded-full bg-accent transition-[width] duration-300 ${pct === null ? 'w-1/3 animate-pulse' : ''}`}
          style={pct !== null ? { width: `${pct}%` } : undefined}
        />
      </div>
      {downloading && <p className="text-xs text-fg-muted">One-time download, cached after this.</p>}
    </div>
  )
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <p role="alert" className="mx-auto mt-6 flex max-w-xl items-center gap-2 rounded-xl bg-danger/10 px-4 py-3 text-sm text-danger">
      <Icon name="alert" size={16} />
      {message}
    </p>
  )
}
