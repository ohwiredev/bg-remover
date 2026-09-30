import { useId, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Icon } from './Icon'

type Hsv = { h: number; s: number; v: number }

// Not in TS's DOM lib yet; Chromium-only.
declare global {
  interface Window {
    EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> }
  }
}

const POPOVER_WIDTH = 240
const GUTTER = 8

/**
 * Custom-colour swatch with an in-page picker. The native <input type="color"> popup is placed by the
 * browser at the input's left edge and gets cut off at the window edge when the swatch sits at the
 * right of the sidebar, so we draw our own in the top layer and keep it on screen.
 */
export function ColorPicker({
  value,
  selected,
  onChange,
}: {
  /** Current custom colour as #rrggbb, or null when no custom colour is active. */
  value: string | null
  selected: boolean
  onChange: (hex: string) => void
}) {
  const id = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(value ?? '#4f6bed'))
  const [draft, setDraft] = useState<string | null>(null)

  // Follow outside changes to the value without losing hue on greys.
  const [seenValue, setSeenValue] = useState(value)
  if (value !== seenValue) {
    setSeenValue(value)
    if (value && value !== hsvToHex(hsv)) setHsv(hexToHsv(value))
  }

  const hex = hsvToHex(hsv)
  const commit = (next: Hsv) => {
    setHsv(next)
    setDraft(null)
    onChange(hsvToHex(next))
  }

  const place = () => {
    const trigger = triggerRef.current
    const pop = popoverRef.current
    if (!trigger || !pop) return
    const r = trigger.getBoundingClientRect()
    // Right-align with the swatch, then clamp inside the viewport.
    const left = Math.min(Math.max(GUTTER, r.right - POPOVER_WIDTH), window.innerWidth - POPOVER_WIDTH - GUTTER)
    // Hidden popovers measure 0 tall; the toggle handler re-places once it's shown.
    const height = pop.offsetHeight
    const below = r.bottom + GUTTER
    const top = below + height > window.innerHeight - GUTTER ? Math.max(GUTTER, r.top - GUTTER - height) : below
    pop.style.left = `${left}px`
    pop.style.top = `${top}px`
  }

  useLayoutEffect(() => {
    if (!open) return
    place()
    const onMove = () => place()
    window.addEventListener('resize', onMove)
    // Capture so scrolling the sidebar keeps it attached.
    window.addEventListener('scroll', onMove, true)
    return () => {
      window.removeEventListener('resize', onMove)
      window.removeEventListener('scroll', onMove, true)
    }
  }, [open])


  const dragArea = (e: ReactPointerEvent<HTMLDivElement>, apply: (x: number, y: number) => void) => {
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const update = (ev: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect()
      apply(clamp01((ev.clientX - r.left) / r.width), clamp01((ev.clientY - r.top) / r.height))
    }
    update(e)
    const move = (ev: PointerEvent) => update(ev)
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  const pickFromScreen = async () => {
    if (!window.EyeDropper) return
    try {
      const { sRGBHex } = await new window.EyeDropper().open()
      commit(hexToHsv(sRGBHex))
    } catch {
      // Cancelled.
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="radio"
        aria-checked={selected}
        aria-label="Custom color"
        title="Custom color"
        popoverTarget={id}
        // Clicking the swatch starts from the colour it shows.
        onClick={() => !selected && onChange(hex)}
        className={`pressable h-8 w-8 rounded-full ring-offset-2 ring-offset-bg image-outline ${selected ? 'ring-2 ring-accent' : ''}`}
        style={{ background: selected ? value! : 'conic-gradient(#f43f5e, #f59e0b, #22c55e, #06b6d4, #6366f1, #d946ef, #f43f5e)' }}
      />
      <div
        ref={popoverRef}
        id={id}
        popover="auto"
        onBeforeToggle={(e) => e.newState === 'open' && place()}
        onToggle={(e) => setOpen(e.newState === 'open')}
        className="fixed m-0 flex-col gap-3 rounded-2xl border border-border bg-bg-elevated p-3 text-fg shadow-float open:flex"
        style={{ width: POPOVER_WIDTH, inset: 'auto' }}
      >
        <div
          role="slider"
          tabIndex={0}
          aria-label="Saturation and brightness"
          aria-valuetext={`Saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`}
          className="relative h-36 cursor-crosshair touch-none rounded-lg"
          style={{
            background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent), hsl(${hsv.h} 100% 50%)`,
          }}
          onPointerDown={(e) => dragArea(e, (x, y) => commit({ ...hsv, s: x, v: 1 - y }))}
          onKeyDown={(e) => {
            const step = e.shiftKey ? 0.1 : 0.01
            const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key]
            if (!d) return
            e.preventDefault()
            commit({ ...hsv, s: clamp01(hsv.s + d[0]), v: clamp01(hsv.v + d[1]) })
          }}
        >
          <span
            aria-hidden
            className="pointer-events-none absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgb(0_0_0/0.3)]"
            style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: hex }}
          />
        </div>

        <div
          role="slider"
          tabIndex={0}
          aria-label="Hue"
          aria-valuemin={0}
          aria-valuemax={360}
          aria-valuenow={Math.round(hsv.h)}
          className="relative h-3 cursor-ew-resize touch-none rounded-full"
          style={{ background: 'linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)' }}
          onPointerDown={(e) => dragArea(e, (x) => commit({ ...hsv, h: x * 360 }))}
          onKeyDown={(e) => {
            const step = e.shiftKey ? 10 : 1
            const d = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step }[e.key]
            if (d === undefined) return
            e.preventDefault()
            commit({ ...hsv, h: Math.min(360, Math.max(0, hsv.h + d)) })
          }}
        >
          <span
            aria-hidden
            className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgb(0_0_0/0.3)]"
            style={{ left: `${(hsv.h / 360) * 100}%`, background: `hsl(${hsv.h} 100% 50%)` }}
          />
        </div>

        <div className="flex items-center gap-2">
          {window.EyeDropper && (
            <button
              type="button"
              title="Pick from screen"
              aria-label="Pick from screen"
              onClick={pickFromScreen}
              className="pressable grid h-9 w-9 shrink-0 place-items-center rounded-lg text-fg-muted hover:bg-bg-sunken hover:text-fg"
            >
              <Icon name="pipette" size={16} />
            </button>
          )}
          <label className="flex h-9 min-w-0 flex-1 items-center gap-1 rounded-lg bg-bg-sunken px-2.5 text-sm focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent">
            <span className="text-fg-muted">#</span>
            <input
              aria-label="Hex color"
              spellCheck={false}
              maxLength={7}
              value={draft ?? hex.slice(1)}
              onChange={(e) => {
                const text = e.target.value.replace(/^#/, '')
                setDraft(text)
                if (/^[0-9a-f]{6}$/i.test(text)) {
                  const next = hexToHsv(`#${text}`)
                  setHsv(next)
                  onChange(hsvToHex(next))
                }
              }}
              onBlur={() => setDraft(null)}
              className="w-full min-w-0 bg-transparent font-mono uppercase outline-none"
            />
          </label>
          <span aria-hidden className="h-9 w-9 shrink-0 rounded-lg image-outline" style={{ background: hex }} />
        </div>
      </div>
    </>
  )
}

function clamp01(n: number) {
  return Math.min(1, Math.max(0, n))
}

function hexToHsv(hex: string): Hsv {
  const n = parseInt(hex.slice(1), 16)
  const r = ((n >> 16) & 255) / 255
  const g = ((n >> 8) & 255) / 255
  const b = (n & 255) / 255
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  let h = 0
  if (d) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
  }
  return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max }
}

function hsvToHex({ h, s, v }: Hsv): string {
  const f = (k: number) => {
    const x = (k + h / 60) % 6
    return v - v * s * Math.max(0, Math.min(x, 4 - x, 1))
  }
  return `#${[f(5), f(3), f(1)].map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('')}`
}
