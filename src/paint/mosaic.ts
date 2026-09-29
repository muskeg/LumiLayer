import { linearToOklab, linearToSrgb } from '../color';
import { filamentOptics, stackOn, type FilamentOptics } from './km';
import { CHROMA_WEIGHT, targetLab } from './optics';

/**
 * Filament mosaic: the print is a grid of nozzle-wide tiles, each with its own short combo of filament
 * segments on a shared ground, so the reachable colors fill a volume of color space instead of the
 * single curve a global layer→filament stack gives.
 */

export interface MosaicFilament {
  name: string;
  color: string;
  td: number;
}

export interface ComboConfig {
  layerHeight: number;
  /** Layers of the ground filament (slot 0) under every tile. */
  groundLayers: number;
  /** Tint layers available above the ground. */
  tintLayers: number;
  /** Filament segments allowed per tile. */
  maxSegments: number;
}

/** Tile combos over one loadout. Slot 0 is the ground filament. */
export interface ComboSet {
  count: number;
  /** Segments of combo r, bottom to top, are segFil/segLen[segStart[r] .. segStart[r + 1]). */
  segStart: Uint32Array;
  segFil: Uint8Array;
  segLen: Uint8Array;
  /** Tint layers used by each combo. */
  layers: Uint16Array;
  /** Predicted linear RGB under white light. */
  rgb: Float32Array;
  /** Chroma-weighted Oklab. */
  lab: Float32Array;
  /** Linear RGB of the bare ground. */
  groundRgb: number[];
  groundLayers: number;
  tintLayers: number;
  filaments: MosaicFilament[];
}

/** Combos whose predicted colors fall in the same Oklab cell of this size are merged (simplest wins). */
const DEDUPE_CELL = 0.008;
const CW = Math.sqrt(CHROMA_WEIGHT);

export function loadoutOptics(filaments: MosaicFilament[], cfg: ComboConfig): FilamentOptics[] {
  const maxLayers = Math.max(cfg.tintLayers, cfg.groundLayers, 16);
  return filaments.map((f) => filamentOptics(f.color, f.td, cfg.layerHeight, maxLayers));
}

class ComboBuilder {
  segStart = [0];
  segFil: number[] = [];
  segLen: number[] = [];
  layers: number[] = [];
  rgb: number[] = [];
  lab: number[] = [];
  private readonly tmp = [0, 0, 0];

  add(fil: ArrayLike<number>, len: ArrayLike<number>, n: number, rgb: ArrayLike<number>) {
    let total = 0;
    for (let s = 0; s < n; s++) {
      this.segFil.push(fil[s]);
      this.segLen.push(len[s]);
      total += len[s];
    }
    this.segStart.push(this.segFil.length);
    this.layers.push(total);
    this.rgb.push(rgb[0], rgb[1], rgb[2]);
    linearToOklab(rgb[0], rgb[1], rgb[2], this.tmp);
    this.lab.push(this.tmp[0], this.tmp[1] * CW, this.tmp[2] * CW);
  }

  segments(r: number) {
    return this.segStart[r + 1] - this.segStart[r];
  }

  finish(keep: number[] | null, ground: number[], cfg: ComboConfig, filaments: MosaicFilament[]): ComboSet {
    const ids = keep ?? this.layers.map((_, i) => i);
    const segStart = new Uint32Array(ids.length + 1);
    let nseg = 0;
    ids.forEach((r, i) => {
      nseg += this.segments(r);
      segStart[i + 1] = nseg;
    });
    const segFil = new Uint8Array(nseg), segLen = new Uint8Array(nseg);
    const layers = new Uint16Array(ids.length), rgb = new Float32Array(ids.length * 3), lab = new Float32Array(ids.length * 3);
    ids.forEach((r, i) => {
      for (let s = this.segStart[r], o = segStart[i]; s < this.segStart[r + 1]; s++, o++) {
        segFil[o] = this.segFil[s];
        segLen[o] = this.segLen[s];
      }
      layers[i] = this.layers[r];
      for (let ch = 0; ch < 3; ch++) {
        rgb[i * 3 + ch] = this.rgb[r * 3 + ch];
        lab[i * 3 + ch] = this.lab[r * 3 + ch];
      }
    });
    return { count: ids.length, segStart, segFil, segLen, layers, rgb, lab, groundRgb: ground, groundLayers: cfg.groundLayers, tintLayers: cfg.tintLayers, filaments };
  }
}

function groundReflectance(optics: FilamentOptics[], groundLayers: number) {
  const ground = [0, 0, 0];
  stackOn(optics[0], groundLayers, ground);
  return ground;
}

/**
 * Every tile combo: up to `maxSegments` segments of loadout filaments (adjacent ones differ, the first
 * is not the ground) using at most `tintLayers` layers, plus the bare ground. With `dedupe`, combos that
 * print the same color collapse to the one with the fewest segments, then the fewest layers.
 */
export function buildCombos(filaments: MosaicFilament[], optics: FilamentOptics[], cfg: ComboConfig, dedupe = true): ComboSet {
  const P = optics.length, N = cfg.tintLayers, C = Math.max(0, cfg.maxSegments);
  const b = new ComboBuilder();
  const ground = groundReflectance(optics, cfg.groundLayers);
  const fil = new Array<number>(C).fill(0), len = new Array<number>(C).fill(0);
  const refl = Array.from({ length: C + 1 }, () => [0, 0, 0]);
  refl[0] = [...ground];
  const rec = (depth: number, used: number) => {
    b.add(fil, len, depth, refl[depth]);
    if (depth === C) return;
    for (let f = 0; f < P; f++) {
      if (depth === 0 ? f === 0 : f === fil[depth - 1]) continue;
      for (let t = 1; t <= N - used; t++) {
        const r = refl[depth + 1];
        r[0] = refl[depth][0]; r[1] = refl[depth][1]; r[2] = refl[depth][2];
        stackOn(optics[f], t, r);
        fil[depth] = f;
        len[depth] = t;
        rec(depth + 1, used + t);
      }
    }
  };
  rec(0, 0);
  if (!dedupe) return b.finish(null, ground, cfg, filaments);

  const cells = new Map<number, number>();
  const q = (v: number) => Math.round(v / DEDUPE_CELL) + 512;
  for (let r = 0; r < b.layers.length; r++) {
    const key = (q(b.lab[r * 3]) * 1024 + q(b.lab[r * 3 + 1])) * 1024 + q(b.lab[r * 3 + 2]);
    const prev = cells.get(key);
    if (prev === undefined || b.segments(r) < b.segments(prev) || (b.segments(r) === b.segments(prev) && b.layers[r] < b.layers[prev]))
      cells.set(key, r);
  }
  return b.finish([...cells.values()].sort((x, y) => x - y), ground, cfg, filaments);
}

/** Combos from an explicit list of [filament, layers] segments, bottom to top (e.g. a swatch plate). */
export function combosFromList(filaments: MosaicFilament[], optics: FilamentOptics[], cfg: ComboConfig, list: [number, number][][]): ComboSet {
  const b = new ComboBuilder();
  const ground = groundReflectance(optics, cfg.groundLayers);
  for (const segs of list) {
    const c = [...ground];
    for (const [f, t] of segs) stackOn(optics[f], t, c);
    b.add(segs.map((s) => s[0]), segs.map((s) => s[1]), segs.length, c);
  }
  const tintLayers = Math.max(0, ...b.layers);
  return b.finish(null, ground, { ...cfg, tintLayers }, filaments);
}

/** Nearest-neighbour search over 3D points (implicit k-d tree over an index permutation). */
export class KdTree {
  private readonly idx: Int32Array;
  private best = -1;
  private bestD = Infinity;
  private q = [0, 0, 0];

  constructor(private readonly pts: Float32Array) {
    const n = pts.length / 3;
    this.idx = new Int32Array(n);
    for (let i = 0; i < n; i++) this.idx[i] = i;
    this.build(0, n, 0);
  }

  private build(lo: number, hi: number, axis: number) {
    if (hi - lo <= 1) return;
    const mid = (lo + hi) >> 1;
    this.select(lo, hi - 1, mid, axis);
    this.build(lo, mid, (axis + 1) % 3);
    this.build(mid + 1, hi, (axis + 1) % 3);
  }

  /** Quickselect: put the k-th smallest (along `axis`) of idx[lo..hi] at k. */
  private select(lo: number, hi: number, k: number, axis: number) {
    const { idx, pts } = this;
    while (hi > lo) {
      const pivot = pts[idx[(lo + hi) >> 1] * 3 + axis];
      let i = lo, j = hi;
      while (i <= j) {
        while (pts[idx[i] * 3 + axis] < pivot) i++;
        while (pts[idx[j] * 3 + axis] > pivot) j--;
        if (i <= j) {
          const t = idx[i];
          idx[i++] = idx[j];
          idx[j--] = t;
        }
      }
      if (k <= j) hi = j;
      else if (k >= i) lo = i;
      else return;
    }
  }

  nearest(x: number, y: number, z: number): number {
    this.q[0] = x; this.q[1] = y; this.q[2] = z;
    this.best = -1;
    this.bestD = Infinity;
    this.search(0, this.idx.length, 0);
    return this.best;
  }

  private search(lo: number, hi: number, axis: number) {
    if (hi <= lo) return;
    const mid = (lo + hi) >> 1;
    const i = this.idx[mid], p = i * 3, pts = this.pts, q = this.q;
    const dx = pts[p] - q[0], dy = pts[p + 1] - q[1], dz = pts[p + 2] - q[2];
    const d = dx * dx + dy * dy + dz * dz;
    if (d < this.bestD || (d === this.bestD && i < this.best)) {
      this.bestD = d;
      this.best = i;
    }
    const diff = q[axis] - pts[p + axis];
    const next = (axis + 1) % 3;
    if (diff < 0) {
      this.search(lo, mid, next);
      if (diff * diff <= this.bestD) this.search(mid + 1, hi, next);
    } else {
      this.search(mid + 1, hi, next);
      if (diff * diff <= this.bestD) this.search(lo, mid, next);
    }
  }
}

export interface MosaicOptions {
  /** Stepped: tiles are only as tall as their combo. Otherwise every tile is padded with ground to one level top. */
  stepped: boolean;
  dither: boolean;
  /** Same-combo islands smaller than this many tiles are merged into a neighbour. */
  minIsland: number;
  /** Height of frame tiles, in layers. */
  frameLayers: number;
}

export interface MosaicResult {
  cols: number;
  rows: number;
  /** Combo per tile, -1 for frame (ground only), -2 for no material. */
  combo: Int32Array;
  /** Printed height of each tile, in layers. */
  layers: Uint16Array;
  set: ComboSet;
  stepped: boolean;
}

export const FRAME = -1;
export const EMPTY = -2;

export function tileHeight(set: ComboSet, r: number, stepped: boolean, frameLayers: number) {
  if (r === EMPTY) return 0;
  if (r === FRAME) return Math.max(set.groundLayers, frameLayers);
  return set.groundLayers + (stepped ? set.layers[r] : set.tintLayers);
}

/** Assign the closest combo to every image tile (sRGB floats, RGB triplets), with an optional frame border. */
export function solveMosaic(
  srgb: Float32Array,
  imgCols: number,
  imgRows: number,
  border: number,
  set: ComboSet,
  tree: KdTree,
  o: MosaicOptions,
): MosaicResult {
  const cols = imgCols + 2 * border, rows = imgRows + 2 * border;
  const combo = new Int32Array(cols * rows).fill(FRAME);
  const lab = [0, 0, 0];
  const at = (x: number, y: number) => (y + border) * cols + x + border;

  if (o.dither) {
    // Floyd–Steinberg in weighted Oklab, clamped so out-of-gamut colors don't smear.
    let cur = new Float32Array((imgCols + 2) * 3), next = new Float32Array((imgCols + 2) * 3);
    for (let y = 0; y < imgRows; y++) {
      [cur, next] = [next, cur];
      next.fill(0);
      for (let x = 0; x < imgCols; x++) {
        const s = (y * imgCols + x) * 3;
        targetLab(srgb[s], srgb[s + 1], srgb[s + 2], lab);
        const e = (x + 1) * 3;
        for (let ch = 0; ch < 3; ch++) lab[ch] += cur[e + ch];
        const r = tree.nearest(lab[0], lab[1], lab[2]);
        combo[at(x, y)] = r;
        for (let ch = 0; ch < 3; ch++) {
          const d = Math.max(-0.06, Math.min(0.06, lab[ch] - set.lab[r * 3 + ch]));
          cur[e + 3 + ch] += (d * 7) / 16;
          next[e - 3 + ch] += (d * 3) / 16;
          next[e + ch] += (d * 5) / 16;
          next[e + 3 + ch] += d / 16;
        }
      }
    }
  } else {
    // Colors quantized to 6 bits per channel share one lookup.
    const Q = 64;
    const cache = new Int32Array(Q * Q * Q).fill(-1);
    const q = (v: number) => Math.min(Q - 1, Math.max(0, Math.round(v * (Q - 1))));
    for (let y = 0; y < imgRows; y++)
      for (let x = 0; x < imgCols; x++) {
        const s = (y * imgCols + x) * 3;
        const qr = q(srgb[s]), qg = q(srgb[s + 1]), qb = q(srgb[s + 2]);
        const key = (qr * Q + qg) * Q + qb;
        if (cache[key] < 0) {
          targetLab(qr / (Q - 1), qg / (Q - 1), qb / (Q - 1), lab);
          cache[key] = tree.nearest(lab[0], lab[1], lab[2]);
        }
        combo[at(x, y)] = cache[key];
      }
  }

  mergeIslands(combo, cols, rows, set, o.minIsland);
  const layers = new Uint16Array(cols * rows);
  for (let p = 0; p < layers.length; p++) layers[p] = tileHeight(set, combo[p], o.stepped, o.frameLayers);
  return { cols, rows, combo, layers, set, stepped: o.stepped };
}

/** Merge 4-connected same-combo islands smaller than `minSize` into the neighbouring combo closest in color. */
export function mergeIslands(combo: Int32Array, cols: number, rows: number, set: ComboSet, minSize: number) {
  if (minSize <= 1) return;
  const n = cols * rows;
  const seen = new Uint8Array(n);
  const cells: number[] = [];
  const stack: number[] = [];
  for (let pass = 0; pass < 3; pass++) {
    seen.fill(0);
    let changed = false;
    for (let start = 0; start < n; start++) {
      const r = combo[start];
      if (r < 0 || seen[start]) continue;
      cells.length = 0;
      stack.length = 0;
      stack.push(start);
      seen[start] = 1;
      let best = -1, bestD = Infinity;
      const visit = (q: number) => {
        const rq = combo[q];
        if (rq === r) {
          if (!seen[q]) {
            seen[q] = 1;
            stack.push(q);
          }
        } else if (rq >= 0 && rq !== best) {
          const dl = set.lab[rq * 3] - set.lab[r * 3], da = set.lab[rq * 3 + 1] - set.lab[r * 3 + 1], db = set.lab[rq * 3 + 2] - set.lab[r * 3 + 2];
          const d = dl * dl + da * da + db * db;
          if (d < bestD) {
            bestD = d;
            best = rq;
          }
        }
      };
      while (stack.length) {
        const p = stack.pop()!;
        cells.push(p);
        const x = p % cols;
        if (x > 0) visit(p - 1);
        if (x < cols - 1) visit(p + 1);
        if (p >= cols) visit(p - cols);
        if (p < n - cols) visit(p + cols);
      }
      if (cells.length < minSize && best >= 0) {
        for (const p of cells) combo[p] = best;
        changed = true;
      }
    }
    if (!changed) break;
  }
}

/** Material of every voxel, index (p * K + k) with p = row * cols + col; 255 = empty. Slot ids match the loadout. */
export function mosaicVoxels(res: MosaicResult): { voxels: Uint8Array; K: number } {
  const { set, combo, layers } = res;
  let K = 0;
  for (let p = 0; p < layers.length; p++) K = Math.max(K, layers[p]);
  const voxels = new Uint8Array(layers.length * K).fill(255);
  for (let p = 0; p < layers.length; p++) {
    const o = p * K;
    voxels.fill(0, o, o + layers[p]);
    const r = combo[p];
    if (r < 0) continue;
    let k = set.groundLayers + (res.stepped ? 0 : set.tintLayers - set.layers[r]);
    for (let s = set.segStart[r]; s < set.segStart[r + 1]; s++) {
      voxels.fill(set.segFil[s], o + k, o + k + set.segLen[s]);
      k += set.segLen[s];
    }
  }
  return { voxels, K };
}

/** RGBA image of the predicted front-lit colors under `light` (linear RGB). */
export function renderMosaic(res: MosaicResult, light: number[], out = new Uint8ClampedArray(res.cols * res.rows * 4)) {
  const { set, combo } = res;
  const toByte = (v: number) => linearToSrgb(Math.min(1, v)) * 255;
  for (let p = 0; p < combo.length; p++) {
    const r = combo[p], o = p * 4;
    out[o + 3] = 255;
    if (r === EMPTY) {
      out[o] = out[o + 1] = out[o + 2] = 11;
      continue;
    }
    for (let ch = 0; ch < 3; ch++) out[o + ch] = toByte((r >= 0 ? set.rgb[r * 3 + ch] : set.groundRgb[ch]) * light[ch]);
  }
  return out;
}

export interface MosaicStats {
  combos: number;
  /** Layers (from the bed) in which more than one filament prints, i.e. with tool changes. */
  mixedLayers: number;
  /** Share of image tiles per loadout slot (any layer). */
  share: number[];
}

export function mosaicStats(res: MosaicResult): MosaicStats {
  const { set, combo, layers } = res;
  const slots = set.filaments.length;
  const perCombo = new Map<number, number>();
  let imageTiles = 0, K = 0, frameTop = 0;
  for (let p = 0; p < combo.length; p++) {
    const r = combo[p];
    K = Math.max(K, layers[p]);
    if (r === FRAME) frameTop = Math.max(frameTop, layers[p]);
    if (r < 0) continue;
    perCombo.set(r, (perCombo.get(r) ?? 0) + 1);
    imageTiles++;
  }
  const inLayer = new Uint8Array(K * slots);
  for (let k = 0; k < frameTop; k++) inLayer[k * slots] = 1;
  const cover = new Array<number>(slots).fill(0);
  for (const [r, n] of perCombo) {
    const present = new Set([0]);
    let k = set.groundLayers + (res.stepped ? 0 : set.tintLayers - set.layers[r]);
    for (let b = 0; b < k; b++) inLayer[b * slots] = 1;
    for (let s = set.segStart[r]; s < set.segStart[r + 1]; s++) {
      const f = set.segFil[s];
      present.add(f);
      for (let e = k + set.segLen[s]; k < e; k++) inLayer[k * slots + f] = 1;
    }
    for (const f of present) cover[f] += n;
  }
  let mixedLayers = 0;
  for (let k = 0; k < K; k++) {
    let n = 0;
    for (let s = 0; s < slots; s++) n += inLayer[k * slots + s];
    if (n > 1) mixedLayers++;
  }
  return { combos: perCombo.size, mixedLayers, share: cover.map((c) => (imageTiles ? c / imageTiles : 0)) };
}
