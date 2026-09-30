# BG Remover — interface system

Decisions already made. Hold to these when changing the UI; update this file when a decision changes.

## Direction

- **Who / what:** someone with one photo who wants a clean cut-out, fast, usually without reading anything. Drop → wait → (optionally fix) → download.
- **Feel:** a quiet workbench. The image is the focal point on every screen; chrome recedes. Calm, not playful.
- **One primary action per view:** Download on the main screen, Done in the refine editor. Everything else is secondary or one level deeper.
- **Progressive disclosure:** show the common path first. Model choice is a small "Quality" select (Balanced default); brush softness lives in a popover.

## Color

Tokens in `src/index.css`, mirrored into Tailwind via `@theme inline`. One warm-neutral gray family (hue 90) plus one accent (hue 262). Never hardcode grays or hex in components.

| Token | Use |
| --- | --- |
| `bg` | page / panel background |
| `bg-sunken` | stage behind the image, inputs, segmented tracks, chips (inputs are darker = inset) |
| `bg-elevated` | selected segment, floating surfaces, empty-state drop area |
| `fg` / `fg-muted` | primary text / labels, secondary text, idle icons |
| `accent` / `accent-fg` / `accent-soft` | primary buttons, focus rings, active chips, switches — and nothing decorative |
| `border` | structural hairlines only (header, panel edge, section dividers) |
| `danger` | errors |

Semantic exceptions (they carry meaning, so they are not a second accent):
- Refine brush modes: erase `#f43f5e`, restore `#22c55e`.
- Removed-area tint: `#f43f5e` at 55% over the original, drawn at 60% opacity.

## Depth

- **Borders for structure, shadow for elevation.** Hairline `border` separates regions; floating things (action bar, progress pill, editor chrome) use `shadow-float`.
- **Floating chrome over the canvas uses `.material`**: translucent `bg-elevated` (78%), `backdrop-filter: blur(20px) saturate(180%)`, `shadow-float` + inset 1px white/6% edge. Falls back to solid under `prefers-reduced-transparency`.
- Never stack a translucent surface on another translucent surface (popovers over the dock are the only case; keep them small).
- Images get `.image-outline` (1px, pure black/white at 10%) and sit on `.checker` so transparency is visible.

## Typography

- Geist 400 / 500 / 600 from Google Fonts, system-ui fallback. Antialiased.
- Base `text-sm` (14px) for all UI; `text-xs` for meta (zoom %, hints); `text-xl` semibold `tracking-tight` + `text-balance` only for the empty-state headline.
- Hierarchy from weight and color before size: section titles `text-sm font-medium`, labels `text-fg-muted`.
- Sentence case everywhere. No all-caps labels.
- `tabular-nums` on every changing number (dimensions, file size, %, px).

## Spacing & sizing

- 4px base; Tailwind scale only.
- Options column: 340px wide on desktop, `px-5`; sections separated by `divide-y` with `py-5`.
- Control heights: **40px (`h-10`)** default for buttons, inputs, switches rows, segments in the editor; 36px (`h-9`) segments in the options column; 32px (`h-8`) chips, swatches and small icon buttons; **48px (`h-12`)** for the primary Download button. Top bars are 56px (`h-14`).
- Hit areas ≥ 40px; small visible controls (32px) only on desktop-density clusters.

## Radius (concentric)

| Element | Radius |
| --- | --- |
| Buttons, inputs, segments | `rounded-[10px]` |
| Small buttons, chips, segment items inside a track | `rounded-lg` (8px) |
| Floating bars, segmented tracks, primary button | `rounded-xl` / `rounded-2xl` |
| Empty-state drop area, drag overlay | `rounded-3xl` |
| Swatches, switches, progress bars | `rounded-full` |

Outer radius = inner radius + padding when nesting (e.g. `p-0.5` track at `rounded-xl` around `rounded-[10px]` items).

## Motion

- Buttons get `.pressable`: `scale: 0.96` on `:active`, 150ms `cubic-bezier(0.2, 0, 0, 1)`, only named properties (never `transition: all`).
- Enter: `.editor-in` (opacity + scale 0.985, 220ms) for the editor; `.rise-in` (opacity + 6px rise, 200ms) for tips, popovers, labels. Ease-out `cubic-bezier(0.23, 1, 0.32, 1)`.
- Loading: `.scanning` — the original image dimmed with a band sweeping down (mask animation), plus a progress card. No spinners.
- Direct manipulation is never animated: painting, dragging, pinching and wheel zoom track the pointer 1:1. Only programmatic view changes (fit, ± zoom, settle-back after panning off screen) animate, 280ms.
- `prefers-reduced-motion`: keep opacity, drop movement and the scan sweep.

## Component patterns

- **Section** — title row (`text-sm font-medium`, optional right-side control) + content, `gap-3`.
- **Switch** — full-row label, `min-h-10`, 36×20 track, accent when on.
- **Segmented** — `bg-sunken` track `p-0.5` `rounded-[10px]`; selected item `bg-elevated` + `shadow-sm` + `font-medium`; `role="radiogroup"`.
- **Chip** — 32px, `bg-sunken` idle, `accent-soft` + accent text when active, `aria-pressed`.
- **NumberInput** — 40px inset field on `bg-sunken`, inline muted label, right-aligned tabular value, focus ring on the wrapper; abbreviated labels get an `ariaLabel`.
- **Floating action bar** (stage) — `bg-elevated` `rounded-2xl` `p-1` `shadow-float`, 40px items; swaps in place for the progress card and error card (same position).
- **Refine editor** — full-bleed canvas; `.material` top bar (Cancel · title · undo/redo/start over · Compare · Done); centered brush dock (mode segmented · size · softness popover · Removed toggle); view cluster bottom-right on desktop, fit % inside the dock on phones.
- **Icons** — Lucide paths in `src/components/Icon.tsx`, 1.75 stroke, `currentColor`, 16px in dense controls, 18px in bars. One set only.

## Copy

- Plain and short. Buttons are verbs or states: "Download", "New image", "Refine edges", "Try again", "Done".
- Say it once: privacy note lives only on the empty state.
- Errors are direct: what failed, then a way forward.
