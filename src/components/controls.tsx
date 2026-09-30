import type { ReactNode } from 'react'

export function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 py-5 first:pt-0">
      <div className="flex min-h-6 items-center justify-between gap-3">
        <h2 className="text-sm font-medium">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  )
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex min-h-10 cursor-pointer items-center justify-between gap-3 text-sm text-fg-muted">
      {label}
      <span className="relative inline-flex">
        <input
          type="checkbox"
          role="switch"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="peer absolute inset-0 cursor-pointer opacity-0"
        />
        <span
          aria-hidden
          className="h-5 w-9 rounded-full bg-border transition-colors duration-150 peer-checked:bg-accent peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent"
        />
        <span
          aria-hidden
          className="pointer-events-none absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-150 ease-out peer-checked:translate-x-4"
        />
      </span>
    </label>
  )
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string; title?: string }[]
  label: string
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-[10px] bg-bg-sunken p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={`pressable h-9 flex-1 rounded-lg px-2 text-sm ${
            value === o.value ? 'bg-bg-elevated font-medium shadow-sm' : 'text-fg-muted hover:text-fg'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`pressable h-8 rounded-lg px-3 text-sm tabular-nums ${
        active ? 'bg-accent-soft font-medium text-accent' : 'bg-bg-sunken text-fg-muted hover:text-fg'
      }`}
    >
      {children}
    </button>
  )
}

export function NumberInput({
  label,
  value,
  min,
  max,
  onChange,
  suffix,
  ariaLabel,
  disabled,
  className = '',
}: {
  label: string
  /** Full name for screen readers when the visible label is abbreviated. */
  ariaLabel?: string
  value: number
  min: number
  max: number
  onChange: (v: number) => void
  suffix?: string
  disabled?: boolean
  className?: string
}) {
  return (
    <label className={`flex h-10 min-w-0 items-center gap-2 rounded-[10px] bg-bg-sunken px-3 text-sm focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent has-disabled:opacity-50 ${className}`}>
      <span className="text-fg-muted">{label}</span>
      <input
        type="number"
        inputMode="numeric"
        aria-label={ariaLabel}
        disabled={disabled}
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Math.min(max, Math.max(0, Number(e.target.value))))}
        className="w-full min-w-0 bg-transparent text-right tabular-nums outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
      />
      {suffix && <span className="text-fg-muted">{suffix}</span>}
    </label>
  )
}

/** Looks like NumberInput, but the whole field is a slider: drag across it (or use arrow keys) to set the value. */
export function SliderInput({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  suffix,
  className = '',
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
  suffix?: string
  className?: string
}) {
  const pct = ((value - min) / (max - min)) * 100
  return (
    <label className={`relative flex h-10 min-w-0 cursor-ew-resize items-center gap-2 overflow-hidden rounded-[10px] bg-bg-sunken px-3 text-sm focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent ${className}`}>
      <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0 bg-accent-soft" style={{ width: `${pct}%` }} />
      <span className="relative text-fg-muted">{label}</span>
      <span className="relative ml-auto tabular-nums">{value}</span>
      {suffix && <span className="relative text-fg-muted">{suffix}</span>}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="absolute inset-0 h-full w-full cursor-ew-resize opacity-0"
      />
    </label>
  )
}
