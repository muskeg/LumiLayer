import { linearToOklab, srgbToLinear } from '../color';
import { filamentOptics } from './km';
import type { StackLayer } from './model';

/** Hue/chroma error counts this much more than lightness error when matching colors. */
export const CHROMA_WEIGHT = 2;
/** Match errors closer than this are ties and go to the lower height, so float noise can't pick between equal colors. */
export const MATCH_TIE = 1e-6;

export type HeightMode = 'match' | 'luminance';

/** One band in layer units with the Kubelka–Munk reflectance and transmittance of a single layer (per channel). */
export interface BandOptics {
  r: number[];
  t: number[];
  start: number;
  end: number;
}

// Each band costs a scattering solve; Suggest re-resolves the same few profiles thousands of times.
const layerCache = new Map<string, { r: number[]; t: number[] }>();

/** Same KM model as the mosaic (paint/km.ts), so one profile TD means the same thing in both modes. */
export function oneLayer(color: string, td: number, layerHeight: number) {
  const key = `${color}|${td}|${layerHeight}`;
  let v = layerCache.get(key);
  if (!v) {
    const f = filamentOptics(color, td, layerHeight, 1);
    v = { r: [...f.R.subarray(3, 6)], t: [...f.T.subarray(3, 6)] };
    if (layerCache.size > 512) layerCache.clear();
    layerCache.set(key, v);
  }
  return v;
}

export function bandOptics(stack: StackLayer[], layerHeight: number): BandOptics[] {
  return stack.map((s) => ({
    ...oneLayer(s.colorHex, s.td, layerHeight),
    start: Math.round(s.startZ / layerHeight),
    end: Math.round(s.endZ / layerHeight),
  }));
}

/** Put one layer (r, t) on top of a background of reflectance `below` (linear RGB, updated in place). */
function addLayer(b: BandOptics, below: number[]) {
  for (let ch = 0; ch < 3; ch++) {
    const r = b.r[ch], t = b.t[ch], g = below[ch];
    below[ch] = r + (t * t * g) / (1 - r * g);
  }
}

/**
 * Chroma-weighted Oklab of the front-lit color at every printable height minL..maxL (index h - minL).
 * Same model and loop order as the preview shader: layers are added one at a time over black.
 */
export function pathLabs(bands: BandOptics[], minL: number, maxL: number, out = new Float32Array((maxL - minL + 1) * 3)) {
  const cw = Math.sqrt(CHROMA_WEIGHT);
  const below = [0, 0, 0], lab = [0, 0, 0];
  for (const b of bands) {
    // Height `start` belongs to the band below.
    for (let h = b.start + 1; h <= b.end; h++) {
      addLayer(b, below);
      if (h < minL || h > maxL) continue;
      linearToOklab(below[0], below[1], below[2], lab);
      const o = (h - minL) * 3;
      out[o] = lab[0];
      out[o + 1] = lab[1] * cw;
      out[o + 2] = lab[2] * cw;
    }
  }
  return out;
}

/** Chroma-weighted Oklab of an sRGB color (0..1). */
export function targetLab(r: number, g: number, b: number, out: number[] | Float32Array, o = 0) {
  linearToOklab(srgbToLinear(r), srgbToLinear(g), srgbToLinear(b), out, o);
  const cw = Math.sqrt(CHROMA_WEIGHT);
  out[o + 1] *= cw;
  out[o + 2] *= cw;
}

/** Height (layers) whose printed color is closest to the target; ties go to the lower height, like the shader. */
export function bestLayer(path: Float32Array, minL: number, l: number, a: number, b: number): number {
  let best = 0, bestErr = Infinity;
  for (let i = 0; i < path.length / 3; i++) {
    const dl = path[i * 3] - l, da = path[i * 3 + 1] - a, db = path[i * 3 + 2] - b;
    const e = dl * dl + da * da + db * db;
    if (e < bestErr - MATCH_TIE) {
      bestErr = e;
      best = i;
    }
  }
  return minL + best;
}
