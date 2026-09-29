import { buildLayerBandMeshes } from '../mesh';
import { write3mfSync, type Part } from '../threemf';
import type { StackLayer } from './model';

/** Input of the painting exporter (also the Web Worker message). */
export interface PaintExportInput {
  /** Printed height (mm) of each pixel, row-major, row 0 = top edge of the image. */
  heights: Float32Array;
  cols: number;
  rows: number;
  /** Model footprint in mm. */
  widthMm: number;
  heightMm: number;
  /** Minimum printed height (mm); pixels are never lower than this. */
  baseHeight: number;
  layerHeight: number;
  /** Bands bottom to top; bands sharing a filament share a materialId. */
  stack: StackLayer[];
  title?: string;
}

export interface PaintExportResult {
  bytes: Uint8Array;
  triangles: number;
  parts: number;
}

/** Material id of each layer index, from the band containing the layer's mid-height. */
export function materialOfLayers(stack: StackLayer[], layerHeight: number, layerCount: number): Int32Array {
  const out = new Int32Array(Math.max(1, layerCount));
  for (let k = 0; k < out.length; k++) {
    const z = (k + 0.5) * layerHeight;
    const band = stack.find((s) => z >= s.startZ && z < s.endZ) ?? stack[stack.length - 1];
    out[k] = band.materialId;
  }
  return out;
}

/** Split the heightfield into one closed part per filament, each spanning only its Z bands. */
export function buildPaintingParts(input: PaintExportInput): Part[] {
  const { heights, cols, rows, layerHeight: lh, stack } = input;
  if (!stack.length) throw new Error('The layer stack is empty.');
  if (heights.length !== cols * rows) throw new Error('Heightmap size does not match its dimensions.');
  const minLayers = Math.max(1, Math.round(input.baseHeight / lh));
  const layers = new Uint16Array(cols * rows);
  let maxLayers = 0;
  for (let i = 0; i < layers.length; i++) {
    const h = Number.isFinite(heights[i]) ? heights[i] : 0;
    layers[i] = Math.max(minLayers, Math.round(h / lh));
    maxLayers = Math.max(maxLayers, layers[i]);
  }
  const materialCount = Math.max(...stack.map((s) => s.materialId)) + 1;
  const meshes = buildLayerBandMeshes({
    cols,
    rows,
    pixelMm: input.widthMm / cols,
    pixelMmY: input.heightMm / rows,
    layerHeight: lh,
    layers,
    materialOfLayer: materialOfLayers(stack, lh, maxLayers),
    materialCount,
  });
  const parts: Part[] = [];
  meshes.forEach((mesh, m) => {
    if (!mesh) return;
    const s = stack.find((l) => l.materialId === m)!;
    parts.push({ name: s.name, color: s.colorHex, extruder: m + 1, mesh });
  });
  return parts;
}

export function buildPainting3mf(input: PaintExportInput): PaintExportResult {
  const parts = buildPaintingParts(input);
  const bytes = write3mfSync(parts, input.title ?? 'LumiLayer painting');
  return { bytes, triangles: parts.reduce((n, p) => n + p.mesh.indices.length / 3, 0), parts: parts.length };
}
