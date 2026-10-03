import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { buildSolver, solve, type LithoParams } from './lithophane';
import { buildPrintMeshes, type Mesh } from './mesh';
import { buildPainting3mf, buildPaintingParts, materialOfLayers, type PaintExportInput } from './paint/export';
import { DEFAULT_PROFILES, FRAME_SENTINEL, layersFromLuminance, normalizeStack, resolveStack, type Band, type FilamentProfile, type StackLayer } from './paint/model';
import { suggestStack } from './paint/suggest';
import { bandOptics, bestLayer, CHROMA_WEIGHT, K_TD, MATCH_TIE, pathLabs, targetLab } from './paint/optics';
import { write3mfSync } from './threemf';
import { filamentOptics, stackOn, TD_CONTRAST } from './paint/km';
import {
  buildCombos, mosaicStats, mosaicVoxels, EMPTY, KdTree, loadoutOptics, combosFromList, mergeIslands, solveMosaic,
  type MosaicFilament, type ComboConfig,
} from './paint/mosaic';
import { buildLithoParts, buildMosaicParts, type MosaicExportInput } from './paint/export';
import { swatchPlate, swatchRows } from './paint/swatches';
import { defaultLoadout, normalizeLoadout } from './paint/model';
import { gamutError, pickLoadout } from './paint/loadout';
import { sampleImage } from './paint/suggest';
import { hexToRgb, linearToOklab, srgbToLinear, TD_FLOOR } from './color';

const params = (over: Partial<LithoParams> = {}): LithoParams => ({
  pixelMm: 0.5,
  minThickness: 0.6,
  maxThickness: 3,
  frameThickness: 4,
  colorLayers: 4,
  layerHeight: 0.1,
  colorPriority: 1,
  filaments: [
    { name: 'White', color: '#ffffff', td: 1.8, enabled: true },
    { name: 'Cyan', color: '#00a0e0', td: 2.5, enabled: true },
    { name: 'Magenta', color: '#e0007a', td: 2.5, enabled: true },
    { name: 'Yellow', color: '#ffe000', td: 4, enabled: true },
  ],
  ...over,
});
const light = { color: '#ffffff', exposure: 1 };

function run(pixels: number[][], cols: number, rows: number, p = params(), border = 0) {
  const srgb = Float32Array.from(pixels.flat());
  return solve(srgb, cols, rows, border, p, buildSolver(p), light);
}

function randomImage(cols: number, rows: number, seed = 1) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  return Array.from({ length: cols * rows }, () => [rnd(), rnd(), rnd()]);
}

/** Closed 2-manifold: every directed edge appears once and is matched by its reverse (so each edge has exactly two faces). */
function expectClosed(mesh: Mesh) {
  const edges = new Map<string, number>();
  const { indices: ix, positions: p } = mesh;
  for (let t = 0; t < ix.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = ix[t + e], b = ix[t + ((e + 1) % 3)];
      edges.set(`${a},${b}`, (edges.get(`${a},${b}`) ?? 0) + 1);
    }
  }
  let bad = 0;
  for (const [k, n] of edges) {
    const [a, b] = k.split(',');
    if (n !== 1 || edges.get(`${b},${a}`) !== 1) bad++;
  }
  expect(bad, 'non-manifold or open edges').toBe(0);
  // Signed volume must be positive (outward normals).
  let vol = 0;
  for (let t = 0; t < ix.length; t += 3) {
    const [a, b, c] = [ix[t] * 3, ix[t + 1] * 3, ix[t + 2] * 3];
    vol +=
      (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
        p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
        p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6;
  }
  expect(vol).toBeGreaterThan(0);
  return vol;
}

describe('solver', () => {
  it('maps white to thin, color-free and black to thick', () => {
    const r = run([[1, 1, 1], [0, 0, 0]], 2, 1);
    expect([...r.counts.slice(0, 3)]).toEqual([0, 0, 0]);
    expect(r.body[0]).toBeCloseTo(0.6, 3);
    expect(r.body[1]).toBeCloseTo(3, 3);
  });

  it('uses magenta + yellow for red and cyan for cyan', () => {
    const r = run([[1, 0, 0], [0, 1, 1]], 2, 1);
    expect(r.counts[0]).toBe(0);
    expect(r.counts[1]).toBeGreaterThan(0);
    expect(r.counts[2]).toBeGreaterThan(0);
    expect(r.counts[3]).toBeGreaterThan(0);
    expect(r.counts[4]).toBe(0);
  });

  it('never exceeds the color layer budget', () => {
    const r = run(randomImage(20, 20), 20, 20, params({ dither: true }), 2);
    for (let i = 0; i < r.cols * r.rows; i++) expect(r.counts[i * 3] + r.counts[i * 3 + 1] + r.counts[i * 3 + 2]).toBeLessThanOrEqual(4);
    for (const m of buildPrintMeshes(r)) if (m) expectClosed(m);
  });
});

describe('meshes', () => {
  it('produces closed meshes whose volumes add up', () => {
    const cols = 12, rows = 9, border = 2;
    const p = params();
    const r = run(randomImage(cols, rows), cols, rows, p, border);
    const meshes = buildPrintMeshes(r);
    const vols = meshes.map((m) => (m ? expectClosed(m) : 0));
    const n = r.cols * r.rows;
    let filler = 0, body = 0;
    for (let f = 0; f < 3; f++) {
      let layers = 0;
      for (let i = 0; i < n; i++) layers += r.counts[i * 3 + f];
      expect(vols[f + 1]).toBeCloseTo(layers * 0.25 * 0.1, 4);
      filler -= layers;
    }
    filler += n * 4;
    for (let i = 0; i < n; i++) body += r.body[i] * 0.25;
    expect(vols[0] / (filler * 0.025 + body)).toBeCloseTo(1, 1);
    // Bounding box
    const all = meshes.filter(Boolean).flatMap((m) => [...m!.positions]);
    const xs = all.filter((_, i) => i % 3 === 0);
    expect(Math.max(...xs)).toBeCloseTo((cols + 2 * border) * 0.5, 4);
    expect(Math.min(...xs)).toBeCloseTo(0, 4);
  });

  it('keeps color cells uniform and meshes closed', () => {
    const r = run(randomImage(10, 7), 10, 7, params({ dither: true, colorCellPx: 3 }), 1);
    const stack = (x: number, y: number) => [...r.counts.slice((y * r.cols + x) * 3, (y * r.cols + x) * 3 + 3)];
    for (let y = 1; y < 8; y++)
      for (let x = 1; x < 11; x++) {
        const cx = 1 + Math.floor((x - 1) / 3) * 3, cy = 1 + Math.floor((y - 1) / 3) * 3;
        expect(stack(x, y)).toEqual(stack(cx, cy));
      }
    for (const m of buildPrintMeshes(r)) if (m) expectClosed(m);
  });

  it('stays manifold on noisy data for various layer counts and filament sets', () => {
    for (const [colorLayers, enabled, seed] of [[1, 3, 2], [3, 2, 3], [6, 3, 4], [10, 1, 5]] as const) {
      const p = params({ colorLayers, dither: true });
      p.filaments = p.filaments.map((f, i) => ({ ...f, enabled: i <= enabled }));
      const r = run(randomImage(24, 17, seed), 24, 17, p, 2);
      for (const m of buildPrintMeshes(r, 0.05)) if (m) expectClosed(m);
    }
  });

  it('handles monochrome (no color layers)', () => {
    const p = params({ colorLayers: 0 });
    const r = run(randomImage(5, 4), 5, 4, p);
    const meshes = buildPrintMeshes(r);
    expect(meshes.slice(1).every((m) => m === null)).toBe(true);
    expectClosed(meshes[0]!);
  });
});

describe('filament painting', () => {
  const lh = 0.08;
  const profiles: FilamentProfile[] = [
    { id: 'black', name: 'Black', color: '#141414', td: 0.6 },
    { id: 'red', name: 'Red', color: '#c8102e', td: 1.2 },
    { id: 'white', name: 'White', color: '#f2f2ee', td: 2.5 },
  ];
  // Black, Red, White, then Black again on top: 4 bands but only 3 materials.
  const bands: Band[] = [
    { filamentId: 'black', top: 6 },
    { filamentId: 'red', top: 10 },
    { filamentId: 'white', top: 16 },
    { filamentId: 'black', top: 18 },
  ];

  const paintInput = (cols: number, rows: number, seed: number): PaintExportInput => {
    const heights = Float32Array.from(randomImage(cols, rows, seed), (p) => layersFromLuminance(p[0], 3, 18, 18) * lh);
    return { heights, cols, rows, widthMm: cols * 0.5, heightMm: rows * 0.5, baseHeight: 3 * lh, layerHeight: lh, stack: resolveStack(bands, profiles, lh) };
  };

  it('quantizes luminance to whole layers like the shader, with a frame sentinel', () => {
    expect(layersFromLuminance(0, 4, 20, 9)).toBe(4);
    expect(layersFromLuminance(1, 4, 20, 9)).toBe(20);
    expect(layersFromLuminance(0.5, 4, 20, 9)).toBe(12);
    expect(layersFromLuminance(FRAME_SENTINEL, 4, 20, 9)).toBe(9);
  });

  it('resolves bands to Z ranges and shares material ids per filament', () => {
    const s = resolveStack(bands, profiles, lh);
    expect(s.map((l) => l.materialId)).toEqual([0, 1, 2, 0]);
    expect(s[1].startZ).toBeCloseTo(0.48, 6);
    expect(s[1].endZ).toBeCloseTo(0.8, 6);
  });

  it('repairs invalid stacks', () => {
    const fixed = normalizeStack([{ filamentId: 'missing', top: 5 }, { filamentId: 'red', top: 3 }], profiles);
    expect(fixed[0].filamentId).toBe('black');
    expect(fixed[1].top).toBe(6);
  });

  it('assigns each layer to the band containing its mid-height', () => {
    const m = materialOfLayers(resolveStack(bands, profiles, lh), lh, 20);
    expect([...m]).toEqual([0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 0, 0, 0, 0]);
  });

  it('builds one closed part per filament, each confined to its own bands', () => {
    const input = paintInput(18, 12, 3);
    const parts = buildPaintingParts(input);
    expect(parts.map((p) => p.name)).toEqual(['Black', 'Red', 'White']);
    let volume = 0;
    parts.forEach((p, m) => {
      volume += expectClosed(p.mesh);
      const ranges = input.stack.filter((s) => s.materialId === m);
      for (let i = 2; i < p.mesh.positions.length; i += 3) {
        const z = p.mesh.positions[i];
        expect(ranges.some((r) => z >= r.startZ - 1e-5 && z <= r.endZ + 1e-5), `${p.name} z=${z}`).toBe(true);
      }
    });
    const expected = input.heights.reduce((s, h) => s + h * 0.25, 0);
    expect(volume).toBeCloseTo(expected, 4);
  });

  it('reads correctly from the top: image column 0 at x = 0', () => {
    // Left column tall enough to reach white, right column stays black.
    const heights = Float32Array.from([16, 3, 16, 3], (l) => l * lh);
    const parts = buildPaintingParts({ heights, cols: 2, rows: 2, widthMm: 1, heightMm: 1, baseHeight: 3 * lh, layerHeight: lh, stack: resolveStack(bands, profiles, lh) });
    const white = parts.find((p) => p.name === 'White')!;
    const xs = [...white.mesh.positions].filter((_, i) => i % 3 === 0);
    expect(Math.max(...xs)).toBeLessThanOrEqual(0.5 + 1e-6);
  });

  it('packages a 3MF with base materials, one component per part and slot assignments', () => {
    const { bytes, parts } = buildPainting3mf(paintInput(10, 8, 9));
    const files = unzipSync(bytes);
    expect(Object.keys(files).sort()).toEqual(['3D/3dmodel.model', 'Metadata/model_settings.config', '[Content_Types].xml', '_rels/.rels'].sort());
    const xml = strFromU8(files['3D/3dmodel.model']);
    expect(xml.match(/<base /g)?.length).toBe(parts);
    expect(xml.match(/<component /g)?.length).toBe(parts);
    expect(xml).toContain('pid="1" pindex="2"');
    const cfg = strFromU8(files['Metadata/model_settings.config']);
    expect(cfg).toContain('<metadata key="extruder" value="3"/>');
  });
});

describe('stack suggestion', () => {
  // Dark pixels are near-black, mid pixels red, bright pixels near-white.
  const image = (n: number) =>
    Float32Array.from(Array.from({ length: n }, (_, i) => (i % 3 === 0 ? [0.06, 0.06, 0.06] : i % 3 === 1 ? [0.82, 0.13, 0.13] : [0.95, 0.95, 0.94])).flat());
  const base = { invert: false, minLayers: 4, maxLayers: 24, layerHeight: 0.08, profiles: DEFAULT_PROFILES };
  const bands3: Band[] = [{ filamentId: 'black', top: 10 }, { filamentId: 'red', top: 18 }, { filamentId: 'white', top: 30 }];

  it('picks dark → red → light from the profiles, within 4 AMS slots', async () => {
    const { bands } = await suggestStack({ ...base, srgb: image(300) });
    const names = bands.map((b) => DEFAULT_PROFILES.find((p) => p.id === b.filamentId)!.name);
    expect(new Set(names).size).toBeLessThanOrEqual(4);
    expect(names.some((n) => ['Red', 'Orange', 'Magenta', 'Brown'].includes(n))).toBe(true);
    expect(['Black', 'Charcoal', 'Brown']).toContain(names[0]);
    expect(['White', 'Ivory']).toContain(names[names.length - 1]);
    for (let i = 1; i < bands.length; i++) expect(bands[i].top).toBeGreaterThan(bands[i - 1].top);
    expect(bands[bands.length - 1].top).toBeLessThanOrEqual(80);
  });

  it('color-match heights put each color at the height that prints it', () => {
    const stack = resolveStack(bands3, DEFAULT_PROFILES, 0.08);
    const path = pathLabs(bandOptics(stack, 0.08), 0.08, 1, 30);
    const at = (r: number, g: number, b: number) => {
      const t = [0, 0, 0];
      targetLab(r, g, b, t);
      return bestLayer(path, 1, t[0], t[1], t[2]);
    };
    const black = at(0.08, 0.08, 0.08), red = at(0.78, 0.06, 0.18), white = at(0.95, 0.95, 0.93);
    expect(black).toBeLessThanOrEqual(10);
    expect(red).toBeGreaterThan(10);
    expect(red).toBeLessThanOrEqual(18);
    expect(white).toBeGreaterThan(18);
  });

  /** Port of matchLayers() in the preview shader (paint/preview.ts), statement for statement. */
  function shaderMatchLayers(stack: StackLayer[], lh: number, minL: number, maxL: number, srgb: number[]) {
    const cw = Math.sqrt(CHROMA_WEIGHT);
    const lab = (c: number[]) => {
      const o = [0, 0, 0];
      linearToOklab(c[0], c[1], c[2], o);
      return [o[0], o[1] * cw, o[2] * cw];
    };
    const target = lab(srgb.map(srgbToLinear));
    let best = minL, bestErr = 1e9;
    let below = [0, 0, 0];
    for (const l of stack) {
      const s = Math.floor(l.startZ / lh + 0.5), e = Math.floor(l.endZ / lh + 0.5);
      const col = hexToRgb(l.colorHex).map(srgbToLinear);
      const k = (K_TD / Math.max(l.td, TD_FLOOR)) * lh;
      const mix = (t: number) => col.map((c, ch) => c + (below[ch] - c) * t);
      for (let h = Math.max(s + 1, minL); h <= Math.min(e, maxL); h++) {
        const d = lab(mix(Math.exp(-k * (h - s)))).map((v, ch) => v - target[ch]);
        const err = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
        if (err < bestErr - MATCH_TIE) {
          bestErr = err;
          best = h;
        }
      }
      below = mix(Math.exp(-k * (e - s)));
    }
    return best;
  }

  it('CPU height matching picks the same layer as the preview shader', () => {
    const lh = 0.08;
    // Includes a TD below TD_FLOOR so both paths must clamp it the same way.
    const profiles = [...DEFAULT_PROFILES, { id: 'thin', name: 'Thin', color: '#2040c0', td: 0.01 }];
    let s = 7;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let trial = 0; trial < 12; trial++) {
      const bands: Band[] = [];
      let top = 0;
      for (let b = 0; b < 2 + (trial % 4); b++) bands.push({ filamentId: profiles[Math.floor(rnd() * profiles.length)].id, top: (top += 1 + Math.floor(rnd() * 8)) });
      const stack = resolveStack(normalizeStack(bands, profiles), profiles, lh);
      const maxL = Math.round(stack[stack.length - 1].endZ / lh);
      const minL = 1 + (trial % 3);
      const path = pathLabs(bandOptics(stack, lh), lh, minL, maxL);
      for (let p = 0; p < 40; p++) {
        const px = [rnd(), rnd(), rnd()];
        const t = [0, 0, 0];
        targetLab(px[0], px[1], px[2], t);
        expect(bestLayer(path, minL, t[0], t[1], t[2])).toBe(shaderMatchLayers(stack, lh, minL, maxL, px));
      }
    }
  });

  it('respects a smaller slot budget and only uses given profiles', async () => {
    const profiles = DEFAULT_PROFILES.filter((p) => ['black', 'white', 'blue'].includes(p.id));
    const { bands } = await suggestStack({ ...base, profiles, maxFilaments: 2, srgb: image(90) });
    expect(new Set(bands.map((b) => b.filamentId)).size).toBeLessThanOrEqual(2);
    expect(bands.every((b) => profiles.some((p) => p.id === b.filamentId))).toBe(true);
  });

  it('never spends two AMS slots on near-identical colors', async () => {
    const { bands } = await suggestStack({ ...base, srgb: image(300) });
    const ids = new Set(bands.map((b) => b.filamentId));
    expect(ids.has('white') && ids.has('ivory')).toBe(false);
  });
});

describe('3mf', () => {
  it('writes a package with one component per part', () => {
    const r = run(randomImage(6, 6), 6, 6);
    const parts = buildLithoParts(r, 0.02);
    expect(parts[0].name).toBe('Base - White');
    const files = unzipSync(write3mfSync(parts));
    expect(Object.keys(files).sort()).toEqual(
      ['3D/3dmodel.model', 'Metadata/model_settings.config', '[Content_Types].xml', '_rels/.rels'].sort(),
    );
    const xml = strFromU8(files['3D/3dmodel.model']);
    expect(xml.match(/<component /g)?.length).toBe(parts.length);
    expect(xml).toContain('<build>');
  });
});

describe('Kubelka-Munk optics', () => {
  it('converges to the filament color when thick', () => {
    const f = filamentOptics('#c8102e', 0.4, 0.08, 40);
    const c = [0, 0, 0];
    stackOn(f, 40, c);
    [0xc8, 0x10, 0x2e].forEach((v, ch) => expect(c[ch]).toBeCloseTo(Math.max(0.002, srgbToLinear(v / 255)), 2));
  });

  it('leaves TD_CONTRAST of the background visible after one TD', () => {
    const f = filamentOptics('#1f8a3c', 0.8, 0.08, 16);
    let worst = 0;
    for (let ch = 0; ch < 3; ch++) {
      const white = [1, 1, 1], black = [0, 0, 0];
      stackOn(f, 10, white);
      stackOn(f, 10, black);
      worst = Math.max(worst, white[ch] - black[ch]);
    }
    expect(worst).toBeCloseTo(TD_CONTRAST, 3);
  });

  it('makes translucent filaments act as filters (subtractive, not a blend)', () => {
    const red = filamentOptics('#d0102a', 8, 0.08, 16);
    const yellow = [...[0xf5 / 255, 0xc4 / 255, 0].map(srgbToLinear)];
    const onWhite = [0.9, 0.9, 0.9];
    stackOn(red, 3, onWhite);
    expect(onWhite[0]).toBeGreaterThan(0.5);
    expect(onWhite[1]).toBeLessThan(onWhite[0] / 3);
    const onYellow = [...yellow];
    stackOn(red, 3, onYellow);
    // Green is absorbed, red passes: the result is darker in green than both the yellow and a 50/50 mix.
    expect(onYellow[1]).toBeLessThan(yellow[1] * 0.5);
    expect(onYellow[0]).toBeGreaterThan(0.4);
  });
});

describe('filament mosaic', () => {
  const loadout: MosaicFilament[] = [
    { name: 'Black', color: '#141414', td: 0.6 },
    { name: 'White', color: '#f2f2ee', td: 2.5 },
    { name: 'Red', color: '#d0102a', td: 6 },
    { name: 'Blue', color: '#1f4fd8', td: 4 },
  ];
  const cfg: ComboConfig = { layerHeight: 0.08, groundLayers: 4, tintLayers: 8, maxSegments: 3 };
  const optics = loadoutOptics(loadout, cfg);

  it('enumerates every valid combo once', () => {
    const set = buildCombos(loadout, optics, cfg, false);
    // 1 bare ground + 3·C(8,1) + 3·3·C(8,2) + 3·3·3·C(8,3)
    expect(set.count).toBe(1 + 24 + 252 + 1512);
    for (let r = 0; r < set.count; r++) {
      const s0 = set.segStart[r], s1 = set.segStart[r + 1];
      expect(s1 - s0).toBeLessThanOrEqual(3);
      let total = 0;
      for (let s = s0; s < s1; s++) {
        total += set.segLen[s];
        if (s === s0) expect(set.segFil[s]).not.toBe(0);
        else expect(set.segFil[s]).not.toBe(set.segFil[s - 1]);
      }
      expect(total).toBe(set.layers[r]);
      expect(total).toBeLessThanOrEqual(8);
    }
    const deduped = buildCombos(loadout, optics, cfg);
    expect(deduped.count).toBeLessThan(set.count);
    expect(deduped.count).toBeGreaterThan(50);
  });

  it('k-d tree finds the true nearest neighbour', () => {
    const pts = Float32Array.from(randomImage(500, 1, 7).flat());
    const tree = new KdTree(pts);
    for (const [x, y, z] of randomImage(200, 1, 8)) {
      let best = -1, bestD = Infinity;
      for (let i = 0; i < 500; i++) {
        const d = (pts[i * 3] - x) ** 2 + (pts[i * 3 + 1] - y) ** 2 + (pts[i * 3 + 2] - z) ** 2;
        if (d < bestD) { bestD = d; best = i; }
      }
      expect(tree.nearest(x, y, z)).toBe(best);
    }
  });

  it('reaches colors off the single band curve: pink, navy, white and black side by side', () => {
    const set = buildCombos(loadout, optics, cfg);
    const srgb = Float32Array.from([[0.95, 0.55, 0.62], [0.08, 0.12, 0.4], [0.93, 0.93, 0.92], [0.05, 0.05, 0.05]].flat());
    const res = solveMosaic(srgb, 4, 1, 0, set, new KdTree(set.lab), { stepped: true, dither: false, minIsland: 0, frameLayers: 1 });
    const segs = (p: number) => {
      const r = res.combo[p], out: number[] = [];
      for (let s = set.segStart[r]; s < set.segStart[r + 1]; s++) out.push(set.segFil[s]);
      return out;
    };
    expect(segs(0)).toContain(1);
    expect(segs(0)).toContain(2);
    expect(segs(1)).toContain(3);
    expect(segs(2)[segs(2).length - 1]).toBe(1);
    expect(res.layers[3]).toBeLessThan(res.layers[2]);
  });

  it('merges small islands into the closest neighbouring combo', () => {
    const set = buildCombos(loadout, optics, cfg);
    const combo = new Int32Array(25).fill(5);
    combo[12] = 9;
    combo[0] = -1;
    mergeIslands(combo, 5, 5, set, 2);
    expect(combo[12]).toBe(5);
    expect(combo[0]).toBe(-1);
  });

  const exportOf = (res: ReturnType<typeof solveMosaic>): MosaicExportInput => {
    const { voxels, K } = mosaicVoxels(res);
    return { kind: 'mosaic', voxels, cols: res.cols, rows: res.rows, K, widthMm: res.cols * 0.4, heightMm: res.rows * 0.4, layerHeight: 0.08, filaments: loadout };
  };

  for (const stepped of [true, false])
    it(`exports closed per-filament meshes whose volumes add up (${stepped ? 'stepped' : 'level'})`, () => {
      const set = buildCombos(loadout, optics, cfg);
      const cols = 14, rows = 9;
      const res = solveMosaic(Float32Array.from(randomImage(cols, rows, 4).flat()), cols, rows, 2, set, new KdTree(set.lab), { stepped, dither: true, minIsland: 0, frameLayers: 6 });
      if (!stepped) for (let p = 0; p < res.combo.length; p++) if (res.combo[p] >= 0) expect(res.layers[p]).toBe(4 + 8);
      const parts = buildMosaicParts(exportOf(res));
      let volume = 0;
      for (const p of parts) volume += expectClosed(p.mesh);
      const expected = [...res.layers].reduce((s, l) => s + l * 0.08 * 0.16, 0);
      expect(volume).toBeCloseTo(expected, 3);
      const st = mosaicStats(res);
      expect(st.combos).toBeGreaterThan(1);
      expect(st.share[0]).toBe(1);
    });

  it('builds a swatch plate with a notch and closed meshes', () => {
    const rows = swatchRows(loadout);
    expect(rows.map((r) => r.label)).toEqual([
      'White ramp: 1–8 layers',
      'Red: 1, 2, 3, 5 layers on ground | on White',
      'Blue: 1, 2, 3, 5 layers on ground | on White',
      'Layered pairs (lower → upper)',
    ]);
    const set = combosFromList(loadout, optics, cfg, rows.flatMap((r) => r.swatches));
    const res = swatchPlate(rows, set, 0.4);
    expect(res.combo[0]).toBe(EMPTY);
    expect(res.layers[0]).toBe(0);
    const parts = buildMosaicParts(exportOf(res));
    expect(parts).toHaveLength(4);
    for (const p of parts) expectClosed(p.mesh);
  });

  it('picks a default loadout and repairs stored ones', () => {
    const ids = defaultLoadout(DEFAULT_PROFILES, 4);
    expect(ids[0]).toBe('black');
    expect(ids[1]).toBe('white');
    expect(ids).toHaveLength(4);
    expect(normalizeLoadout(['white', 'nope', 'white', 'red'], DEFAULT_PROFILES, 4)).toEqual(['white', 'red']);
    expect(normalizeLoadout('garbage', DEFAULT_PROFILES, 4)).toEqual(ids);
  });

  it('auto-picks a loadout at least as good as the default one', async () => {
    const srgb = Float32Array.from(Array.from({ length: 200 }, (_, i) => [[0.95, 0.55, 0.62], [0.08, 0.12, 0.4], [0.93, 0.93, 0.92], [0.05, 0.05, 0.05]][i % 4]).flat());
    const cfg2: ComboConfig = { ...cfg, tintLayers: 6, maxSegments: 2 };
    const { ids, error } = await pickLoadout({ srgb, profiles: DEFAULT_PROFILES, slots: 4, config: cfg2 });
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeLessThanOrEqual(4);
    const def = defaultLoadout(DEFAULT_PROFILES, 4).map((id) => DEFAULT_PROFILES.find((p) => p.id === id)!);
    const defSet = buildCombos(def, loadoutOptics(def, cfg2), cfg2);
    expect(error).toBeLessThanOrEqual(gamutError(defSet, sampleImage(srgb, false), new KdTree(defSet.lab)) * 1.05);
  }, 30_000);
});
