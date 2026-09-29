import { buildCombos, KdTree, loadoutOptics, type ComboConfig, type ComboSet } from './mosaic';
import type { FilamentOptics } from './km';
import type { FilamentProfile } from './model';
import { targetLab } from './optics';
import { sampleImage, type Samples } from './suggest';

export interface LoadoutInput {
  /** Adjusted image, sRGB floats 0..1 as RGB triplets (no frame). */
  srgb: Float32Array;
  profiles: FilamentProfile[];
  /** Filament slots (AMS); the ground uses one of them. */
  slots: number;
  config: ComboConfig;
}

export interface LoadoutPick {
  /** Profile ids, slot 0 = ground. */
  ids: string[];
  /** Mean squared chroma-weighted Oklab error of the predicted print against the image. */
  error: number;
}

/** Loadouts re-scored with the full combo settings after the quick ranking. */
const SHORTLIST = 8;
/** Fewer filaments win if within this factor of the best error. */
const SIMPLER_TOLERANCE = 1.03;
/** Filaments closer than this (Oklab distance) are never both in one loadout. */
const MIN_FILAMENT_DISTANCE = 0.05;

/** Weighted mean squared distance from each sample to its closest combo (brute force without a tree). */
export function gamutError(set: ComboSet, samples: Samples, tree?: KdTree): number {
  const { lab, weight } = samples;
  let err = 0;
  for (let s = 0; s < weight.length; s++) {
    const l = lab[s * 3], a = lab[s * 3 + 1], b = lab[s * 3 + 2];
    let e = Infinity;
    if (tree) {
      const r = tree.nearest(l, a, b);
      const dl = set.lab[r * 3] - l, da = set.lab[r * 3 + 1] - a, db = set.lab[r * 3 + 2] - b;
      e = dl * dl + da * da + db * db;
    } else {
      for (let r = 0; r < set.count; r++) {
        const dl = set.lab[r * 3] - l, da = set.lab[r * 3 + 1] - a, db = set.lab[r * 3 + 2] - b;
        const d = dl * dl + da * da + db * db;
        if (d < e) e = d;
      }
    }
    err += weight[s] * e;
  }
  return err;
}

/**
 * Pick the ground and up to `slots - 1` more filaments from the user's profiles that let the mosaic
 * reproduce the image best: quick ranking of every loadout with short combos, then a full re-score of
 * the best few.
 */
export async function pickLoadout(input: LoadoutInput, onProgress?: (fraction: number) => void): Promise<LoadoutPick> {
  const { profiles, config } = input;
  const P = profiles.length;
  if (!P) throw new Error('Add at least one filament profile first.');
  const slots = Math.max(1, Math.min(input.slots, P));
  const samples = sampleImage(input.srgb, false);
  const optics = loadoutOptics(profiles, config);
  const yieldToUi = () => new Promise((r) => setTimeout(r, 0));

  const labs = profiles.map((p) => {
    const n = parseInt(p.color.slice(1), 16);
    const out = [0, 0, 0];
    targetLab(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, out);
    return out;
  });
  const similar = (a: number, b: number) => Math.hypot(labs[a][0] - labs[b][0], labs[a][1] - labs[b][1], labs[a][2] - labs[b][2]) < MIN_FILAMENT_DISTANCE;

  const loadouts: number[][] = [];
  const others: number[] = [];
  // The ground is the darkest filament of its loadout: it also shows in the frame and under thin tiles.
  const rec = (ground: number, from: number) => {
    if (others.length) loadouts.push([ground, ...others]);
    if (others.length === slots - 1) return;
    for (let f = from; f < P; f++) {
      if (f === ground || labs[f][0] < labs[ground][0] || similar(f, ground) || others.some((g) => similar(f, g))) continue;
      others.push(f);
      rec(ground, f + 1);
      others.pop();
    }
  };
  for (let ground = 0; ground < P; ground++) rec(ground, 0);
  if (!loadouts.length) return { ids: [profiles[0].id], error: Infinity };

  const pick = (ids: number[]) => ({ filaments: ids.map((i) => profiles[i]), optics: ids.map((i) => optics[i]) as FilamentOptics[] });
  const quick: ComboConfig = { ...config, tintLayers: Math.min(config.tintLayers, 6), maxSegments: Math.min(config.maxSegments, 2) };
  const ranked: { ids: number[]; err: number }[] = [];
  for (let i = 0; i < loadouts.length; i++) {
    const { filaments, optics: o } = pick(loadouts[i]);
    ranked.push({ ids: loadouts[i], err: gamutError(buildCombos(filaments, o, quick, false), samples) });
    if (i % 150 === 149) {
      onProgress?.(0.7 * (i / loadouts.length));
      await yieldToUi();
    }
  }
  ranked.sort((a, b) => a.err - b.err);

  // Keep the best few overall plus the best of each size, so smaller loadouts can still win on simplicity.
  const shortlist = ranked.slice(0, SHORTLIST);
  for (let k = 2; k <= slots; k++) {
    const best = ranked.find((r) => r.ids.length === k);
    if (best && !shortlist.includes(best)) shortlist.push(best);
  }
  const finals: { ids: number[]; err: number }[] = [];
  for (let i = 0; i < shortlist.length; i++) {
    const { filaments, optics: o } = pick(shortlist[i].ids);
    const set = buildCombos(filaments, o, config);
    finals.push({ ids: shortlist[i].ids, err: gamutError(set, samples, new KdTree(set.lab)) });
    onProgress?.(0.7 + (0.3 * (i + 1)) / shortlist.length);
    await yieldToUi();
  }
  const overall = Math.min(...finals.map((f) => f.err));
  finals.sort((a, b) => a.ids.length - b.ids.length || a.err - b.err);
  const best = finals.find((f) => f.err <= overall * SIMPLER_TOLERANCE + 1e-12)!;
  // Ground first, then the others from light to dark.
  const [ground, ...rest] = best.ids;
  rest.sort((a, b) => labs[b][0] - labs[a][0]);
  return { ids: [ground, ...rest].map((i) => profiles[i].id), error: best.err };
}
