import { linearToOklab, srgbToLinear, hexToRgb, TD_FLOOR } from '../color';
import type { StackLayer } from './model';

/** -ln(0.05): after one TD of thickness, 5% of what is below still shows through. */
export const K_TD = -Math.log(0.05);
/** Hue/chroma error counts this much more than lightness error when matching colors. */
export const CHROMA_WEIGHT = 2;
/** Match errors closer than this are ties and go to the lower height, so float noise can't pick between equal colors. */
export const MATCH_TIE = 1e-6;

export type HeightMode = 'match' | 'luminance';

/** One band in layer units with its optical constants (linear color, extinction per mm). */
export interface BandOptics {
  lin: number[];
  k: number;
  start: number;
  end: number;
}

export function bandOptics(stack: StackLayer[], layerHeight: number): BandOptics[] {
  return stack.map((s) => ({
    lin: hexToRgb(s.colorHex).map(srgbToLinear),
    k: K_TD / Math.max(TD_FLOOR, s.td),
    start: Math.round(s.startZ / layerHeight),
    end: Math.round(s.endZ / layerHeight),
  }));
}

/**
 * Chroma-weighted Oklab of the front-lit color at every printable height minL..maxL (index h - minL).
 * Same model and loop order as the preview shader: each layer hides what's below by exp(-k·d).
 */
export function pathLabs(bands: BandOptics[], lh: number, minL: number, maxL: number, out = new Float32Array((maxL - minL + 1) * 3)) {
  const cw = Math.sqrt(CHROMA_WEIGHT);
  const below = [0, 0, 0], c = [0, 0, 0], lab = [0, 0, 0];
  for (const b of bands) {
    // Height `start` belongs to the band below (thickness 0 here).
    for (let h = Math.max(b.start + 1, minL); h <= Math.min(b.end, maxL); h++) {
      const t = Math.exp(-b.k * (h - b.start) * lh);
      for (let ch = 0; ch < 3; ch++) c[ch] = b.lin[ch] + (below[ch] - b.lin[ch]) * t;
      linearToOklab(c[0], c[1], c[2], lab);
      const o = (h - minL) * 3;
      out[o] = lab[0];
      out[o + 1] = lab[1] * cw;
      out[o + 2] = lab[2] * cw;
    }
    if (b.end > b.start) {
      const t = Math.exp(-b.k * (b.end - b.start) * lh);
      for (let ch = 0; ch < 3; ch++) below[ch] = b.lin[ch] + (below[ch] - b.lin[ch]) * t;
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
