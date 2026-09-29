import { hexToRgb, srgbToLinear } from '../color';

/**
 * Kubelka–Munk two-flux optics for front-lit filament stacks, per RGB channel.
 *
 * A filament is described by its color (the reflectance of an infinitely thick piece, R∞) and its TD.
 * R∞ fixes the absorption/scattering ratio K/S per channel; TD fixes the scattering S (shared by all
 * channels), so a translucent filament (large TD) scatters little and tints what is below it, while
 * an opaque one hides it within a few layers.
 */

/** Contrast between a white and a black background still visible through one TD of filament. */
export const TD_CONTRAST = 0.05;
const R_INF_MIN = 0.002;
const R_INF_MAX = 0.98;

interface KmChannel {
  a: number;
  b: number;
}

function kmChannel(rInf: number): KmChannel {
  const r = Math.min(R_INF_MAX, Math.max(R_INF_MIN, rInf));
  const a = 1 + ((1 - r) * (1 - r)) / (2 * r);
  return { a, b: Math.sqrt(a * a - 1) };
}

/** Reflectance (over black) and transmittance of a layer with optical thickness S·d. Stable for any S·d >= 0. */
function kmLayer(ch: KmChannel, sd: number, out: number[], o: number) {
  const x = ch.b * sd;
  const u = Math.exp(-2 * x);
  const den = ch.a * (1 - u) + ch.b * (1 + u);
  out[o] = (1 - u) / den;
  out[o + 1] = (2 * ch.b * Math.exp(-x)) / den;
}

/** Scattering (1/mm) that leaves TD_CONTRAST of background contrast after `td` mm in the most transparent channel. */
function scatteringFor(channels: KmChannel[], td: number): number {
  const rt = [0, 0];
  const contrast = (sd: number) => {
    let c = 0;
    for (const ch of channels) {
      kmLayer(ch, sd, rt, 0);
      c = Math.max(c, (rt[1] * rt[1]) / (1 - rt[0]));
    }
    return c;
  };
  // Contrast falls monotonically with S·d; bisect in log space for S·d at d = td.
  let lo = Math.log(1e-4), hi = Math.log(1e4);
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (contrast(Math.exp(mid)) > TD_CONTRAST) lo = mid;
    else hi = mid;
  }
  return Math.exp((lo + hi) / 2) / Math.max(0.01, td);
}

export interface FilamentOptics {
  /** Reflectance over black of t layers, at [t * 3 + ch], t = 0..maxLayers. */
  R: Float32Array;
  /** Transmittance of t layers, same layout. */
  T: Float32Array;
  maxLayers: number;
}

/** Layer tables for a filament (color hex, TD in mm) at a given layer height. */
export function filamentOptics(color: string, td: number, layerHeight: number, maxLayers: number): FilamentOptics {
  const channels = hexToRgb(color).map((c) => kmChannel(srgbToLinear(c)));
  const s = scatteringFor(channels, td);
  const R = new Float32Array((maxLayers + 1) * 3);
  const T = new Float32Array((maxLayers + 1) * 3);
  const rt = [0, 0];
  for (let t = 0; t <= maxLayers; t++)
    for (let ch = 0; ch < 3; ch++) {
      kmLayer(channels[ch], s * t * layerHeight, rt, 0);
      R[t * 3 + ch] = rt[0];
      T[t * 3 + ch] = rt[1];
    }
  return { R, T, maxLayers };
}

/** Put `t` layers of filament `f` on top of a background of reflectance `below` (linear RGB, updated in place). */
export function stackOn(f: FilamentOptics, t: number, below: number[] | Float32Array, o = 0) {
  const k = Math.min(t, f.maxLayers) * 3;
  for (let ch = 0; ch < 3; ch++) {
    const r = f.R[k + ch], tr = f.T[k + ch], g = below[o + ch];
    below[o + ch] = r + (tr * tr * g) / (1 - r * g);
  }
}
