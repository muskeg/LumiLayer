import { linearToOklab, srgbToLinear, hexToRgb, type Filament } from './color';

/** Typical PLA colors with approximate HueForge-style transmission distances (mm). Edit to match your rolls. */
export const FILAMENT_LIBRARY: Filament[] = [
  { name: 'White', color: '#f2f2ee', td: 2.5, enabled: true },
  { name: 'Ivory', color: '#efe6d0', td: 2.5, enabled: true },
  { name: 'Beige', color: '#d8c3a0', td: 2, enabled: true },
  { name: 'Gray', color: '#8a8a8a', td: 1.2, enabled: true },
  { name: 'Charcoal', color: '#3a3a3a', td: 0.8, enabled: true },
  { name: 'Black', color: '#141414', td: 0.6, enabled: true },
  { name: 'Brown', color: '#6b4226', td: 1, enabled: true },
  { name: 'Red', color: '#c8102e', td: 1.2, enabled: true },
  { name: 'Orange', color: '#f06a1e', td: 1.8, enabled: true },
  { name: 'Yellow', color: '#f5c400', td: 2.5, enabled: true },
  { name: 'Green', color: '#1f8a3c', td: 1.5, enabled: true },
  { name: 'Cyan', color: '#00a0e0', td: 1.8, enabled: true },
  { name: 'Blue', color: '#1f4fd8', td: 1.2, enabled: true },
  { name: 'Navy', color: '#1c2a5a', td: 0.8, enabled: true },
  { name: 'Magenta', color: '#d0007a', td: 1.5, enabled: true },
];

/** Dominant colors of an sRGB float image as Oklab samples with weights. */
export function imageSamples(srgb: Float32Array, max = 160) {
  const Q = 12;
  const n = srgb.length / 3;
  const sums = new Float64Array(Q * Q * Q * 3);
  const counts = new Uint32Array(Q * Q * Q);
  const stride = Math.max(1, Math.floor(n / 60000));
  for (let i = 0; i < n; i += stride) {
    const r = srgb[i * 3], g = srgb[i * 3 + 1], b = srgb[i * 3 + 2];
    const q = (v: number) => Math.min(Q - 1, Math.floor(v * Q));
    const bin = (q(r) * Q + q(g)) * Q + q(b);
    sums[bin * 3] += srgbToLinear(r);
    sums[bin * 3 + 1] += srgbToLinear(g);
    sums[bin * 3 + 2] += srgbToLinear(b);
    counts[bin]++;
  }
  const bins = [...counts.keys()].filter((b) => counts[b] > 0).sort((a, b) => counts[b] - counts[a]).slice(0, max);
  const lab = new Float32Array(bins.length * 3);
  const weight = new Float32Array(bins.length);
  let total = 0;
  bins.forEach((b, i) => {
    const c = counts[b];
    linearToOklab(sums[b * 3] / c, sums[b * 3 + 1] / c, sums[b * 3 + 2] / c, lab, i * 3);
    weight[i] = c;
    total += c;
  });
  for (let i = 0; i < weight.length; i++) weight[i] /= total;
  return { lab, weight };
}

interface Candidate {
  base: number;
  colors: [number, number, number];
  cost: number;
}

/**
 * Search base + ordered color triples from the library for the palette whose achievable colors best
 * reproduce the image (weighted Oklab error, without tone compression so dark-capable palettes win).
 */
export async function suggestPalette(
  srgb: Float32Array,
  layerHeight: number,
  colorLayers: number,
  library: Filament[] = FILAMENT_LIBRARY,
  onProgress?: (fraction: number) => void,
): Promise<Filament[]> {
  const { lab: targets, weight } = imageSamples(srgb);
  const K = weight.length;
  const lin = library.map((f) => hexToRgb(f.color).map(srgbToLinear));
  // Search with a capped layer count for speed; the ranking carries over to more layers.
  const N = Math.min(colorLayers, 8);
  const combos: number[][] = [];
  for (let a = 0; a <= N; a++) for (let b = 0; a + b <= N; b++) for (let c = 0; a + b + c <= N; c++) combos.push([a, b, c]);
  const C = combos.length;
  const labs = new Float32Array(C * 3);
  const rgb = [0, 0, 0];

  const cost = (base: number, colors: number[]) => {
    for (let ci = 0; ci < C; ci++) {
      rgb[0] = lin[base][0]; rgb[1] = lin[base][1]; rgb[2] = lin[base][2];
      for (let k = 0; k < 3; k++) {
        const cnt = combos[ci][k];
        if (!cnt) continue;
        const f = colors[k];
        const alpha = Math.min(1, (cnt * layerHeight) / library[f].td);
        for (let ch = 0; ch < 3; ch++) rgb[ch] = alpha * lin[f][ch] + (1 - alpha) * rgb[ch];
      }
      linearToOklab(rgb[0], rgb[1], rgb[2], labs, ci * 3);
    }
    let total = 0;
    for (let s = 0; s < K; s++) {
      const tl = targets[s * 3], ta = targets[s * 3 + 1], tb = targets[s * 3 + 2];
      let best = Infinity;
      for (let ci = 0; ci < C; ci++) {
        const dL = labs[ci * 3] - tl, da = labs[ci * 3 + 1] - ta, db = labs[ci * 3 + 2] - tb;
        const e = dL * dL + da * da + db * db;
        if (e < best) best = e;
      }
      total += weight[s] * best;
    }
    return total;
  };

  const M = library.length;
  const jobs: [number, number, number, number][] = [];
  for (let base = 0; base < M; base++)
    for (let a = 0; a < M; a++)
      for (let b = 0; b < M; b++)
        for (let c = 0; c < M; c++)
          if (a !== base && b !== base && c !== base && a !== b && a !== c && b !== c) jobs.push([base, a, b, c]);

  let best: Candidate = { base: 0, colors: [1, 2, 3], cost: Infinity };
  for (let j = 0; j < jobs.length; j++) {
    const [base, a, b, c] = jobs[j];
    const e = cost(base, [a, b, c]);
    if (e < best.cost) best = { base, colors: [a, b, c], cost: e };
    if (j % 400 === 399) {
      onProgress?.(j / jobs.length);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  return [best.base, ...best.colors].map((i) => ({ ...library[i], enabled: true }));
}
