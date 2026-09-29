import { buildLayerBandMeshes, buildVoxelMeshes } from '../mesh';
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

/** Input of the mosaic exporter: a voxel grid of loadout slots (also a Web Worker message). */
export interface MosaicExportInput {
  kind: 'mosaic';
  /** Loadout slot per voxel at ((row * cols + col) * K + k), 255 = empty; row 0 = top edge of the image. */
  voxels: Uint8Array;
  cols: number;
  rows: number;
  K: number;
  widthMm: number;
  heightMm: number;
  layerHeight: number;
  /** Loadout, slot 0 = ground. */
  filaments: { name: string; color: string }[];
  title?: string;
}

export function buildMosaicParts(input: MosaicExportInput): Part[] {
  const { cols, rows, K, voxels, filaments } = input;
  if (voxels.length !== cols * rows * K) throw new Error('Voxel grid size does not match its dimensions.');
  const meshes = buildVoxelMeshes({
    cols, rows, K, voxels,
    pixelMm: input.widthMm / cols,
    pixelMmY: input.heightMm / rows,
    layerHeight: input.layerHeight,
    materialCount: filaments.length,
  });
  const parts: Part[] = [];
  meshes.forEach((mesh, m) => {
    if (mesh) parts.push({ name: filaments[m].name, color: filaments[m].color, extruder: m + 1, mesh });
  });
  return parts;
}

export function buildMosaic3mf(input: MosaicExportInput): PaintExportResult {
  const parts = buildMosaicParts(input);
  const bytes = write3mfSync(parts, input.title ?? 'LumiLayer filament mosaic');
  return { bytes, triangles: parts.reduce((n, p) => n + p.mesh.indices.length / 3, 0), parts: parts.length };
}
