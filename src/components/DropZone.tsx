import { Icon } from './Icon'

export function EmptyState({ onBrowse }: { onBrowse: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-5 px-4 py-10">
      <button
        type="button"
        onClick={onBrowse}
        className="pressable group flex w-full max-w-xl flex-col items-center gap-4 rounded-3xl border-2 border-dashed border-border bg-bg-elevated px-6 py-16 text-center hover:border-accent sm:py-24"
      >
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-soft text-accent">
          <Icon name="image" size={26} />
        </span>
        <span className="flex flex-col gap-1.5">
          <span className="text-xl font-semibold tracking-tight text-balance">Drop an image to remove its background</span>
          <span className="text-sm text-fg-muted">
            or <span className="font-medium text-accent group-hover:underline">browse</span>, or paste with Ctrl+V
          </span>
        </span>
      </button>
      <p className="text-sm text-fg-muted">Processed on your device. Nothing is uploaded.</p>
    </div>
  )
}

export function DragOverlay() {
  return (
    <div className="pointer-events-none fixed inset-3 z-40 flex items-center justify-center rounded-3xl border-2 border-dashed border-accent bg-accent-soft backdrop-blur-sm">
      <p className="rounded-full bg-bg-elevated px-5 py-2.5 text-sm font-medium shadow-float">Drop to open</p>
    </div>
  )
}
