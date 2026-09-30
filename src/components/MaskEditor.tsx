import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from 'react'
import {
  applyMask,
  drawMasked,
  maskFromAlpha,
  restoreSnapshot,
  snapshot,
  strokeSegment,
  tintedCopy,
  type BrushMode,
  type Point,
} from '../lib/mask'
import { Icon, type IconName } from './Icon'

type Props = {
  original: ImageBitmap
  /** The current cut-out; its alpha channel is the starting mask. */
  current: ImageBitmap
  onDone: (result: ImageBitmap) => void
  onCancel: () => void
}

type View = { scale: number; x: number; y: number }
type Gesture =
  | { kind: 'paint' | 'pan'; pointerId: number; last: Point }
  | { kind: 'pinch'; startDist: number; startMid: Point; startView: View }

const HISTORY_LIMIT = 30
const MIN_ZOOM = 0.05
const MAX_ZOOM = 16
const MIN_SIZE = 4
const MAX_SIZE = 300
/** How much of the image must stay on screen after panning, in screen px. */
const KEEP_VISIBLE = 72
const SETTLE_MS = 280
const HINT_KEY = 'bg-remover:refine-hint-seen'

const MODE_COLORS: Record<BrushMode, string> = { erase: '#f43f5e', restore: '#22c55e' }
const flip = (m: BrushMode): BrushMode => (m === 'erase' ? 'restore' : 'erase')

// The size slider is quadratic so small, precise brushes get most of its travel.
const sizeToSlider = (s: number) => Math.round(Math.sqrt((s - MIN_SIZE) / (MAX_SIZE - MIN_SIZE)) * 100)
const sliderToSize = (v: number) => Math.round(MIN_SIZE + (MAX_SIZE - MIN_SIZE) * (v / 100) ** 2)

export function MaskEditor({ original, current, onDone, onCancel }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const headerRef = useRef<HTMLDivElement>(null)
  const dockRef = useRef<HTMLDivElement>(null)
  // Mutated in place by the brush; never replaced.
  const [mask] = useState(() => maskFromAlpha(current))
  const tinted = useMemo(() => tintedCopy(original, '#f43f5e', 0.55), [original])

  const [mode, setMode] = useState<BrushMode>('erase')
  const [panTool, setPanTool] = useState(false)
  const [size, setSize] = useState(36) // brush diameter in screen pixels
  const [hardness, setHardness] = useState(0.7)
  const [showRemoved, setShowRemoved] = useState(true)
  const [comparing, setComparing] = useState(false)
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 })
  const [animating, setAnimating] = useState(false)
  const [cursor, setCursor] = useState<Point | null>(null)
  /** Where to show a brush preview while its size/softness is being dragged. */
  const [sizePreview, setSizePreview] = useState<Point | null>(null)
  const [brushMenu, setBrushMenu] = useState(false)
  const [spaceHeld, setSpaceHeld] = useState(false)
  const [altHeld, setAltHeld] = useState(false)
  const [gestureKind, setGestureKind] = useState<Gesture['kind'] | null>(null)
  const [hint, setHint] = useState(() => {
    try {
      return !localStorage.getItem(HINT_KEY)
    } catch {
      return true
    }
  })

  // Mask snapshots live in a ref; `historySize` mirrors their counts for the buttons.
  const history = useRef<{ undo: ImageBitmap[]; redo: ImageBitmap[] }>({ undo: [], redo: [] })
  const [historySize, setHistorySize] = useState({ undo: 0, redo: 0 })
  const syncHistorySize = () => setHistorySize({ undo: history.current.undo.length, redo: history.current.redo.length })

  const gesture = useRef<Gesture | null>(null)
  const pointers = useRef(new Map<number, Point>())
  const frame = useRef(0)
  const settleTimer = useRef(0)

  const panning = spaceHeld || panTool
  // Holding Alt flips the brush for a quick correction without switching tools.
  const activeMode: BrushMode = altHeld ? flip(mode) : mode
  const brushColor = MODE_COLORS[activeMode]

  const redraw = useCallback(() => {
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => {
      const ctx = canvasRef.current?.getContext('2d')
      if (!ctx) return
      if (comparing) {
        ctx.save()
        ctx.globalCompositeOperation = 'copy'
        ctx.drawImage(original, 0, 0)
        ctx.restore()
        return
      }
      drawMasked(ctx, original, mask)
      if (showRemoved) {
        // Removed areas show through underneath, washed red.
        ctx.save()
        ctx.globalCompositeOperation = 'destination-over'
        ctx.globalAlpha = 0.6
        ctx.drawImage(tinted, 0, 0)
        ctx.restore()
      }
    })
  }, [original, mask, tinted, showRemoved, comparing])

  useEffect(() => {
    redraw()
    return () => cancelAnimationFrame(frame.current)
  }, [redraw])

  /** The part of the canvas area not covered by the floating bars. */
  const viewport = useCallback(() => {
    const rect = containerRef.current!.getBoundingClientRect()
    const top = (headerRef.current?.offsetHeight ?? 0) + 8
    const bottom = rect.height - (dockRef.current?.offsetHeight ?? 0) - 24
    return { width: rect.width, height: rect.height, top, bottom }
  }, [])

  const animateTo = useCallback((next: View) => {
    setAnimating(true)
    setView(next)
    clearTimeout(settleTimer.current)
    settleTimer.current = window.setTimeout(() => setAnimating(false), SETTLE_MS)
  }, [])

  const fitView = useCallback((): View => {
    const vp = viewport()
    const availH = vp.bottom - vp.top
    const scale = Math.min(vp.width / original.width, availH / original.height) * 0.92
    return {
      scale,
      x: (vp.width - original.width * scale) / 2,
      y: vp.top + (availH - original.height * scale) / 2,
    }
  }, [original, viewport])

  const fit = useCallback(() => animateTo(fitView()), [animateTo, fitView])
  useLayoutEffect(() => setView(fitView()), [fitView])

  /** Pulls the image back if it's been pushed (almost) out of view. */
  const clampView = useCallback(
    (v: View): View => {
      const vp = viewport()
      const w = original.width * v.scale
      const h = original.height * v.scale
      const keepX = Math.min(KEEP_VISIBLE, w)
      const keepY = Math.min(KEEP_VISIBLE, h)
      return {
        scale: v.scale,
        x: clamp(v.x, keepX - w, vp.width - keepX),
        y: clamp(v.y, vp.top + keepY - h, vp.bottom - keepY),
      }
    },
    [original, viewport],
  )

  const settle = useCallback(() => {
    setView((v) => {
      const c = clampView(v)
      if (c.x === v.x && c.y === v.y) return v
      setAnimating(true)
      clearTimeout(settleTimer.current)
      settleTimer.current = window.setTimeout(() => setAnimating(false), SETTLE_MS)
      return c
    })
  }, [clampView])

  const zoomAt = useCallback((factor: number, sx: number, sy: number) => {
    setView((v) => {
      const scale = clamp(v.scale * factor, MIN_ZOOM, MAX_ZOOM)
      const k = scale / v.scale
      return { scale, x: sx - (sx - v.x) * k, y: sy - (sy - v.y) * k }
    })
  }, [])

  const zoomCenter = (factor: number) => {
    const vp = viewport()
    const sx = vp.width / 2
    const sy = (vp.top + vp.bottom) / 2
    const scale = clamp(view.scale * factor, MIN_ZOOM, MAX_ZOOM)
    const k = scale / view.scale
    animateTo({ scale, x: sx - (sx - view.x) * k, y: sy - (sy - view.y) * k })
  }

  // Trackpad: pinch (sent as ctrl+wheel) zooms, two-finger scroll pans.
  // Mouse wheel: zooms. Needs a non-passive listener to stop page scroll.
  useEffect(() => {
    const el = containerRef.current!
    let settleWheel = 0
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      setAnimating(false)
      const rect = el.getBoundingClientRect()
      const pinch = e.ctrlKey || e.metaKey
      const mouseWheel = e.deltaMode !== 0 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 40 && Number.isInteger(e.deltaY))
      if (pinch || mouseWheel) {
        zoomAt(Math.exp(-e.deltaY * (pinch ? 0.01 : 0.0015)), e.clientX - rect.left, e.clientY - rect.top)
      } else {
        setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }))
      }
      clearTimeout(settleWheel)
      settleWheel = window.setTimeout(settle, 160)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      el.removeEventListener('wheel', onWheel)
      clearTimeout(settleWheel)
    }
  }, [zoomAt, settle])

  useEffect(() => () => clearTimeout(settleTimer.current), [])

  const pushHistory = () => {
    const h = history.current
    h.redo.forEach((b) => b.close())
    h.redo = []
    h.undo.push(snapshot(mask))
    if (h.undo.length > HISTORY_LIMIT) h.undo.shift()?.close()
    syncHistorySize()
  }

  const step = useCallback(
    (from: 'undo' | 'redo') => {
      const h = history.current
      const to = from === 'undo' ? 'redo' : 'undo'
      const snap = h[from].pop()
      if (!snap) return
      h[to].push(snapshot(mask))
      restoreSnapshot(mask, snap)
      snap.close()
      syncHistorySize()
      redraw()
    },
    [mask, redraw],
  )
  const undo = useCallback(() => step('undo'), [step])
  const redo = useCallback(() => step('redo'), [step])
  const done = useCallback(() => onDone(applyMask(original, mask)), [onDone, original, mask])

  /** Rolls back the stroke in progress without leaving a redo entry. */
  const abandonStroke = () => {
    const snap = history.current.undo.pop()
    if (!snap) return
    restoreSnapshot(mask, snap)
    snap.close()
    syncHistorySize()
    redraw()
  }

  const resetToOriginalCut = () => {
    pushHistory()
    const initial = maskFromAlpha(current).transferToImageBitmap()
    restoreSnapshot(mask, initial)
    initial.close()
    redraw()
  }

  const dismissHint = useCallback(() => {
    setHint(false)
    try {
      localStorage.setItem(HINT_KEY, '1')
    } catch {
      // Private mode etc.: the hint just shows again next time.
    }
  }, [])

  // Free history bitmaps when the editor closes.
  useEffect(() => {
    const h = history.current
    return () => {
      h.undo.forEach((b) => b.close())
      h.redo.forEach((b) => b.close())
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Alt') {
        e.preventDefault()
        setAltHeld(true)
        return
      }
      const mod = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()
      if (mod && key === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      } else if (mod && key === 'y') {
        e.preventDefault()
        redo()
      } else if (mod) {
        return
      } else if (e.key === ' ') {
        // Also stops Space from "clicking" whichever button has focus.
        e.preventDefault()
        setSpaceHeld(true)
      } else if (e.key === 'Escape') {
        if (brushMenu) setBrushMenu(false)
      } else if (key === 'e') {
        setMode('erase')
        setPanTool(false)
      } else if (key === 'r') {
        setMode('restore')
        setPanTool(false)
      } else if (key === 'x') setMode(flip)
      else if (key === 'h') setPanTool((p) => !p)
      else if (key === 'b') setComparing(true)
      else if (e.key === '[') setSize((s) => clamp(Math.round(s / 1.2), MIN_SIZE, MAX_SIZE))
      else if (e.key === ']') setSize((s) => clamp(Math.round(s * 1.2), MIN_SIZE, MAX_SIZE))
      else if (e.key === '0') fit()
      else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) done()
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ') setSpaceHeld(false)
      if (e.key === 'Alt') setAltHeld(false)
      if (e.key.toLowerCase() === 'b') setComparing(false)
    }
    // Alt-tabbing away would otherwise leave Alt "stuck".
    const onBlur = () => {
      setAltHeld(false)
      setSpaceHeld(false)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [undo, redo, fit, done, brushMenu])

  const toLocal = (e: PointerEvent): Point => {
    const rect = containerRef.current!.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }
  const toImage = (p: Point): Point => ({ x: (p.x - view.x) / view.scale, y: (p.y - view.y) / view.scale })
  const brush = () => ({ mode: activeMode, radius: size / 2 / view.scale, hardness })

  const startGesture = (g: Gesture | null) => {
    gesture.current = g
    setGestureKind(g?.kind ?? null)
  }

  const onPointerDown = (e: PointerEvent) => {
    setBrushMenu(false)
    const p = toLocal(e)
    const pan = panning || e.button === 1
    if (!pan && e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    pointers.current.set(e.pointerId, p)
    setAnimating(false)

    // A second finger turns whatever the first one was doing into pinch-zoom.
    if (pointers.current.size === 2) {
      if (gesture.current?.kind === 'paint') abandonStroke()
      const [a, b] = [...pointers.current.values()]
      startGesture({
        kind: 'pinch',
        startDist: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
        startMid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        startView: view,
      })
      return
    }
    if (pointers.current.size > 2) return

    startGesture({ kind: pan ? 'pan' : 'paint', last: p, pointerId: e.pointerId })
    if (!pan) {
      if (hint) dismissHint()
      pushHistory()
      const ip = toImage(p)
      strokeSegment(mask, ip, ip, brush())
      redraw()
    }
  }

  const onPointerMove = (e: PointerEvent) => {
    const p = toLocal(e)
    if (e.pointerType !== 'touch') setCursor(p)
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, p)

    const g = gesture.current
    if (!g) return
    if (g.kind === 'pinch') {
      if (pointers.current.size < 2) return
      const [a, b] = [...pointers.current.values()]
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      const scale = clamp((g.startView.scale * Math.hypot(b.x - a.x, b.y - a.y)) / g.startDist, MIN_ZOOM, MAX_ZOOM)
      // Keep the image point that was under the fingers' midpoint under it.
      const ix = (g.startMid.x - g.startView.x) / g.startView.scale
      const iy = (g.startMid.y - g.startView.y) / g.startView.scale
      setView({ scale, x: mid.x - ix * scale, y: mid.y - iy * scale })
      return
    }
    if (g.pointerId !== e.pointerId) return
    const dx = p.x - g.last.x
    const dy = p.y - g.last.y
    if (g.kind === 'pan') {
      setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }))
    } else {
      strokeSegment(mask, toImage(g.last), toImage(p), brush())
      redraw()
    }
    g.last = p
  }

  const onPointerUp = (e: PointerEvent) => {
    if (!pointers.current.delete(e.pointerId)) return
    const kind = gesture.current?.kind
    // Lifting one finger of a pinch shouldn't start painting with the other.
    if (pointers.current.size === 0 || kind !== 'pinch') startGesture(null)
    if (pointers.current.size === 0 && (kind === 'pan' || kind === 'pinch')) settle()
  }

  const previewBrush = () => {
    const vp = viewport()
    setSizePreview({ x: vp.width / 2, y: (vp.top + vp.bottom) / 2 })
  }

  const zoomPct = Math.round(view.scale * 100)
  const showBrush = !panning && !comparing

  return (
    <div className="editor-in fixed inset-0 z-50 bg-bg" role="dialog" aria-modal="true" aria-label="Refine edges">
      <div
        ref={containerRef}
        className="checker absolute inset-0 touch-none overflow-hidden select-none"
        style={{ cursor: panning ? (gestureKind === 'pan' ? 'grabbing' : 'grab') : 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => setCursor(null)}
        onContextMenu={(e) => e.preventDefault()}
      >
        <canvas
          ref={canvasRef}
          width={original.width}
          height={original.height}
          className="absolute top-0 left-0 origin-top-left image-outline"
          style={{
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            transition: animating ? `transform ${SETTLE_MS}ms cubic-bezier(0.23, 1, 0.32, 1)` : undefined,
            imageRendering: view.scale > 2 ? 'pixelated' : 'auto',
          }}
        />

        {cursor && showBrush && !sizePreview && <BrushRing at={cursor} size={size} hardness={hardness} color={brushColor} />}
        {sizePreview && <BrushRing at={sizePreview} size={size} hardness={hardness} color={brushColor} />}

        {comparing && (
          <p className="rise-in pointer-events-none absolute top-20 left-1/2 -translate-x-1/2 rounded-full bg-black/70 px-3 py-1 text-xs font-medium text-white">
            Original
          </p>
        )}

        {hint && !comparing && (
          <div className="rise-in material absolute top-20 left-1/2 flex w-[min(92%,26rem)] -translate-x-1/2 items-start gap-3 rounded-2xl p-3 pl-4 text-sm">
            <p className="flex-1 text-pretty">
              Paint to <b className="font-medium" style={{ color: MODE_COLORS.erase }}>erase</b> leftover background. Switch to{' '}
              <b className="font-medium" style={{ color: MODE_COLORS.restore }}>restore</b> to bring back parts that were cut off.
            </p>
            <button
              type="button"
              aria-label="Dismiss tip"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={dismissHint}
              className="pressable -m-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-fg-muted hover:text-fg"
            >
              <Icon name="x" size={16} />
            </button>
          </div>
        )}
      </div>

      {/* Top bar */}
      <header ref={headerRef} className="material absolute inset-x-0 top-0 flex h-14 items-center gap-1 px-2 sm:px-3">
        <button
          type="button"
          onClick={onCancel}
          className="pressable flex h-10 items-center gap-1.5 rounded-[10px] px-2.5 text-sm text-fg-muted hover:bg-bg-sunken hover:text-fg"
        >
          <Icon name="x" size={18} />
          <span className="hidden sm:inline">Cancel</span>
        </button>
        <h2 className="ml-1 hidden text-sm font-medium sm:block">Refine edges</h2>

        <div className="ml-auto flex items-center gap-0.5">
          <IconButton icon="undo" label="Undo" shortcut="Ctrl+Z" disabled={!historySize.undo} onClick={undo} />
          <IconButton icon="redo" label="Redo" shortcut="Ctrl+Shift+Z" disabled={!historySize.redo} onClick={redo} />
          <IconButton icon="reset" label="Start over from the automatic cut" onClick={resetToOriginalCut} />
          <div className="mx-1.5 h-5 w-px bg-border" />
          <button
            type="button"
            title="Hold to see the original (B)"
            onPointerDown={() => setComparing(true)}
            onPointerUp={() => setComparing(false)}
            onPointerLeave={() => setComparing(false)}
            className={`pressable flex h-10 items-center gap-1.5 rounded-[10px] px-2.5 text-sm select-none ${
              comparing ? 'bg-accent-soft text-accent' : 'text-fg-muted hover:bg-bg-sunken hover:text-fg'
            }`}
          >
            <Icon name="eye" size={18} />
            <span className="hidden sm:inline">Compare</span>
          </button>
          <button
            type="button"
            onClick={done}
            title="Apply (Enter)"
            className="pressable ml-1.5 h-10 rounded-[10px] bg-accent px-4 text-sm font-medium text-accent-fg hover:opacity-90"
          >
            Done
          </button>
        </div>
      </header>

      {/* View controls */}
      <div className="material absolute right-3 bottom-5 hidden items-center gap-0.5 rounded-xl p-1 sm:flex">
        <IconButton
          icon="hand"
          label="Pan"
          shortcut="H, or hold Space"
          pressed={panTool}
          onClick={() => setPanTool((p) => !p)}
          small
        />
        <IconButton icon="minus" label="Zoom out" onClick={() => zoomCenter(1 / 1.25)} small />
        <button
          type="button"
          title="Fit to screen (0)"
          onClick={fit}
          className="pressable h-8 min-w-12 rounded-lg px-1.5 text-xs text-fg-muted tabular-nums hover:bg-bg-sunken hover:text-fg"
        >
          {zoomPct}%
        </button>
        <IconButton icon="plus" label="Zoom in" onClick={() => zoomCenter(1.25)} small />
      </div>

      {/* Brush dock */}
      <div ref={dockRef} className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center px-3 sm:bottom-5">
        <div className="material pointer-events-auto relative flex max-w-full flex-wrap items-center justify-center gap-x-3 gap-y-2 rounded-2xl p-1.5">
          <div role="radiogroup" aria-label="Brush" className="flex rounded-xl bg-bg-sunken/80 p-0.5">
            {(['erase', 'restore'] as const).map((m) => {
              const active = mode === m && !panTool
              return (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  title={`${m === 'erase' ? 'Erase' : 'Restore'} (${m === 'erase' ? 'E' : 'R'}) · X to swap, hold Alt to flip`}
                  onClick={() => {
                    setMode(m)
                    setPanTool(false)
                  }}
                  className={`pressable flex h-10 items-center gap-2 rounded-[10px] px-3.5 text-sm ${
                    active ? 'bg-bg-elevated font-medium shadow-sm' : 'text-fg-muted hover:text-fg'
                  }`}
                >
                  <span className="h-2 w-2 rounded-full" style={{ background: MODE_COLORS[m], opacity: active ? 1 : 0.5 }} />
                  {m === 'erase' ? 'Erase' : 'Restore'}
                </button>
              )
            })}
          </div>

          <label className="order-last flex h-10 w-full items-center gap-2.5 px-2 text-sm sm:order-none sm:w-auto sm:px-1">
            <span className="text-fg-muted">Size</span>
            <input
              type="range"
              min={0}
              max={100}
              value={sizeToSlider(size)}
              onChange={(e) => setSize(sliderToSize(Number(e.target.value)))}
              onPointerDown={previewBrush}
              onPointerUp={() => setSizePreview(null)}
              onBlur={() => setSizePreview(null)}
              onKeyDown={(e) => e.key === ' ' && e.preventDefault()}
              aria-valuetext={`${size} pixels`}
              className="min-w-0 flex-1 accent-(--color-accent) sm:w-32 sm:flex-none"
            />
            <span className="w-7 text-right tabular-nums">{size}</span>
          </label>

          <div className="flex items-center gap-0.5">
            <IconButton icon="sliders" label="Brush softness" pressed={brushMenu} onClick={() => setBrushMenu((o) => !o)} />
            {/* On phones, pinch zooms; this just resets the view. */}
            <button
              type="button"
              title="Fit to screen"
              onClick={fit}
              className="pressable h-10 min-w-12 rounded-[10px] px-2 text-xs text-fg-muted tabular-nums hover:bg-bg-sunken hover:text-fg sm:hidden"
            >
              {zoomPct}%
            </button>
            <button
              type="button"
              aria-pressed={showRemoved}
              title="Show removed areas in red"
              onClick={() => setShowRemoved((s) => !s)}
              className={`pressable flex h-10 items-center gap-2 rounded-[10px] px-3 text-sm ${
                showRemoved ? 'text-fg' : 'text-fg-muted hover:text-fg'
              } hover:bg-bg-sunken`}
            >
              <span
                className="h-3.5 w-3.5 rounded-[4px] border"
                style={{
                  background: showRemoved ? 'rgb(244 63 94 / 0.55)' : 'transparent',
                  borderColor: showRemoved ? 'rgb(244 63 94)' : 'var(--color-border)',
                }}
              />
              Removed
            </button>
          </div>

          {brushMenu && (
            <div className="rise-in material absolute bottom-full left-1/2 mb-2 flex w-64 -translate-x-1/2 flex-col gap-3 rounded-2xl p-4">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium">Softness</span>
                <span className="text-fg-muted tabular-nums">{Math.round((1 - hardness) * 100)}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round((1 - hardness) * 100)}
                onChange={(e) => setHardness(1 - Number(e.target.value) / 100)}
                onPointerDown={previewBrush}
                onPointerUp={() => setSizePreview(null)}
                aria-label="Softness"
                className="accent-(--color-accent)"
              />
              <p className="text-xs text-pretty text-fg-muted">Soft edges blend better for hair and fur. Keep it low for crisp outlines.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n))
}

function BrushRing({ at, size, hardness, color }: { at: Point; size: number; hardness: number; color: string }) {
  return (
    <div className="pointer-events-none absolute" style={{ left: at.x - size / 2, top: at.y - size / 2, width: size, height: size }}>
      {/* Dark outer + colored inner ring stays visible on any background. */}
      <div className="absolute inset-0 rounded-full" style={{ boxShadow: `0 0 0 1px rgb(0 0 0 / 0.5), inset 0 0 0 1.5px ${color}` }} />
      {hardness < 0.95 && size > 14 && (
        <div
          className="absolute rounded-full border border-dashed opacity-60"
          style={{ borderColor: color, inset: `${((1 - Math.max(hardness, 0.05)) * size) / 2}px` }}
        />
      )}
      <div className="absolute top-1/2 left-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ background: color }} />
    </div>
  )
}

function IconButton({
  icon,
  label,
  shortcut,
  onClick,
  disabled,
  pressed,
  small,
  className = '',
}: {
  icon: IconName
  label: string
  shortcut?: string
  onClick: () => void
  disabled?: boolean
  pressed?: boolean
  small?: boolean
  className?: string
}): ReactNode {
  return (
    <button
      type="button"
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={`pressable flex shrink-0 items-center justify-center text-fg-muted hover:bg-bg-sunken hover:text-fg disabled:pointer-events-none disabled:opacity-30 ${
        small ? 'h-8 w-8 rounded-lg' : 'h-10 w-10 rounded-[10px]'
      } ${pressed ? 'bg-accent-soft text-accent' : ''} ${className}`}
    >
      <Icon name={icon} size={small ? 16 : 18} />
    </button>
  )
}
