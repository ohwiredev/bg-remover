// Edge refinement for a cut-out, as pure functions over pixel arrays so it can
// run in a worker. Alpha is Float32 in 0–1; images are RGBA Uint8.
//
// The segmentation model works at ~1024px and its mask is upscaled, so edges
// are soft and don't follow the real detail. Two fixes:
// - A fast guided filter (He & Sun 2015) fits alpha as a local linear function
//   of the photo's colors. The fit is done at low resolution but applied with
//   the full-resolution photo, which puts back edge detail the model never saw.
// - Blur-Fusion foreground estimation (Forte & Pitié 2021) recovers the
//   subject's own colors in semi-transparent pixels, so the old background
//   doesn't show through as a halo.

export type EdgeSettings = {
  /** Snap the mask to edges in the photo. */
  snap: boolean
  /** Remove background color bleeding into semi-transparent edge pixels. */
  decontaminate: boolean
  /** Grow (+) or shrink (−) the subject, in image pixels. */
  shift: number
  /** Soften the edge, in image pixels. */
  feather: number
  /** 0–100: push soft edges toward a hard cut. */
  contrast: number
  /** Cut along the mask's midline with a one-pixel anti-aliased edge, for solid objects. */
  hard: boolean
}

export const DEFAULT_EDGES: EdgeSettings = { snap: true, decontaminate: true, shift: 0, feather: 0, contrast: 0, hard: false }

export function isIdentity(s: EdgeSettings): boolean {
  return !s.snap && !s.decontaminate && s.shift === 0 && s.feather === 0 && s.contrast === 0 && !s.hard
}

/** Low-resolution work is done at about the model's own resolution. */
const WORK_SIZE = 1024
export type GuidedOptions = {
  /** Window radius, in low-res pixels. */
  radius: number
  /** Regularization in 0–1 color units; higher follows the photo's colors less. */
  eps: number
  /** How far past the model's own soft edge the filter may change alpha, in low-res pixels. */
  band: number
}
export const GUIDED_DEFAULTS: GuidedOptions = { radius: 6, eps: 1e-4, band: 2 }
/**
 * Decontamination only applies within this many low-res pixels of both solid
 * subject and clear background: a real edge. Wide areas the model left
 * half-transparent (a cloud of tiny flowers, say) have unreliable alpha, and
 * "fixing" their colors would erase them.
 */
const DECON_REACH = 3
/** Blur-Fusion radii: the coarse pass in low-res pixels, the fine pass scaled to full res. */
const BF_COARSE_RADIUS = 45
const BF_FINE_RADIUS = 3

type Grid = { w: number; h: number; k: number; lw: number; lh: number }

function grid(w: number, h: number): Grid {
  const k = Math.max(1, Math.ceil(Math.max(w, h) / WORK_SIZE))
  return { w, h, k, lw: Math.ceil(w / k), lh: Math.ceil(h / k) }
}

/** Area-averages `value(i)` over k×k blocks. */
function downsample({ w, h, k, lw, lh }: Grid, value: (i: number) => number): Float32Array {
  const sum = new Float64Array(lw * lh)
  for (let y = 0; y < h; y++) {
    const lrow = ((y / k) | 0) * lw
    const row = y * w
    for (let x = 0; x < w; x++) sum[lrow + ((x / k) | 0)] += value(row + x)
  }
  const out = new Float32Array(lw * lh)
  for (let ly = 0; ly < lh; ly++) {
    const bh = Math.min(k, h - ly * k)
    for (let lx = 0; lx < lw; lx++) {
      const i = ly * lw + lx
      out[i] = sum[i] / (bh * Math.min(k, w - lx * k))
    }
  }
  return out
}

/** Bilinear lookup tables from full-res pixel centers into the low-res grid. */
function upsampler({ w, h, k, lw, lh }: Grid) {
  const axis = (n: number, ln: number) => {
    const i0 = new Int32Array(n)
    const i1 = new Int32Array(n)
    const t = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const f = Math.min(ln - 1, Math.max(0, (i + 0.5) / k - 0.5))
      i0[i] = Math.floor(f)
      i1[i] = Math.min(ln - 1, i0[i] + 1)
      t[i] = f - i0[i]
    }
    return { i0, i1, t }
  }
  return { x: axis(w, lw), y: axis(h, lh), lw }
}

function sample(m: Float32Array, r0: number, r1: number, ty: number, x0: number, x1: number, tx: number): number {
  const a = m[r0 + x0] + (m[r0 + x1] - m[r0 + x0]) * tx
  const b = m[r1 + x0] + (m[r1 + x1] - m[r1 + x0]) * tx
  return a + (b - a) * ty
}

/**
 * Mean over a (2r+1)² window, clipped at the borders. `out` may be `src`;
 * `tmp` must be a separate array of the same size.
 */
export function boxBlur(src: Float32Array, w: number, h: number, r: number, out: Float32Array, tmp: Float32Array) {
  for (let y = 0; y < h; y++) {
    const row = y * w
    let sum = 0
    for (let x = 0; x <= Math.min(r, w - 1); x++) sum += src[row + x]
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / (Math.min(x + r, w - 1) - Math.max(x - r, 0) + 1)
      if (x + r + 1 < w) sum += src[row + x + r + 1]
      if (x - r >= 0) sum -= src[row + x - r]
    }
  }
  const acc = new Float64Array(w)
  for (let y = 0; y <= Math.min(r, h - 1); y++) {
    const row = y * w
    for (let x = 0; x < w; x++) acc[x] += tmp[row + x]
  }
  for (let y = 0; y < h; y++) {
    const row = y * w
    const count = Math.min(y + r, h - 1) - Math.max(y - r, 0) + 1
    for (let x = 0; x < w; x++) out[row + x] = acc[x] / count
    if (y + r + 1 < h) {
      const add = (y + r + 1) * w
      for (let x = 0; x < w; x++) acc[x] += tmp[add + x]
    }
    if (y - r >= 0) {
      const sub = (y - r) * w
      for (let x = 0; x < w; x++) acc[x] -= tmp[sub + x]
    }
  }
}

/** Running min or max over a 2r+1 window (van Herk / Gil–Werman), `n` values from `src` into `out`. */
function minMax1D(src: Float32Array, n: number, r: number, max: boolean, out: Float32Array, g: Float32Array, hh: Float32Array) {
  const k = 2 * r + 1
  const m = n + 2 * r
  const pad = max ? -Infinity : Infinity
  for (let j = 0; j < m; j++) {
    const v = j < r || j >= n + r ? pad : src[j - r]
    g[j] = j % k === 0 ? v : max ? Math.max(g[j - 1], v) : Math.min(g[j - 1], v)
  }
  for (let j = m - 1; j >= 0; j--) {
    const v = j < r || j >= n + r ? pad : src[j - r]
    hh[j] = j % k === k - 1 || j === m - 1 ? v : max ? Math.max(hh[j + 1], v) : Math.min(hh[j + 1], v)
  }
  for (let y = 0; y < n; y++) out[y] = max ? Math.max(hh[y], g[y + 2 * r]) : Math.min(hh[y], g[y + 2 * r])
}

/** Grayscale dilation (max) or erosion (min) with a square window, in place. */
export function morph(a: Float32Array, w: number, h: number, r: number, max: boolean) {
  const n = Math.max(w, h)
  const line = new Float32Array(n)
  const res = new Float32Array(n)
  const g = new Float32Array(n + 2 * r)
  const hh = new Float32Array(n + 2 * r)
  for (let y = 0; y < h; y++) {
    const row = a.subarray(y * w, y * w + w)
    minMax1D(row, w, r, max, res, g, hh)
    row.set(res.subarray(0, w))
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) line[y] = a[y * w + x]
    minMax1D(line, h, r, max, res, g, hh)
    for (let y = 0; y < h; y++) a[y * w + x] = res[y]
  }
}

/**
 * Fast color guided filter: refines `alpha` using `rgba` as the guide.
 * Returns a new full-resolution alpha.
 */
export function guidedAlpha(
  rgba: Uint8ClampedArray,
  alpha: Float32Array,
  w: number,
  h: number,
  { radius, eps, band }: GuidedOptions = GUIDED_DEFAULTS,
): Float32Array {
  const gr = grid(w, h)
  const { lw, lh } = gr
  const ln = lw * lh
  const s = 1 / 255
  const I = [0, 1, 2].map((c) => downsample(gr, (i) => rgba[i * 4 + c] * s))
  const p = downsample(gr, (i) => alpha[i])

  const tmp = new Float32Array(ln)
  const mean = (src: Float32Array) => {
    const out = new Float32Array(ln)
    boxBlur(src, lw, lh, radius, out, tmp)
    return out
  }
  const meanProduct = (a: Float32Array, b: Float32Array) => {
    const out = new Float32Array(ln)
    for (let i = 0; i < ln; i++) out[i] = a[i] * b[i]
    boxBlur(out, lw, lh, radius, out, tmp)
    return out
  }
  const [r, g, b] = I
  const mr = mean(r), mg = mean(g), mb = mean(b), mp = mean(p)
  const rp = meanProduct(r, p), gp = meanProduct(g, p), bp = meanProduct(b, p)
  const rr = meanProduct(r, r), rg = meanProduct(r, g), rb = meanProduct(r, b)
  const gg = meanProduct(g, g), gb = meanProduct(g, b), bb = meanProduct(b, b)
  const pp = meanProduct(p, p)

  // Solve (Σ + εI) a = cov(I, p) per pixel; reuse the product buffers for the coefficients.
  // Also record how much of the mask's variation the colors explain (R²). Where
  // subject and background look alike it's low, and the filter would only blur.
  const ar = rp, ag = gp, ab = bp, bias = rr
  const fit = pp
  for (let i = 0; i < ln; i++) {
    const vrr = rr[i] - mr[i] * mr[i] + eps
    const vrg = rg[i] - mr[i] * mg[i]
    const vrb = rb[i] - mr[i] * mb[i]
    const vgg = gg[i] - mg[i] * mg[i] + eps
    const vgb = gb[i] - mg[i] * mb[i]
    const vbb = bb[i] - mb[i] * mb[i] + eps
    const cr = rp[i] - mr[i] * mp[i]
    const cg = gp[i] - mg[i] * mp[i]
    const cb = bp[i] - mb[i] * mp[i]
    const i00 = vgg * vbb - vgb * vgb
    const i01 = vrb * vgb - vrg * vbb
    const i02 = vrg * vgb - vrb * vgg
    const i11 = vrr * vbb - vrb * vrb
    const i12 = vrg * vrb - vrr * vgb
    const i22 = vrr * vgg - vrg * vrg
    const inv = 1 / (vrr * i00 + vrg * i01 + vrb * i02)
    const a0 = (i00 * cr + i01 * cg + i02 * cb) * inv
    const a1 = (i01 * cr + i11 * cg + i12 * cb) * inv
    const a2 = (i02 * cr + i12 * cg + i22 * cb) * inv
    const vp = pp[i] - mp[i] * mp[i]
    fit[i] = vp > 1e-4 ? Math.min(1, Math.max(0, (a0 * cr + a1 * cg + a2 * cb) / vp)) : 1
    ar[i] = a0
    ag[i] = a1
    ab[i] = a2
    bias[i] = mp[i] - a0 * mr[i] - a1 * mg[i] - a2 * mb[i]
  }
  for (const m of [ar, ag, ab, bias, fit]) boxBlur(m, lw, lh, radius, m, tmp)

  // Only let the filter act near the model's uncertain edge. Elsewhere, where
  // subject and background share colors, it would eat into a confident mask.
  const weight = new Float32Array(ln)
  for (let i = 0; i < ln; i++) weight[i] = p[i] > 0.02 && p[i] < 0.98 ? 1 : 0
  if (band > 0) {
    morph(weight, lw, lh, band, true)
    boxBlur(weight, lw, lh, Math.max(1, band >> 1), weight, tmp)
  }
  for (let i = 0; i < ln; i++) weight[i] *= fit[i]

  // q = a·I + b at full resolution. Values within a few % of 0 or 1 are
  // texture noise, not transparency, so they're snapped.
  const up = upsampler(gr)
  const out = new Float32Array(w * h)
  const lo = 0.04
  const scale = 1 / (1 - 2 * lo)
  for (let y = 0; y < h; y++) {
    const r0 = up.y.i0[y] * lw, r1 = up.y.i1[y] * lw, ty = up.y.t[y]
    for (let x = 0; x < w; x++) {
      const x0 = up.x.i0[x], x1 = up.x.i1[x], tx = up.x.t[x]
      const i = y * w + x
      const wt = sample(weight, r0, r1, ty, x0, x1, tx)
      if (wt <= 0) {
        out[i] = alpha[i]
        continue
      }
      const q =
        sample(ar, r0, r1, ty, x0, x1, tx) * rgba[i * 4] * s +
        sample(ag, r0, r1, ty, x0, x1, tx) * rgba[i * 4 + 1] * s +
        sample(ab, r0, r1, ty, x0, x1, tx) * rgba[i * 4 + 2] * s +
        sample(bias, r0, r1, ty, x0, x1, tx)
      out[i] = alpha[i] + (Math.min(1, Math.max(0, (q - lo) * scale)) - alpha[i]) * wt
    }
  }
  return out
}

/**
 * Turns a soft edge into a crisp one-pixel anti-aliased edge along its 0.5
 * contour, in place. (α − 0.5) / |∇α| approximates the signed distance to that
 * contour in pixels, so the result is equally sharp whether the model's edge
 * was 2 or 10 pixels wide, and keeps its sub-pixel position. The gradient is
 * also taken on a lightly blurred copy so pixel noise doesn't make it jagged;
 * the steeper of the two wins, so an edge that's already narrow isn't over-sharpened.
 */
export function hardenEdge(alpha: Float32Array, w: number, h: number) {
  const src = alpha.slice()
  const g = new Float32Array(w * h)
  boxBlur(src, w, h, 1, g, new Float32Array(w * h))
  for (let y = 0; y < h; y++) {
    const up = Math.max(0, y - 1) * w, down = Math.min(h - 1, y + 1) * w, dy = (down - up) / w
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const a = alpha[i]
      if (a <= 0 || a >= 1) continue
      const left = Math.max(0, x - 1), right = Math.min(w - 1, x + 1)
      const gx = (g[y * w + right] - g[y * w + left]) / (right - left)
      const gy = (g[down + x] - g[up + x]) / dy
      const rx = (src[y * w + right] - src[y * w + left]) / (right - left)
      const ry = (src[down + x] - src[up + x]) / dy
      const mag = Math.max(Math.hypot(gx, gy), Math.hypot(rx, ry))
      alpha[i] = mag < 1e-6 ? (a >= 0.5 ? 1 : 0) : Math.min(1, Math.max(0, 0.5 + (a - 0.5) / mag))
    }
  }
}

/** Applies shift, hard edge, feather and contrast to `alpha` in place. */
export function adjustAlpha(alpha: Float32Array, w: number, h: number, s: Pick<EdgeSettings, 'shift' | 'feather' | 'contrast' | 'hard'>) {
  const shift = Math.round(s.shift)
  if (shift !== 0) morph(alpha, w, h, Math.abs(shift), shift > 0)
  if (s.hard) hardenEdge(alpha, w, h)
  if (s.feather > 0) {
    // Two box passes approximate a Gaussian.
    const r = Math.max(1, Math.round(s.feather / 2))
    const tmp = new Float32Array(w * h)
    boxBlur(alpha, w, h, r, alpha, tmp)
    boxBlur(alpha, w, h, r, alpha, tmp)
  }
  if (s.contrast > 0 && !s.hard) {
    const gain = 1 / (1 - Math.min(0.98, s.contrast / 100))
    for (let i = 0; i < alpha.length; i++) alpha[i] = Math.min(1, Math.max(0, (alpha[i] - 0.5) * gain + 0.5))
  }
}

/**
 * Writes the cut-out into `out`: foreground colors (decontaminated when asked)
 * with `alpha`. Fully transparent pixels are zeroed.
 */
export function compose(rgba: Uint8ClampedArray, alpha: Float32Array, w: number, h: number, decontaminate: boolean, out: Uint8ClampedArray) {
  for (let i = 0; i < w * h; i++) {
    const a = Math.round(alpha[i] * 255)
    const o = i * 4
    if (a === 0) {
      out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0
    } else {
      out[o] = rgba[o]
      out[o + 1] = rgba[o + 1]
      out[o + 2] = rgba[o + 2]
      out[o + 3] = a
    }
  }
  if (decontaminate) estimateForeground(rgba, alpha, w, h, out)
}

/**
 * Blur-Fusion foreground estimation, written into `out`'s RGB for pixels with
 * 0 < alpha < 1. The coarse pass runs on the low-res grid; the fine pass runs
 * at full resolution in strips to keep memory flat.
 */
function estimateForeground(rgba: Uint8ClampedArray, alpha: Float32Array, w: number, h: number, out: Uint8ClampedArray) {
  const gr = grid(w, h)
  const { lw, lh } = gr
  const ln = lw * lh
  const eps = 1e-5
  const s = 1 / 255

  const tmp = new Float32Array(ln)
  const bA = downsample(gr, (i) => alpha[i])

  const nearFg = new Float32Array(ln)
  const nearBg = new Float32Array(ln)
  for (let i = 0; i < ln; i++) {
    nearFg[i] = bA[i] > 0.95 ? 1 : 0
    nearBg[i] = bA[i] < 0.05 ? 1 : 0
  }
  morph(nearFg, lw, lh, DECON_REACH, true)
  morph(nearBg, lw, lh, DECON_REACH, true)
  const reach = nearFg
  for (let i = 0; i < ln; i++) reach[i] *= nearBg[i]
  boxBlur(reach, lw, lh, 1, reach, tmp)

  // Coarse pass with F = B = image: local mean colors of foreground and background.
  boxBlur(bA, lw, lh, BF_COARSE_RADIUS, bA, tmp)
  const coarseF: Float32Array[] = []
  const coarseB: Float32Array[] = []
  for (let c = 0; c < 3; c++) {
    const f = downsample(gr, (i) => rgba[i * 4 + c] * s * alpha[i])
    const b = downsample(gr, (i) => rgba[i * 4 + c] * s * (1 - alpha[i]))
    boxBlur(f, lw, lh, BF_COARSE_RADIUS, f, tmp)
    boxBlur(b, lw, lh, BF_COARSE_RADIUS, b, tmp)
    for (let i = 0; i < ln; i++) {
      f[i] /= bA[i] + eps
      b[i] /= 1 - bA[i] + eps
    }
    coarseF.push(f)
    coarseB.push(b)
  }

  // Fine pass: F₁ from the coarse estimate, then blur F₁·α and B·(1−α) locally.
  const up = upsampler(gr)
  const r = Math.max(2, Math.round(BF_FINE_RADIUS * gr.k))
  const strip = 128
  const cap = (strip + 2 * r) * w
  const sA = new Float32Array(cap)
  const sF = new Float32Array(cap)
  const sB = new Float32Array(cap)
  const sTmp = new Float32Array(cap)

  for (let y0 = 0; y0 < h; y0 += strip) {
    const y1 = Math.min(h, y0 + strip)
    // Skip strips with no partial alpha.
    let partial = false
    for (let i = y0 * w; i < y1 * w && !partial; i++) partial = alpha[i] > 0 && alpha[i] < 1
    if (!partial) continue

    const hy0 = Math.max(0, y0 - r)
    const hy1 = Math.min(h, y1 + r)
    const sh = hy1 - hy0
    const n = sh * w
    const A = sA.subarray(0, n), F = sF.subarray(0, n), B = sB.subarray(0, n), T = sTmp.subarray(0, n)
    A.set(alpha.subarray(hy0 * w, hy1 * w))
    boxBlur(A, w, sh, r, A, T)

    for (let c = 0; c < 3; c++) {
      const cf = coarseF[c], cb = coarseB[c]
      for (let y = hy0; y < hy1; y++) {
        const r0 = up.y.i0[y] * lw, r1 = up.y.i1[y] * lw, ty = up.y.t[y]
        for (let x = 0; x < w; x++) {
          const x0 = up.x.i0[x], x1 = up.x.i1[x], tx = up.x.t[x]
          const i = y * w + x
          const j = (y - hy0) * w + x
          const a = alpha[i]
          const fb = sample(cf, r0, r1, ty, x0, x1, tx)
          const bb = sample(cb, r0, r1, ty, x0, x1, tx)
          const f1 = Math.min(1, Math.max(0, fb + a * (rgba[i * 4 + c] * s - a * fb - (1 - a) * bb)))
          F[j] = f1 * a
          B[j] = bb * (1 - a)
        }
      }
      boxBlur(F, w, sh, r, F, T)
      boxBlur(B, w, sh, r, B, T)
      for (let y = y0; y < y1; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x
          const a = alpha[i]
          if (a <= 0 || a >= 1) continue
          const wt = sample(reach, up.y.i0[y] * lw, up.y.i1[y] * lw, up.y.t[y], up.x.i0[x], up.x.i1[x], up.x.t[x])
          if (wt <= 0) continue
          const j = (y - hy0) * w + x
          const fb = F[j] / (A[j] + eps)
          const bb = B[j] / (1 - A[j] + eps)
          const f = fb + a * (rgba[i * 4 + c] * s - a * fb - (1 - a) * bb)
          const I = rgba[i * 4 + c]
          out[i * 4 + c] = Math.round(I + (Math.min(1, Math.max(0, f)) * 255 - I) * wt)
        }
      }
    }
  }
}
