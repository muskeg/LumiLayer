import { hexToRgb, luma } from '../color';

/** A user filament profile, persisted in localStorage. */
export interface FilamentProfile {
  id: string;
  name: string;
  /** sRGB hex, e.g. "#c8102e". */
  color: string;
  /** Transmission distance (mm): thickness after which only 5% of light gets through. */
  td: number;
}

/** One band of the layer stack. Bands are ordered bottom to top; each ends where the next begins. */
export interface Band {
  filamentId: string;
  /** Exclusive top of the band, in layers from the bed. */
  top: number;
}

/** A resolved band in physical units, as consumed by the shader and the 3MF exporter. */
export interface StackLayer {
  name: string;
  colorHex: string;
  td: number;
  startZ: number;
  endZ: number;
  /** Index into the distinct filaments of the stack (3MF base material / slicer filament slot - 1). */
  materialId: number;
}

export const MAX_BANDS = 16;
export const MAX_LAYERS = 80;
/** Stack suggestion and loadout auto-pick enumerate up to 4-filament sequences, so their cost grows ~P⁴. */
export const MAX_PROFILES = 32;
export const TD_MIN = 0.1;
export const TD_MAX = 20;
/** Luminance texture value marking frame pixels, which use the frame height instead. */
export const FRAME_SENTINEL = -1;

const PROFILES_KEY = 'lumilayer.filaments.v1';
const STACK_KEY = 'lumilayer.stack.v1';

export const DEFAULT_PROFILES: FilamentProfile[] = [
  { id: 'black', name: 'Black', color: '#141414', td: 0.6 },
  { id: 'charcoal', name: 'Charcoal', color: '#3a3a3a', td: 0.8 },
  { id: 'gray', name: 'Gray', color: '#8a8a8a', td: 1.2 },
  { id: 'white', name: 'White', color: '#f2f2ee', td: 2.5 },
  { id: 'ivory', name: 'Ivory', color: '#efe6d0', td: 2.5 },
  { id: 'brown', name: 'Brown', color: '#6b4226', td: 1 },
  { id: 'red', name: 'Red', color: '#c8102e', td: 1.2 },
  { id: 'orange', name: 'Orange', color: '#f06a1e', td: 1.8 },
  { id: 'yellow', name: 'Yellow', color: '#f5c400', td: 2.5 },
  { id: 'green', name: 'Green', color: '#1f8a3c', td: 1.5 },
  { id: 'cyan', name: 'Cyan', color: '#00a0e0', td: 1.8 },
  { id: 'blue', name: 'Blue', color: '#1f4fd8', td: 1.2 },
  { id: 'magenta', name: 'Magenta', color: '#d0007a', td: 1.5 },
];

export const DEFAULT_STACK: Band[] = [
  { filamentId: 'black', top: 8 },
  { filamentId: 'red', top: 12 },
  { filamentId: 'yellow', top: 16 },
  { filamentId: 'white', top: 24 },
];

const HEX = /^#[0-9a-f]{6}$/i;
const clampTd = (td: number) => Math.min(TD_MAX, Math.max(TD_MIN, td));

function sanitizeProfile(v: unknown): FilamentProfile | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id || typeof o.color !== 'string' || !HEX.test(o.color)) return null;
  const td = Number(o.td);
  if (!Number.isFinite(td)) return null;
  const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 40) : 'Filament';
  return { id: o.id.slice(0, 64), name, color: o.color.toLowerCase(), td: clampTd(td) };
}

function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or disabled (private mode): keep working in memory.
  }
}

export function loadProfiles(): FilamentProfile[] {
  const data = readJson(PROFILES_KEY);
  const list = Array.isArray(data) ? data.map(sanitizeProfile).filter((p): p is FilamentProfile => !!p) : [];
  const unique = list.filter((p, i) => list.findIndex((q) => q.id === p.id) === i).slice(0, MAX_PROFILES);
  return unique.length ? unique : structuredClone(DEFAULT_PROFILES);
}

export const saveProfiles = (profiles: FilamentProfile[]) => writeJson(PROFILES_KEY, profiles);

/** Repair a stack so it references existing profiles and has strictly increasing tops within limits. */
export function normalizeStack(bands: Band[], profiles: FilamentProfile[]): Band[] {
  const ids = new Set(profiles.map((p) => p.id));
  const out: Band[] = [];
  let prev = 0;
  for (const b of bands.slice(0, MAX_BANDS)) {
    const top = Math.min(MAX_LAYERS, Math.max(prev + 1, Math.round(Number(b.top) || 0)));
    if (top <= prev) break;
    out.push({ filamentId: ids.has(b.filamentId) ? b.filamentId : profiles[0].id, top });
    prev = top;
  }
  return out.length ? out : [{ filamentId: profiles[0].id, top: Math.min(MAX_LAYERS, 20) }];
}

export function loadStack(profiles: FilamentProfile[]): Band[] {
  const data = readJson(STACK_KEY);
  const bands = Array.isArray(data)
    ? data.filter((b): b is Band => !!b && typeof b === 'object' && typeof (b as Band).filamentId === 'string')
    : DEFAULT_STACK;
  return normalizeStack(bands.length ? bands : DEFAULT_STACK, profiles);
}

export const saveStack = (bands: Band[]) => writeJson(STACK_KEY, bands);

const LOADOUT_KEY = 'lumilayer.loadout.v1';

/** Filament mosaic loadout: profile ids, slot 0 is the ground. Unknown ids and duplicates are dropped. */
export function normalizeLoadout(ids: unknown, profiles: FilamentProfile[], slots: number): string[] {
  const known = new Set(profiles.map((p) => p.id));
  const list = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && known.has(id)) : [];
  const out = [...new Set(list)].slice(0, slots);
  return out.length ? out : defaultLoadout(profiles, slots);
}

/** Darkest profile as the ground, then the lightest, then the most saturated ones. */
export function defaultLoadout(profiles: FilamentProfile[], slots: number): string[] {
  const stats = profiles.map((p) => {
    const [r, g, b] = hexToRgb(p.color);
    return { id: p.id, luma: luma(r, g, b), chroma: Math.max(r, g, b) - Math.min(r, g, b) };
  });
  const dark = stats.reduce((a, b) => (b.luma < a.luma ? b : a));
  const light = stats.filter((s) => s !== dark).reduce<(typeof stats)[number] | null>((a, b) => (!a || b.luma > a.luma ? b : a), null);
  const saturated = stats.filter((s) => s !== dark && s !== light).sort((a, b) => b.chroma - a.chroma);
  return [dark, light, ...saturated].filter((s): s is (typeof stats)[number] => !!s).slice(0, slots).map((s) => s.id);
}

export const restoreLoadout = (profiles: FilamentProfile[], slots: number) => normalizeLoadout(readJson(LOADOUT_KEY), profiles, slots);

export const storeLoadout = (ids: string[]) => writeJson(LOADOUT_KEY, ids);

/**
 * Printed height of a pixel in whole layers (round half up). The preview shader uses the identical
 * formula, so what you see is exactly what gets exported.
 */
export function layersFromLuminance(lum: number, minLayers: number, maxLayers: number, frameLayers: number): number {
  if (lum < 0) return frameLayers;
  return Math.floor(minLayers + lum * (maxLayers - minLayers) + 0.5);
}

/** Resolve bands against profiles into physical Z ranges with material ids (one per distinct filament). */
export function resolveStack(bands: Band[], profiles: FilamentProfile[], layerHeight: number): StackLayer[] {
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const materials: string[] = [];
  let start = 0;
  return bands.map((b) => {
    const p = byId.get(b.filamentId) ?? profiles[0];
    let materialId = materials.indexOf(p.id);
    if (materialId < 0) materialId = materials.push(p.id) - 1;
    const layer: StackLayer = { name: p.name, colorHex: p.color, td: p.td, startZ: start * layerHeight, endZ: b.top * layerHeight, materialId };
    start = b.top;
    return layer;
  });
}

export function newProfileId(existing: FilamentProfile[]): string {
  let i = existing.length + 1;
  while (existing.some((p) => p.id === `custom-${i}`)) i++;
  return `custom-${i}`;
}
