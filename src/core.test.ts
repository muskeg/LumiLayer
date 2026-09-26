import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { buildSolver, solve, type LithoParams } from './lithophane';
import { buildPrintMeshes, type Mesh } from './mesh';
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

/** Every directed edge must be matched by its reverse for a closed, consistently oriented surface. */
function expectClosed(mesh: Mesh) {
  const edges = new Map<string, number>();
  const { indices: ix, positions: p } = mesh;
  for (let t = 0; t < ix.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = ix[t + e], b = ix[t + ((e + 1) % 3)];
      edges.set(`${a},${b}`, (edges.get(`${a},${b}`) ?? 0) + 1);
    }
  }
  for (const [k, n] of edges) {
    const [a, b] = k.split(',');
    expect(edges.get(`${b},${a}`), `edge ${k}`).toBe(n);
  }
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

  it('handles monochrome (no color layers)', () => {
    const p = params({ colorLayers: 0 });
    const r = run(randomImage(5, 4), 5, 4, p);
    const meshes = buildPrintMeshes(r);
    expect(meshes.slice(1).every((m) => m === null)).toBe(true);
    expectClosed(meshes[0]!);
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
