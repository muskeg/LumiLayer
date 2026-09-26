import { absorption, lightness, linearToOklab, linearToSrgb, luminance, srgbToLinear, hexToRgb } from './color';
import type { Filament, RGB } from './color';

export interface LithoParams {
  pixelMm: number;
  minThickness: number;
  maxThickness: number;
  frameThickness: number;
  colorLayers: number;
  layerHeight: number;
  colorPriority: number;
  /** Diffuse color error between neighbouring pixels to hide banding. */
  dither?: boolean;
  /** Color stacks are chosen per block of this many pixels (square). */
  colorCellPx?: number;
  /** [0] is the base (lithophane body + filler), [1..3] are optional color filaments. */
  filaments: Filament[];
}

export interface Light {
  color: string;
  exposure: number;
}

export interface Solver {
  combos: Uint8Array;
  trans: Float32Array;
  lumas: Float32Array;
  invCbrtLumas: Float32Array;
  labs: Float32Array;
  wC: number;
  lut: Uint16Array;
  a0: RGB;
  a0Y: number;
  smin: number;
  fmin: number;
}

export interface LithoResult {
  cols: number;
  rows: number;
  pixelMm: number;
  layerHeight: number;
  colorLayers: number;
  /** Layers of filament 1..3 per pixel, stacked in that order from the front face. */
  counts: Uint8Array;
  /** Body thickness (mm) behind the color slab. */
  body: Float32Array;
  sim: Uint8ClampedArray;
  front: Uint8ClampedArray;
  filaments: Filament[];
}

const BINS = 32;

export function colorSlabThickness(p: Pick<LithoParams, 'colorLayers' | 'layerHeight'>) {
  return Math.max(0, Math.round(p.colorLayers)) * p.layerHeight;
}

function enumerateCombos(active: number[], n: number): Uint8Array {
  const out: number[] = [];
  const cur = [0, 0, 0];
  const rec = (idx: number, remaining: number) => {
    if (idx === active.length) {
      out.push(cur[0], cur[1], cur[2]);
      return;
    }
    for (let c = 0; c <= remaining; c++) {
      cur[active[idx]] = c;
      rec(idx + 1, remaining - c);
    }
    cur[active[idx]] = 0;
  };
  rec(0, n);
  return Uint8Array.from(out);
}

/** Relative target luminance: log-linear in L*, so perceived tone maps evenly onto body thickness. */
function targetFor(sr: number, sg: number, sb: number, logSmin: number, out: number[]) {
  const r = srgbToLinear(sr), g = srgbToLinear(sg), b = srgbToLinear(sb);
  const y = luminance(r, g, b);
  const yt = Math.exp((1 - lightness(y)) * logSmin);
  if (y > 1e-5) {
    const k = yt / y;
    out[0] = r * k; out[1] = g * k; out[2] = b * k;
  } else {
    out[0] = out[1] = out[2] = yt;
  }
  return yt;
}

export function buildSolver(p: LithoParams): Solver {
  const n = Math.max(0, Math.round(p.colorLayers));
  const lh = p.layerHeight;
  const a0 = absorption(p.filaments[0]);
  const a0Y = Math.max(1e-4, luminance(a0[0], a0[1], a0[2]));
  const colorAbs = [1, 2, 3].map((i) => (p.filaments[i] ? absorption(p.filaments[i]) : a0));
  const active = [0, 1, 2].filter((k) => p.filaments[k + 1]?.enabled);
  const combos = enumerateCombos(active, n);
  const count = combos.length / 3;

  // Transmission of each color stack relative to an all-base stack of the same height.
  const trans = new Float32Array(count * 3);
  const lumas = new Float32Array(count);
  const labs = new Float32Array(count * 3);
  for (let c = 0; c < count; c++) {
    for (let ch = 0; ch < 3; ch++) {
      let od = 0;
      for (let k = 0; k < 3; k++) od += combos[c * 3 + k] * lh * (colorAbs[k][ch] - a0[ch]);
      trans[c * 3 + ch] = Math.exp(-od);
    }
    lumas[c] = luminance(trans[c * 3], trans[c * 3 + 1], trans[c * 3 + 2]);
    linearToOklab(trans[c * 3], trans[c * 3 + 1], trans[c * 3 + 2], labs, c * 3);
  }

  const smin = Math.exp(-Math.max(0, p.maxThickness - p.minThickness) * a0Y);
  const logSmin = Math.log(smin);
  const wC = Math.max(0, p.colorPriority);
  const lut = new Uint16Array(BINS * BINS * BINS);
  const invCbrtLumas = lumas.map((l) => 1 / Math.cbrt(Math.max(l, 1e-6)));
  const solver: Solver = { combos, trans, lumas, invCbrtLumas, labs, wC, lut, a0, a0Y, smin, fmin: Math.cbrt(smin) };
  const target = [0, 0, 0];
  const tLab = [0, 0, 0];
  for (let bi = 0; bi < BINS; bi++)
    for (let gi = 0; gi < BINS; gi++)
      for (let ri = 0; ri < BINS; ri++) {
        const yt = targetFor(ri / (BINS - 1), gi / (BINS - 1), bi / (BINS - 1), logSmin, target);
        linearToOklab(target[0], target[1], target[2], tLab);
        lut[(bi * BINS + gi) * BINS + ri] = bestCombo(solver, Math.cbrt(yt), tLab);
      }
  return solver;
}

/** Oklab scale factor of a combo once the body thickness matches target luminance. */
const labScale = (s: Solver, c: number, cbrtYt: number) => Math.min(1, Math.max(s.fmin, cbrtYt * s.invCbrtLumas[c]));

function bestCombo(s: Solver, cbrtYt: number, tLab: ArrayLike<number>) {
  const { labs, wC } = s;
  let best = 0;
  let bestErr = Infinity;
  for (let c = 0; c < s.lumas.length; c++) {
    // A neutral body scales linear RGB by s, which scales Oklab by cbrt(s).
    const f = labScale(s, c, cbrtYt);
    const dL = f * labs[c * 3] - tLab[0];
    const da = f * labs[c * 3 + 1] - tLab[1];
    const db = f * labs[c * 3 + 2] - tLab[2];
    const err = dL * dL + wC * (da * da + db * db);
    if (err < bestErr) {
      bestErr = err;
      best = c;
    }
  }
  return best;
}

/**
 * Turn an adjusted sRGB image (floats 0..1, RGB triplets) into per-pixel
 * color layer counts and body thickness, plus simulated previews.
 */
export function solve(
  srgb: Float32Array,
  imgCols: number,
  imgRows: number,
  borderPx: number,
  p: LithoParams,
  solver: Solver,
  light: Light,
): LithoResult {
  const cols = imgCols + 2 * borderPx;
  const rows = imgRows + 2 * borderPx;
  const total = cols * rows;
  const counts = new Uint8Array(total * 3);
  const body = new Float32Array(total);
  const sim = new Uint8ClampedArray(total * 4);
  const front = new Uint8ClampedArray(total * 4);
  const { combos, trans, lumas, labs, lut, a0, a0Y, smin } = solver;
  const logSmin = Math.log(smin);
  const slab = colorSlabThickness(p);
  const tmin = p.minThickness;
  const tmax = Math.max(tmin, p.maxThickness);
  const frameBody = Math.max(tmin, p.frameThickness - slab);
  const lc = hexToRgb(light.color).map(srgbToLinear);
  const frontColors = p.filaments.map((f) => hexToRgb(f.color));
  const target = [0, 0, 0];
  const tLab = [0, 0, 0];

  // Pass 1: pick one color stack per color cell (block of pixels).
  const bs = Math.max(1, Math.round(p.colorCellPx ?? 1));
  const bCols = Math.ceil(imgCols / bs);
  const bRows = Math.ceil(imgRows / bs);
  const cellCombo = new Uint16Array(bCols * bRows);
  // Floyd-Steinberg error rows (Oklab), padded by one cell on each side.
  let errCur = new Float32Array((bCols + 2) * 3);
  let errNext = new Float32Array((bCols + 2) * 3);
  for (let by = 0; by < bRows; by++) {
    [errCur, errNext] = [errNext, errCur];
    errNext.fill(0);
    for (let bx = 0; bx < bCols; bx++) {
      let sr = 0, sg = 0, sb = 0, n = 0;
      for (let iy = by * bs; iy < Math.min(imgRows, (by + 1) * bs); iy++)
        for (let ix = bx * bs; ix < Math.min(imgCols, (bx + 1) * bs); ix++) {
          const si = (iy * imgCols + ix) * 3;
          sr += srgb[si]; sg += srgb[si + 1]; sb += srgb[si + 2];
          n++;
        }
      sr /= n; sg /= n; sb /= n;
      let combo: number;
      if (p.dither) {
        const yt = targetFor(sr, sg, sb, logSmin, target);
        linearToOklab(target[0], target[1], target[2], tLab);
        const e = (bx + 1) * 3;
        for (let ch = 0; ch < 3; ch++) tLab[ch] += errCur[e + ch];
        combo = bestCombo(solver, Math.cbrt(yt), tLab);
        const f = labScale(solver, combo, Math.cbrt(yt));
        for (let ch = 0; ch < 3; ch++) {
          // Clamp so unreachable (out-of-gamut) colors don't smear error across the image.
          const d = Math.max(-0.06, Math.min(0.06, tLab[ch] - f * labs[combo * 3 + ch]));
          errCur[e + 3 + ch] += (d * 7) / 16;
          errNext[e - 3 + ch] += (d * 3) / 16;
          errNext[e + ch] += (d * 5) / 16;
          errNext[e + 3 + ch] += d / 16;
        }
      } else {
        const q = (v: number) => Math.min(BINS - 1, Math.max(0, Math.round(v * (BINS - 1))));
        combo = lut[(q(sb) * BINS + q(sg)) * BINS + q(sr)];
      }
      cellCombo[by * bCols + bx] = combo;
    }
  }

  // Pass 2: per-pixel body thickness compensates the cell's color stack at full resolution.
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      const ix = x - borderPx;
      const iy = y - borderPx;
      let combo = 0;
      let t: number;
      if (ix < 0 || iy < 0 || ix >= imgCols || iy >= imgRows) {
        t = frameBody;
      } else {
        const si = (iy * imgCols + ix) * 3;
        const yt = targetFor(srgb[si], srgb[si + 1], srgb[si + 2], logSmin, target);
        combo = cellCombo[((iy / bs) | 0) * bCols + ((ix / bs) | 0)];
        const s = Math.min(1, Math.max(smin, yt / Math.max(lumas[combo], 1e-6)));
        t = Math.min(tmax, tmin - Math.log(s) / a0Y);
      }
      counts[i * 3] = combos[combo * 3];
      counts[i * 3 + 1] = combos[combo * 3 + 1];
      counts[i * 3 + 2] = combos[combo * 3 + 2];
      body[i] = t;

      const dt = t - tmin;
      for (let ch = 0; ch < 3; ch++) {
        const v = trans[combo * 3 + ch] * Math.exp(-dt * a0[ch]) * lc[ch] * light.exposure;
        sim[i * 4 + ch] = linearToSrgb(Math.min(1, v)) * 255;
      }
      sim[i * 4 + 3] = 255;

      let fi = 0;
      for (let k = 0; k < 3; k++) if (combos[combo * 3 + k] > 0) { fi = k + 1; break; }
      const fc = frontColors[fi];
      front[i * 4] = fc[0] * 255;
      front[i * 4 + 1] = fc[1] * 255;
      front[i * 4 + 2] = fc[2] * 255;
      front[i * 4 + 3] = 255;
    }
  }

  return {
    cols,
    rows,
    pixelMm: p.pixelMm,
    layerHeight: p.layerHeight,
    colorLayers: Math.max(0, Math.round(p.colorLayers)),
    counts,
    body,
    sim,
    front,
    filaments: p.filaments,
  };
}
