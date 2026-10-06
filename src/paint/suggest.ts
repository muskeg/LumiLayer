import { luma } from '../color';
import { layersFromLuminance, MAX_LAYERS, type Band, type FilamentProfile } from './model';
import { bandOptics, pathLabs, targetLab, type HeightMode } from './optics';

export interface SuggestInput {
  /** Adjusted image, sRGB floats 0..1 as RGB triplets (no frame). */
  srgb: Float32Array;
  invert: boolean;
  /** How the preview/export will assign heights; the suggestion is scored the same way. */
  heightMode?: HeightMode;
  minLayers: number;
  /** Current stack top; also tried as a total height. */
  maxLayers: number;
  layerHeight: number;
  profiles: FilamentProfile[];
  /** Distinct filaments allowed (AMS slots). */
  maxFilaments?: number;
}

export interface SuggestResult {
  bands: Band[];
  /** Mean squared (chroma-weighted) Oklab error of the predicted print against the image. */
  error: number;
}

/** Candidates per filament count that get their band heights optimized. */
const REFINE = 10;
/** Simpler stacks (fewer filaments, then lower) win if within this factor of the best error. */
const SIMPLER_TOLERANCE = 1.04;
/** Filaments closer than this (Oklab distance) are never both in one stack. */
const MIN_FILAMENT_DISTANCE = 0.05;
/** Total heights (layers) to try besides the current one; tall stacks let light filaments cover dark ones. */
const HEIGHT_OPTIONS = [24, 32, 40];
/** Dominant image colors used for scoring in color-match mode. */
const MAX_CLUSTERS = 256;

export interface Samples {
  /** Chroma-weighted Oklab per sample. */
  lab: Float32Array;
  weight: Float32Array;
  /** Luminance per sample (after invert), for luminance mode. */
  lum: Float32Array;
}

/** Dominant colors (16 levels per channel) with their share of the image. */
export function sampleImage(srgb: Float32Array, invert: boolean): Samples {
  const Q = 16;
  const n = srgb.length / 3;
  const acc = new Float64Array(Q * Q * Q * 4);
  const stride = Math.max(1, Math.floor(n / 200_000));
  for (let i = 0; i < n; i += stride) {
    const r = srgb[i * 3], g = srgb[i * 3 + 1], b = srgb[i * 3 + 2];
    const q = (v: number) => Math.min(Q - 1, Math.floor(v * Q));
    const bin = ((q(r) * Q + q(g)) * Q + q(b)) * 4;
    acc[bin] += r; acc[bin + 1] += g; acc[bin + 2] += b; acc[bin + 3]++;
  }
  const bins: number[] = [];
  for (let i = 0; i < Q * Q * Q; i++) if (acc[i * 4 + 3] > 0) bins.push(i);
  bins.sort((a, b) => acc[b * 4 + 3] - acc[a * 4 + 3]);
  const kept = bins.slice(0, MAX_CLUSTERS);
  const lab = new Float32Array(kept.length * 3), weight = new Float32Array(kept.length), lum = new Float32Array(kept.length);
  let total = 0;
  kept.forEach((bin, i) => {
    const c = acc[bin * 4 + 3];
    const r = acc[bin * 4] / c, g = acc[bin * 4 + 1] / c, b = acc[bin * 4 + 2] / c;
    targetLab(r, g, b, lab, i * 3);
    const v = luma(r, g, b);
    lum[i] = invert ? 1 - v : v;
    weight[i] = c;
    total += c;
  });
  for (let i = 0; i < weight.length; i++) weight[i] /= total;
  return { lab, weight, lum };
}

class Evaluator {
  private path = new Float32Array(0);

  constructor(private readonly input: SuggestInput, private readonly samples: Samples) {}

  /** Error of filament sequence `seq` (profile indices, bottom to top) with exclusive band tops `tops` (last = total height). */
  error(seq: number[], tops: number[]): number {
    const { minLayers: minL, layerHeight: lh, profiles } = this.input;
    const maxL = tops[tops.length - 1];
    const levels = maxL - minL + 1;
    if (this.path.length < levels * 3) this.path = new Float32Array(levels * 3);
    const stack = seq.map((f, j) => ({
      name: '', colorHex: profiles[f].color, td: profiles[f].td, materialId: 0,
      startZ: (j ? tops[j - 1] : 0) * lh, endZ: tops[j] * lh,
    }));
    const path = pathLabs(bandOptics(stack, lh), lh, minL, maxL, this.path);
    const { lab, weight, lum } = this.samples;
    const match = this.input.heightMode !== 'luminance';
    let err = 0;
    for (let s = 0; s < weight.length; s++) {
      const l = lab[s * 3], a = lab[s * 3 + 1], b = lab[s * 3 + 2];
      let e: number;
      if (match) {
        e = Infinity;
        for (let i = 0; i < levels; i++) {
          const dl = path[i * 3] - l, da = path[i * 3 + 1] - a, db = path[i * 3 + 2] - b;
          const d = dl * dl + da * da + db * db;
          if (d < e) e = d;
        }
      } else {
        const i = layersFromLuminance(lum[s], minL, maxL, maxL) - minL;
        const dl = path[i * 3] - l, da = path[i * 3 + 1] - a, db = path[i * 3 + 2] - b;
        e = dl * dl + da * da + db * db;
      }
      err += weight[s] * e;
    }
    return err;
  }

  /** Highest height any sample is assigned to (color-match mode). */
  tallestUsed(seq: number[], tops: number[]): number {
    const { minLayers: minL } = this.input;
    this.error(seq, tops);
    const levels = tops[tops.length - 1] - minL + 1;
    const { lab } = this.samples;
    let tallest = minL;
    for (let s = 0; s < this.samples.weight.length; s++) {
      let best = 0, e = Infinity;
      for (let i = 0; i < levels; i++) {
        const dl = this.path[i * 3] - lab[s * 3], da = this.path[i * 3 + 1] - lab[s * 3 + 1], db = this.path[i * 3 + 2] - lab[s * 3 + 2];
        const d = dl * dl + da * da + db * db;
        if (d < e) { e = d; best = i; }
      }
      tallest = Math.max(tallest, minL + best);
    }
    return tallest;
  }
}

function equalTops(k: number, minL: number, maxL: number): number[] {
  const tops: number[] = [];
  for (let j = 1; j <= k; j++) tops.push(j === k ? maxL : Math.round(minL + ((maxL - minL) * j) / k));
  // Keep strictly increasing even for short stacks.
  for (let j = k - 2; j >= 0; j--) tops[j] = Math.min(tops[j], tops[j + 1] - 1);
  for (let j = 0; j < k; j++) tops[j] = Math.max(tops[j], j + 1);
  return tops;
}

/** Coordinate descent on the band boundaries (the last top stays fixed). */
function refineTops(ev: Evaluator, seq: number[], start: number[]): { tops: number[]; err: number } {
  let tops = [...start];
  let err = ev.error(seq, tops);
  const maxL = tops[tops.length - 1];
  for (let pass = 0; pass < 20; pass++) {
    let improved = false;
    for (let j = 0; j < tops.length - 1; j++) {
      for (const step of [8, 4, 2, 1, -1, -2, -4, -8]) {
        const t = tops[j] + step;
        const lo = j ? tops[j - 1] + 1 : 1;
        const hi = tops[j + 1] - 1;
        if (t < lo || t > hi || t >= maxL) continue;
        const trial = [...tops];
        trial[j] = t;
        const e = ev.error(seq, trial);
        if (e < err - 1e-12) {
          err = e;
          tops = trial;
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return { tops, err };
}

/**
 * Suggest a layer stack for the image from the user's filament profiles: the best ordered set of up to
 * `maxFilaments` distinct filaments (one band each), with optimized band heights and total height.
 * Scored with the same front-lit model and height assignment as the preview.
 */
export async function suggestStack(input: SuggestInput, onProgress?: (fraction: number) => void): Promise<SuggestResult> {
  const P = input.profiles.length;
  if (!P) throw new Error('Add at least one filament profile first.');
  const minL = input.minLayers;
  const maxF = Math.max(1, Math.min(input.maxFilaments ?? 4, P));
  const samples = sampleImage(input.srgb, input.invert);
  const ev = new Evaluator(input, samples);
  const yieldToUi = () => new Promise((r) => setTimeout(r, 0));

  const labs = input.profiles.map((p) => {
    const out = [0, 0, 0];
    const n = parseInt(p.color.slice(1), 16);
    targetLab(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, out);
    return out;
  });
  const similar = (a: number, b: number) => Math.hypot(labs[a][0] - labs[b][0], labs[a][1] - labs[b][1], labs[a][2] - labs[b][2]) < MIN_FILAMENT_DISTANCE;

  const heights = [...new Set([input.maxLayers, ...HEIGHT_OPTIONS])]
    .filter((h) => h >= minL + maxF && h <= MAX_LAYERS)
    .sort((a, b) => a - b);
  if (!heights.length) heights.push(Math.max(minL + 1, input.maxLayers));
  const rankHeight = heights[Math.floor(heights.length / 2)];

  // Stage 1: rank ordered filament sequences with evenly spaced bands.
  const sequences: number[][] = [];
  const seq: number[] = [];
  const rec = (k: number) => {
    if (seq.length === k) return void sequences.push([...seq]);
    for (let f = 0; f < P; f++) {
      if (seq.includes(f) || seq.some((g) => similar(f, g))) continue;
      seq.push(f);
      rec(k);
      seq.pop();
    }
  };
  for (let k = 1; k <= maxF; k++) rec(k);
  const ranked = [];
  for (let i = 0; i < sequences.length; i++) {
    const s = sequences[i];
    ranked.push({ seq: s, err: ev.error(s, equalTops(s.length, minL, rankHeight)) });
    if (i % 2000 === 1999) {
      onProgress?.(0.5 * (i / sequences.length));
      await yieldToUi();
    }
  }
  ranked.sort((a, b) => a.err - b.err);

  // Stage 2: refine band heights of the best sequences of each length, at each total height.
  const finalists: { seq: number[]; tops: number[]; err: number }[] = [];
  const shortlist = [];
  for (let k = 1; k <= maxF; k++) shortlist.push(...ranked.filter((c) => c.seq.length === k).slice(0, REFINE));
  for (let i = 0; i < shortlist.length; i++) {
    for (const H of heights) {
      if (H < minL + shortlist[i].seq.length) continue;
      const r = refineTops(ev, shortlist[i].seq, equalTops(shortlist[i].seq.length, minL, H));
      finalists.push({ seq: shortlist[i].seq, ...r });
    }
    onProgress?.(0.5 + (0.5 * (i + 1)) / shortlist.length);
    await yieldToUi();
  }
  const overall = Math.min(...finalists.map((f) => f.err));
  finalists.sort((a, b) => a.seq.length - b.seq.length || a.tops[a.tops.length - 1] - b.tops[b.tops.length - 1] || a.err - b.err);
  const best = finalists.find((f) => f.err <= overall * SIMPLER_TOLERANCE + 1e-12)!;

  // In color-match mode, heights above the tallest used one are never printed: cut the stack there.
  let tops = best.tops;
  if (input.heightMode !== 'luminance') {
    const tallest = Math.max(minL + 1, ev.tallestUsed(best.seq, best.tops));
    tops = tops.map((t) => Math.min(t, tallest));
  }
  const bands: Band[] = [];
  let prev = 0;
  best.seq.forEach((f, j) => {
    if (tops[j] > prev) bands.push({ filamentId: input.profiles[f].id, top: tops[j] });
    prev = tops[j];
  });
  return { bands, error: best.err };
}
