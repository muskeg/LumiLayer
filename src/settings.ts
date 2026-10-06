import type { Filament } from './color';

/** App settings, the control panel table and the framing grid. No DOM. */

export type Mode = 'litho' | 'paint' | 'mosaic';

export interface Settings {
  mode: Mode;
  widthMm: number;
  aspect: string;
  rotation: number;
  flip: boolean;
  zoom: number;
  panX: number;
  panY: number;
  borderMm: number;
  frameThickness: number;
  brightness: number;
  contrast: number;
  gamma: number;
  saturation: number;
  layerHeight: number;
  pixelMm: number;
  meshTolerance: number;
  minThickness: number;
  maxThickness: number;
  baseLayers: number;
  heightMode: 'match' | 'luminance';
  invert: boolean;
  colorLayers: number;
  colorPriority: number;
  colorCellMm: number;
  dither: boolean;
  tintLayers: number;
  tileSegments: number;
  surface: 'stepped' | 'level';
  minIsland: number;
  mosaicDither: boolean;
  lightColor: string;
  exposure: number;
}

export type Key = keyof Settings;
export type Ctl = (
  | { type: 'range' | 'number'; key: Key; label: string; min: number; max: number; step: number; unit?: string; hint?: string }
  | { type: 'select' | 'seg'; key: Key; label: string; options: [string, string][]; numeric?: boolean; hint?: string }
  | { type: 'checkbox' | 'color'; key: Key; label: string; hint?: string }
) & { modes?: Mode[]; advanced?: boolean };

/** Panels built by a mode's own code and appended to a section. */
export type ExtraPanel = 'lithoFilaments' | 'stack' | 'loadout' | 'filaments';

/** One workflow step of the inspector. */
export interface Section {
  title: string;
  open?: boolean;
  modes?: Mode[];
  controls: Ctl[];
  extra?: ExtraPanel;
  /** One-line summary shown in the step header. */
  summary?: (s: Settings) => string;
  /** Adds a button that resets this section's controls to their defaults. */
  resetLabel?: string;
}

export const DEFAULTS: Settings = {
  mode: 'litho',
  widthMm: 100,
  aspect: 'original',
  rotation: 0,
  flip: false,
  zoom: 1,
  panX: 0,
  panY: 0,
  borderMm: 3,
  frameThickness: 4,
  brightness: 0,
  contrast: 0,
  gamma: 1,
  saturation: 1.15,
  layerHeight: 0.1,
  pixelMm: 0.2,
  meshTolerance: 0.03,
  minThickness: 0.6,
  maxThickness: 3,
  baseLayers: 6,
  heightMode: 'match',
  invert: false,
  colorLayers: 5,
  colorPriority: 1,
  colorCellMm: 0.4,
  dither: true,
  tintLayers: 8,
  tileSegments: 3,
  surface: 'stepped',
  minIsland: 3,
  mosaicDither: false,
  lightColor: '#fff4e2',
  exposure: 1,
};

/** Settings applied when switching mode. */
export const MODE_DEFAULTS: Record<Mode, Partial<Settings>> = {
  litho: { layerHeight: 0.1, frameThickness: 4, lightColor: '#fff4e2', pixelMm: 0.2 },
  paint: { layerHeight: 0.08, frameThickness: 1.2, lightColor: '#ffffff', pixelMm: 0.2, baseLayers: 6 },
  // One tile per nozzle width; a 7 × 0.08 mm ground.
  mosaic: { layerHeight: 0.08, frameThickness: 1.2, lightColor: '#ffffff', pixelMm: 0.4, baseLayers: 7 },
};

/** 'main' is how the print is meant to be seen; 'alt' is the secondary 2D view. */
export const VIEW_LABELS: Record<Mode, { main: string; alt: string }> = {
  litho: { main: 'Backlit', alt: 'Unlit (front)' },
  paint: { main: 'Front-lit', alt: 'Backlit' },
  mosaic: { main: 'Front-lit', alt: 'Swatches' },
};

export const LITHO_PRESETS: Record<string, Filament[]> = {
  'CMY + White': [
    { name: 'White', color: '#ffffff', td: 1.8, enabled: true },
    { name: 'Cyan', color: '#00a0e0', td: 2.5, enabled: true },
    { name: 'Magenta', color: '#e0007a', td: 2.5, enabled: true },
    { name: 'Yellow', color: '#ffe000', td: 4, enabled: true },
  ],
  'Warm (White + Red + Yellow + Blue)': [
    { name: 'White', color: '#ffffff', td: 1.8, enabled: true },
    { name: 'Red', color: '#d81e1e', td: 2, enabled: true },
    { name: 'Yellow', color: '#ffd000', td: 4, enabled: true },
    { name: 'Blue', color: '#1f4fd8', td: 1.5, enabled: true },
  ],
  'Duotone (White + Blue)': [
    { name: 'White', color: '#ffffff', td: 1.8, enabled: true },
    { name: 'Blue', color: '#1f6fd8', td: 2, enabled: true },
    { name: 'Magenta', color: '#e0007a', td: 2.5, enabled: false },
    { name: 'Yellow', color: '#ffe000', td: 4, enabled: false },
  ],
  'Classic (White only)': [
    { name: 'White', color: '#ffffff', td: 1.8, enabled: true },
    { name: 'Cyan', color: '#00a0e0', td: 2.5, enabled: false },
    { name: 'Magenta', color: '#e0007a', td: 2.5, enabled: false },
    { name: 'Yellow', color: '#ffe000', td: 4, enabled: false },
  ],
};

export const DEFAULT_LITHO_PRESET = 'CMY + White';

const ASPECTS: [string, string][] = [
  ['original', 'Photo'],
  ['1', '1:1'],
  ['1.3333', '4:3'],
  ['0.75', '3:4'],
  ['1.5', '3:2'],
  ['0.6667', '2:3'],
  ['1.7778', '16:9'],
  ['0.5625', '9:16'],
  ['1.4', '7:5'],
  ['0.7143', '5:7'],
];
const aspectLabel = (v: string) => ASPECTS.find(([k]) => k === v)?.[1] ?? v;

/** The inspector, in workflow order: framing, filaments, look, print. Steps are numbered per mode. */
export const SECTIONS: Section[] = [
  {
    title: 'Photo & framing',
    open: true,
    summary: (s) => `${s.widthMm} mm · ${aspectLabel(s.aspect)}${s.borderMm ? ` · ${s.borderMm} mm frame` : ''}`,
    controls: [
      { type: 'number', key: 'widthMm', label: 'Width', min: 20, max: 300, step: 1, unit: 'mm' },
      { type: 'select', key: 'aspect', label: 'Aspect', options: ASPECTS },
      { type: 'seg', key: 'rotation', label: 'Rotate', numeric: true, options: [['0', '0°'], ['90', '90°'], ['180', '180°'], ['270', '270°']] },
      { type: 'checkbox', key: 'flip', label: 'Mirror' },
      { type: 'number', key: 'borderMm', label: 'Frame width', min: 0, max: 30, step: 0.5, unit: 'mm' },
      { type: 'number', key: 'frameThickness', label: 'Frame height', min: 0.2, max: 12, step: 0.1, unit: 'mm' },
      { type: 'range', key: 'zoom', label: 'Zoom', min: 1, max: 6, step: 0.01, unit: '×', hint: 'Or scroll on the preview', advanced: true },
      { type: 'range', key: 'panX', label: 'Pan X', min: -1, max: 1, step: 0.01, hint: 'Or drag the preview', advanced: true },
      { type: 'range', key: 'panY', label: 'Pan Y', min: -1, max: 1, step: 0.01, hint: 'Or drag the preview', advanced: true },
    ],
  },
  {
    title: 'Color & filaments',
    open: true,
    modes: ['litho'],
    summary: (s) => (s.colorLayers ? `${s.colorLayers} color layers${s.dither ? ' · dithered' : ''}` : 'Monochrome'),
    controls: [
      { type: 'range', key: 'colorLayers', label: 'Color layers', min: 0, max: 10, step: 1, hint: 'Layers of the front color slab. 0 = classic single-color lithophane' },
      { type: 'checkbox', key: 'dither', label: 'Dithering', hint: 'Mix neighbouring color stacks to smooth gradients' },
      { type: 'range', key: 'colorPriority', label: 'Color priority', min: 0, max: 4, step: 0.05, hint: 'Hue accuracy vs. tone accuracy', advanced: true },
      { type: 'range', key: 'colorCellMm', label: 'Color cell', min: 0.3, max: 1.2, step: 0.05, unit: 'mm', hint: 'Size of each color dot. Keep it at least the nozzle width', advanced: true },
    ],
    extra: 'lithoFilaments',
  },
  { title: 'Layer stack', open: true, modes: ['paint'], controls: [], extra: 'stack' },
  {
    title: 'Loadout',
    open: true,
    modes: ['mosaic'],
    summary: (s) => `${s.tintLayers} tint layers · ${s.surface}`,
    controls: [
      { type: 'range', key: 'tintLayers', label: 'Tint layers', min: 2, max: 16, step: 1, hint: 'Layers above the ground that tiles can use for tinting. More = more colors, slower to compute' },
      { type: 'seg', key: 'surface', label: 'Surface', options: [['stepped', 'Stepped'], ['level', 'Level']], hint: 'Stepped: each tile only as tall as its combo. Level: pad tiles with ground filament to one even top' },
      { type: 'range', key: 'tileSegments', label: 'Segments', min: 1, max: 4, step: 1, hint: 'Filament segments per tile. 3 is a good default; 4 blends translucent filaments better', advanced: true },
      { type: 'range', key: 'minIsland', label: 'Min island', min: 0, max: 12, step: 1, hint: 'Same-combo islands smaller than this many tiles merge into a neighbour (tiny dots print badly)', advanced: true },
      { type: 'checkbox', key: 'mosaicDither', label: 'Dithering', hint: 'Mix neighbouring tiles to smooth gradients. Creates many single-tile dots', advanced: true },
    ],
    extra: 'loadout',
  },
  // Shared by painting and mosaic, so it is one section (its panel can only be mounted once).
  { title: 'Your filaments', open: true, modes: ['paint', 'mosaic'], controls: [], extra: 'filaments' },
  {
    title: 'Look',
    open: true,
    resetLabel: 'Reset look',
    summary: (s) => (s.mode === 'paint' ? (s.heightMode === 'match' ? 'Color match' : 'From brightness') : s.brightness || s.contrast || s.gamma !== 1 ? 'Adjusted' : 'Original'),
    controls: [
      {
        type: 'seg',
        key: 'heightMode',
        label: 'Heights',
        options: [
          ['match', 'Color match'],
          ['luminance', 'Brightness'],
        ],
        hint: 'Color match: each pixel gets the height whose printed color is closest to it. Brightness: brighter pixels print taller (a plain heightmap)',
        modes: ['paint'],
      },
      { type: 'checkbox', key: 'invert', label: 'Invert heights', hint: 'Brightness mode: make dark pixels tall instead of bright ones', modes: ['paint'] },
      { type: 'range', key: 'brightness', label: 'Brightness', min: -0.5, max: 0.5, step: 0.01 },
      { type: 'range', key: 'contrast', label: 'Contrast', min: -0.9, max: 0.9, step: 0.01 },
      { type: 'range', key: 'gamma', label: 'Gamma', min: 0.3, max: 3, step: 0.01 },
      { type: 'range', key: 'saturation', label: 'Saturation', min: 0, max: 2.5, step: 0.01, modes: ['litho'] },
      { type: 'color', key: 'lightColor', label: 'Preview light', advanced: true },
      { type: 'range', key: 'exposure', label: 'Intensity', min: 0.3, max: 3, step: 0.01, advanced: true },
    ],
  },
  {
    title: 'Print',
    open: true,
    summary: (s) => `${s.layerHeight.toFixed(2)} mm layers · ${s.pixelMm.toFixed(2)} mm pixels`,
    controls: [
      { type: 'number', key: 'layerHeight', label: 'Layer height', min: 0.04, max: 0.3, step: 0.02, unit: 'mm' },
      { type: 'range', key: 'pixelMm', label: 'Pixel size', min: 0.1, max: 1, step: 0.05, unit: 'mm', hint: 'Relief resolution. Smaller = finer but heavier file' },
      { type: 'number', key: 'minThickness', label: 'Min body', min: 0.2, max: 5, step: 0.05, unit: 'mm', hint: 'Body thickness for highlights', modes: ['litho'] },
      { type: 'number', key: 'maxThickness', label: 'Max body', min: 0.6, max: 10, step: 0.1, unit: 'mm', hint: 'Body thickness for shadows', modes: ['litho'] },
      { type: 'range', key: 'baseLayers', label: 'Min height', min: 1, max: 40, step: 1, hint: 'Height of the lowest pixels, in layers (the ground plate)', modes: ['paint', 'mosaic'] },
      { type: 'range', key: 'meshTolerance', label: 'Simplify', min: 0, max: 0.1, step: 0.005, unit: 'mm', hint: 'Max relief error allowed when merging flat areas. Higher = smaller file', modes: ['litho'], advanced: true },
    ],
  },
];

/** Caps every downstream array (solver, preview, mesh) whatever the image and settings. */
export const MAX_PIXELS = 1_500_000;

/** Image grid for the current framing: pixel pitch (raised to respect MAX_PIXELS), image size and frame border in pixels. */
export function frameGrid(s: Pick<Settings, 'widthMm' | 'borderMm' | 'pixelMm'>, aspect: number) {
  const wMm = s.widthMm;
  const hMm = wMm / aspect;
  const fullArea = (wMm + 2 * s.borderMm) * (hMm + 2 * s.borderMm);
  const px = Math.max(s.pixelMm, Math.sqrt(fullArea / MAX_PIXELS));
  return {
    px,
    cols: Math.max(2, Math.round(wMm / px)),
    rows: Math.max(2, Math.round(hMm / px)),
    border: Math.round(s.borderMm / px),
  };
}
