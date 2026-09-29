import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { buildSolver, solve, type LithoParams } from './lithophane';
import { buildPrintMeshes, type Mesh } from './mesh';
import { buildPainting3mf, buildPaintingParts, materialOfLayers, type PaintExportInput } from './paint/export';
import { DEFAULT_PROFILES, FRAME_SENTINEL, layersFromLuminance, normalizeStack, resolveStack, type Band, type FilamentProfile } from './paint/model';
import { suggestStack } from './paint/suggest';
import { bandOptics, bestLayer, pathLabs, targetLab } from './paint/optics';
import { write3mf } from './threemf';

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
  it('writes a package with one component per part', async () => {
    const r = run(randomImage(6, 6), 6, 6);
    const meshes = buildPrintMeshes(r);
    const parts = meshes.flatMap((m, i) =>
      m ? [{ name: r.filaments[i].name, color: r.filaments[i].color, extruder: i + 1, mesh: m }] : [],
    );
    const files = unzipSync(await write3mf(parts));
    expect(Object.keys(files).sort()).toEqual(
      ['3D/3dmodel.model', 'Metadata/model_settings.config', '[Content_Types].xml', '_rels/.rels'].sort(),
    );
    const xml = strFromU8(files['3D/3dmodel.model']);
    expect(xml.match(/<component /g)?.length).toBe(parts.length);
    expect(xml).toContain('<build>');
  });
});
