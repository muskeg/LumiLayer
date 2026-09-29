import { EMPTY, FRAME, type MosaicResult, type ComboSet } from './mosaic';

/**
 * Swatch plate: rows of swatches with known combos. Print it, hold it next to the on-screen
 * prediction, and tune each filament's color and TD until they agree.
 */

export interface SwatchRow {
  label: string;
  /** Combo per swatch: [loadout slot, layers] segments, bottom to top. */
  swatches: [number, number][][];
}

/** Swatch edge, gap and margin in mm. */
export const SWATCH_MM = 10;
export const SWATCH_GAP_MM = 2;
export const SWATCH_MARGIN_MM = 3;
const PER_ROW = 8;
const THICKNESSES = [1, 2, 3, 5];
/** Layers of the lightest filament laid under tints. */
const UNDERLAY = 6;

const luma = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
};

/** Rows for a loadout (slot 0 = ground): lightest filament ramp, each tint on the ground and on the lightest, then layered pairs. */
export function swatchRows(filaments: { name: string; color: string }[]): SwatchRow[] {
  if (filaments.length < 2) return [];
  const others = filaments.map((_, i) => i).slice(1);
  const w = others.reduce((a, b) => (luma(filaments[b].color) > luma(filaments[a].color) ? b : a));
  const tints = others.filter((i) => i !== w);
  const rows: SwatchRow[] = [
    { label: `${filaments[w].name} ramp: 1–${PER_ROW} layers`, swatches: Array.from({ length: PER_ROW }, (_, t) => [[w, t + 1]]) },
  ];
  for (const c of tints)
    rows.push({
      label: `${filaments[c].name}: ${THICKNESSES.join(', ')} layers on ground | on ${filaments[w].name}`,
      swatches: [...THICKNESSES.map((t): [number, number][] => [[c, t]]), ...THICKNESSES.map((t): [number, number][] => [[w, UNDERLAY], [c, t]])],
    });
  const pairs: [number, number][][] = [];
  for (const a of tints) for (const b of tints) if (a !== b) pairs.push([[w, UNDERLAY], [a, 2], [b, 2]]);
  for (const a of tints) pairs.push([[w, UNDERLAY], [a, 2], [w, 1]]);
  for (const a of tints) pairs.push([[a, 3], [w, 2]]);
  if (pairs.length) rows.push({ label: 'Layered pairs (lower → upper)', swatches: pairs.slice(0, PER_ROW) });
  return rows;
}

export interface SwatchGeometry {
  cols: number;
  rows: number;
  /** Top-left tile of swatch i in row r. */
  swatchAt: (r: number, i: number) => { x: number; y: number };
  swatchTiles: number;
}

export function swatchGeometry(rows: SwatchRow[], pixelMm: number): SwatchGeometry {
  const tiles = (mm: number) => Math.max(1, Math.round(mm / pixelMm));
  const size = tiles(SWATCH_MM), gap = tiles(SWATCH_GAP_MM), margin = tiles(SWATCH_MARGIN_MM);
  const perRow = Math.max(1, ...rows.map((r) => r.swatches.length));
  return {
    cols: 2 * margin + perRow * size + (perRow - 1) * gap,
    rows: 2 * margin + rows.length * size + Math.max(0, rows.length - 1) * gap,
    swatchAt: (r, i) => ({ x: margin + i * (size + gap), y: margin + r * (size + gap) }),
    swatchTiles: size,
  };
}

/**
 * The plate as a mosaic: swatches on a ground plate, stepped heights, and a notch cut into the
 * top-left corner so the printed plate can't be read upside down.
 */
export function swatchPlate(rows: SwatchRow[], set: ComboSet, pixelMm: number): MosaicResult {
  const g = swatchGeometry(rows, pixelMm);
  const combo = new Int32Array(g.cols * g.rows).fill(FRAME);
  let k = 0;
  rows.forEach((row, r) =>
    row.swatches.forEach((_, i) => {
      const { x, y } = g.swatchAt(r, i);
      for (let yy = y; yy < y + g.swatchTiles; yy++) combo.fill(k, yy * g.cols + x, yy * g.cols + x + g.swatchTiles);
      k++;
    }),
  );
  const notch = Math.max(1, Math.round(SWATCH_MARGIN_MM / pixelMm) - 1);
  for (let y = 0; y < notch; y++) combo.fill(EMPTY, y * g.cols, y * g.cols + notch);
  const layers = new Uint16Array(combo.length);
  for (let p = 0; p < combo.length; p++) layers[p] = combo[p] === EMPTY ? 0 : set.groundLayers + (combo[p] >= 0 ? set.layers[combo[p]] : 0);
  return { cols: g.cols, rows: g.rows, combo, layers, set, stepped: true };
}
