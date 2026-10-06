import './style.css';
import type { Filament } from './color';
import { exportFileName, triggerDownload } from './download';
import { adjust, demoImage, loadImage, panRange, renderFramed, sourceAspect, type Source } from './imaging';
import { buildSolver, colorSlabThickness, solve, type LithoParams, type LithoResult, type Solver } from './lithophane';
import { PaintController } from './paint/controller';
import { runExport, type ExportedFile } from './paint/exportClient';
import { MosaicController } from './paint/mosaicController';
import type { Preview3D, Preview3DInput } from './preview3d';

type Mode = 'litho' | 'paint' | 'mosaic';

interface Settings {
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

type Key = keyof Settings;
type Ctl = (
  | { type: 'range' | 'number'; key: Key; label: string; min: number; max: number; step: number; unit?: string; hint?: string }
  | { type: 'select'; key: Key; label: string; options: [string, string][]; numeric?: boolean; hint?: string }
  | { type: 'checkbox' | 'color'; key: Key; label: string; hint?: string }
) & { modes?: Mode[] };

interface Section {
  title: string;
  open?: boolean;
  modes?: Mode[];
  controls: Ctl[];
  extra?: () => HTMLElement;
}

const DEFAULTS: Settings = {
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
const MODE_DEFAULTS: Record<Mode, Partial<Settings>> = {
  litho: { layerHeight: 0.1, frameThickness: 4, lightColor: '#fff4e2', pixelMm: 0.2 },
  paint: { layerHeight: 0.08, frameThickness: 1.2, lightColor: '#ffffff', pixelMm: 0.2, baseLayers: 6 },
  // One tile per nozzle width; a 7 × 0.08 mm ground.
  mosaic: { layerHeight: 0.08, frameThickness: 1.2, lightColor: '#ffffff', pixelMm: 0.4, baseLayers: 7 },
};

const LITHO_PRESETS: Record<string, Filament[]> = {
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

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

const canvas = $<HTMLCanvasElement>('#canvas2d');
const glCanvas = $<HTMLCanvasElement>('#canvasGl');
const simCanvas = document.createElement('canvas');
const frontCanvas = document.createElement('canvas');

const settings: Settings = { ...DEFAULTS };
let filaments: Filament[] = structuredClone(LITHO_PRESETS['CMY + White']);
let source: Source = demoImage();
let sourceName = 'lumilayer';
let solver: Solver | null = null;
let solverKey = '';
let result: LithoResult | null = null;
let imgGrid = { cols: 1, rows: 1, border: 0 };
let gridSize = { cols: 1, rows: 1 };
let lastPx = DEFAULTS.pixelMm;
/** 'main' is how the print is meant to be seen; 'alt' is the secondary 2D view. Labels depend on the mode. */
let view: 'main' | 'alt' | '3d' = 'main';
const VIEW_LABELS: Record<Mode, { main: string; alt: string }> = {
  litho: { main: 'Backlit', alt: 'Unlit (front)' },
  paint: { main: 'Front-lit', alt: 'Backlit' },
  mosaic: { main: 'Front-lit', alt: 'Swatches' },
};
let preview3d: Preview3D | null = null;
let dirty3d = true;

// Declared before construction: the controller notifies once from its constructor.
let paint: PaintController | undefined;
paint = new PaintController(
  glCanvas,
  () => {
    if (!paint) return;
    // The mosaic shares the filament profiles: re-solve when they change.
    if (settings.mode === 'mosaic') return schedule();
    updateInfo();
    dirty3d = true;
    if (view === '3d') update3d();
  },
  (s) => setStatus(s),
);
const mosaic = new MosaicController(() => paint!.profiles, () => schedule(), (s) => setStatus(s));

const SECTIONS: Section[] = [
  {
    title: 'Mode',
    open: true,
    controls: [
      {
        type: 'select',
        key: 'mode',
        label: 'Type',
        options: [
          ['litho', 'Lithophane (backlit)'],
          ['paint', 'Filament painting (front-lit)'],
          ['mosaic', 'Filament mosaic (front-lit)'],
        ],
        hint: 'Backlit lithophane; layered filament painting (one filament per height band); or filament mosaic, where every nozzle-wide tile gets its own short filament combo for a much wider color range',
      },
    ],
  },
  {
    title: 'Framing',
    open: true,
    controls: [
      { type: 'number', key: 'widthMm', label: 'Width', min: 20, max: 300, step: 1, unit: 'mm' },
      {
        type: 'select',
        key: 'aspect',
        label: 'Aspect',
        options: [
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
        ],
      },
      { type: 'select', key: 'rotation', label: 'Rotate', numeric: true, options: [['0', '0°'], ['90', '90°'], ['180', '180°'], ['270', '270°']] },
      { type: 'checkbox', key: 'flip', label: 'Mirror' },
      { type: 'range', key: 'zoom', label: 'Zoom', min: 1, max: 6, step: 0.01, unit: '×', hint: 'Scroll on the preview' },
      { type: 'range', key: 'panX', label: 'Pan X', min: -1, max: 1, step: 0.01, hint: 'Drag the preview' },
      { type: 'range', key: 'panY', label: 'Pan Y', min: -1, max: 1, step: 0.01 },
      { type: 'number', key: 'borderMm', label: 'Frame width', min: 0, max: 30, step: 0.5, unit: 'mm' },
      { type: 'number', key: 'frameThickness', label: 'Frame height', min: 0.2, max: 12, step: 0.1, unit: 'mm' },
    ],
  },
  {
    title: 'Image',
    controls: [
      { type: 'range', key: 'brightness', label: 'Brightness', min: -0.5, max: 0.5, step: 0.01 },
      { type: 'range', key: 'contrast', label: 'Contrast', min: -0.9, max: 0.9, step: 0.01 },
      { type: 'range', key: 'gamma', label: 'Gamma', min: 0.3, max: 3, step: 0.01 },
      { type: 'range', key: 'saturation', label: 'Saturation', min: 0, max: 2.5, step: 0.01, modes: ['litho'] },
    ],
  },
  {
    title: 'Depth & resolution',
    open: true,
    controls: [
      { type: 'number', key: 'minThickness', label: 'Min body', min: 0.2, max: 5, step: 0.05, unit: 'mm', hint: 'Body thickness for highlights', modes: ['litho'] },
      { type: 'number', key: 'maxThickness', label: 'Max body', min: 0.6, max: 10, step: 0.1, unit: 'mm', hint: 'Body thickness for shadows', modes: ['litho'] },
      { type: 'range', key: 'baseLayers', label: 'Min height', min: 1, max: 40, step: 1, hint: 'Height of the lowest pixels, in layers (the ground plate)', modes: ['paint', 'mosaic'] },
      {
        type: 'select',
        key: 'heightMode',
        label: 'Heights',
        options: [
          ['match', 'Best color match'],
          ['luminance', 'From brightness'],
        ],
        hint: 'Best color match: each pixel gets the height whose printed color is closest to it. From brightness: brighter pixels print taller (a plain heightmap)',
        modes: ['paint'],
      },
      { type: 'checkbox', key: 'invert', label: 'Invert heights', hint: 'Brightness mode: make dark pixels tall instead of bright ones', modes: ['paint'] },
      { type: 'number', key: 'layerHeight', label: 'Layer height', min: 0.04, max: 0.3, step: 0.02, unit: 'mm' },
      { type: 'range', key: 'pixelMm', label: 'Pixel size', min: 0.1, max: 1, step: 0.05, unit: 'mm', hint: 'Relief resolution. Smaller = finer but heavier file' },
      { type: 'range', key: 'meshTolerance', label: 'Simplify', min: 0, max: 0.1, step: 0.005, unit: 'mm', hint: 'Max relief error allowed when merging flat areas. Higher = smaller file', modes: ['litho'] },
    ],
  },
  {
    title: 'Color mixing',
    open: true,
    modes: ['litho'],
    controls: [
      { type: 'range', key: 'colorLayers', label: 'Color layers', min: 0, max: 10, step: 1, hint: 'Layers of the front color slab' },
      { type: 'range', key: 'colorPriority', label: 'Color priority', min: 0, max: 4, step: 0.05, hint: 'Hue accuracy vs. tone accuracy' },
      { type: 'range', key: 'colorCellMm', label: 'Color cell', min: 0.3, max: 1.2, step: 0.05, unit: 'mm', hint: 'Size of each color dot. Keep it at least the nozzle width' },
      { type: 'checkbox', key: 'dither', label: 'Dithering', hint: 'Mix neighbouring color stacks to smooth gradients' },
    ],
    extra: buildLithoFilaments,
  },
  { title: 'Layer stack', open: true, modes: ['paint'], controls: [], extra: () => paint!.buildStackPanel() },
  {
    title: 'Filament mosaic',
    open: true,
    modes: ['mosaic'],
    controls: [
      { type: 'range', key: 'tintLayers', label: 'Tint layers', min: 2, max: 16, step: 1, hint: 'Layers above the ground that tiles can use for tinting. More = more colors, slower to compute' },
      { type: 'range', key: 'tileSegments', label: 'Segments', min: 1, max: 4, step: 1, hint: 'Filament segments per tile. 3 is a good default; 4 blends translucent filaments better' },
      { type: 'select', key: 'surface', label: 'Surface', options: [['stepped', 'Stepped'], ['level', 'Level']], hint: 'Stepped: each tile only as tall as its combo. Level: pad tiles with ground filament to one even top' },
      { type: 'range', key: 'minIsland', label: 'Min island', min: 0, max: 12, step: 1, hint: 'Same-combo islands smaller than this many tiles merge into a neighbour (tiny dots print badly)' },
      { type: 'checkbox', key: 'mosaicDither', label: 'Dithering', hint: 'Mix neighbouring tiles to smooth gradients. Creates many single-tile dots' },
    ],
    extra: () => mosaic.buildLoadoutPanel(),
  },
  { title: 'Filaments', open: true, modes: ['paint', 'mosaic'], controls: [], extra: () => paint!.buildFilamentPanel() },
  {
    title: 'Preview light',
    controls: [
      { type: 'color', key: 'lightColor', label: 'Light' },
      { type: 'range', key: 'exposure', label: 'Intensity', min: 0.3, max: 3, step: 0.01 },
    ],
  },
];

const inputs = new Map<Key, HTMLInputElement | HTMLSelectElement>();
const outputs = new Map<Key, HTMLOutputElement>();
const controlRows = new Map<Key, HTMLElement>();
const sectionEls = new Map<Section, HTMLElement>();

function fmt(c: Ctl, v: unknown): string {
  if (c.type !== 'range') return '';
  const decimals = c.step >= 1 ? 0 : c.step >= 0.1 ? 1 : 2;
  return `${Number(v).toFixed(decimals)}${c.unit ?? ''}`;
}

function buildControls() {
  const root = $('#controls');
  for (const section of SECTIONS) {
    const det = document.createElement('details');
    det.open = !!section.open;
    const summary = document.createElement('summary');
    summary.textContent = section.title;
    det.appendChild(summary);
    for (const c of section.controls) det.appendChild(buildControl(c));
    if (section.title === 'Image') {
      const reset = document.createElement('button');
      reset.textContent = 'Reset image';
      reset.className = 'small';
      reset.onclick = () => {
        for (const c of section.controls) (settings as unknown as Record<string, unknown>)[c.key] = DEFAULTS[c.key];
        syncControls();
        schedule();
      };
      det.appendChild(reset);
    }
    if (section.extra) det.appendChild(section.extra());
    sectionEls.set(section, det);
    root.appendChild(det);
  }
}

function buildControl(c: Ctl): HTMLElement {
  const row = document.createElement('label');
  row.className = `row ${c.type}`;
  if (c.hint) row.title = c.hint;
  const name = document.createElement('span');
  name.textContent = c.label;
  row.appendChild(name);
  let input: HTMLInputElement | HTMLSelectElement;
  if (c.type === 'select') {
    input = document.createElement('select');
    for (const [v, l] of c.options) input.add(new Option(l, v));
  } else {
    input = document.createElement('input');
    input.type = c.type;
    if (c.type === 'range' || c.type === 'number') {
      input.min = String(c.min);
      input.max = String(c.max);
      input.step = String(c.step);
    }
  }
  const record = settings as unknown as Record<string, unknown>;
  input.addEventListener('input', () => {
    let v: unknown;
    if (c.type === 'checkbox') v = (input as HTMLInputElement).checked;
    else if (c.type === 'range' || c.type === 'number') {
      const n = parseFloat(input.value);
      if (!Number.isFinite(n)) return;
      v = Math.min(c.max, Math.max(c.min, n));
    } else if (c.type === 'select' && c.numeric) v = Number(input.value);
    else v = input.value;
    record[c.key] = v;
    outputs.get(c.key)!.textContent = fmt(c, v);
    if (c.key === 'mode') onModeChange();
    schedule();
  });
  row.appendChild(input);
  const out = document.createElement('output');
  row.appendChild(out);
  inputs.set(c.key, input);
  outputs.set(c.key, out);
  controlRows.set(c.key, row);
  return row;
}

function syncControls() {
  for (const c of SECTIONS.flatMap((s) => s.controls)) {
    const input = inputs.get(c.key)!;
    const v = settings[c.key];
    if (c.type === 'checkbox') (input as HTMLInputElement).checked = !!v;
    else input.value = String(v);
    outputs.get(c.key)!.textContent = fmt(c, v);
  }
}

function onModeChange() {
  Object.assign(settings, MODE_DEFAULTS[settings.mode]);
  syncControls();
  applyModeUi();
}

function applyModeUi() {
  const m = settings.mode;
  for (const [section, elem] of sectionEls) elem.hidden = !!section.modes && !section.modes.includes(m);
  for (const c of SECTIONS.flatMap((s) => s.controls)) if (c.modes) controlRows.get(c.key)!.hidden = !c.modes.includes(m);
  $('button[data-view="main"]').textContent = VIEW_LABELS[m].main;
  $('button[data-view="alt"]').textContent = VIEW_LABELS[m].alt;
  $('#brand-sub').textContent = m === 'paint' ? 'filament painting' : m === 'mosaic' ? 'filament mosaic' : 'multi-color lithophanes';
  canvas.classList.toggle('crisp', m === 'mosaic');
  showView();
}

function showView() {
  const is3d = view === '3d';
  const isPaint = settings.mode === 'paint';
  canvas.hidden = is3d || isPaint;
  glCanvas.hidden = is3d || !isPaint;
  $('#stage3d').hidden = !is3d;
  $('#light-toggle').hidden = !is3d || settings.mode !== 'litho';
  if (isPaint) paint!.setOpticalMode(view === 'alt' ? 'backlit' : 'frontlit');
  if (is3d) update3d();
  else draw2d();
}

function buildLithoFilaments(): HTMLElement {
  const box = document.createElement('div');
  box.className = 'filaments';
  const presetRow = document.createElement('label');
  presetRow.className = 'row select';
  const presetLabel = document.createElement('span');
  presetLabel.textContent = 'Preset';
  const preset = document.createElement('select');
  preset.add(new Option('Custom', ''));
  for (const name of Object.keys(LITHO_PRESETS)) preset.add(new Option(name, name));
  preset.value = 'CMY + White';
  presetRow.append(presetLabel, preset);
  const list = document.createElement('div');
  box.append(presetRow, list);

  const render = () => {
    list.replaceChildren();
    filaments.forEach((f, i) => {
      const row = document.createElement('div');
      row.className = 'filament';
      const enabled = Object.assign(document.createElement('input'), { type: 'checkbox', checked: f.enabled, disabled: i === 0, title: i === 0 ? 'Base filament is always used' : 'Use this filament' });
      const slot = Object.assign(document.createElement('span'), { className: 'slot', textContent: String(i + 1), title: 'Slot / extruder' });
      const color = Object.assign(document.createElement('input'), { type: 'color', value: f.color, title: 'Filament color' });
      const name = Object.assign(document.createElement('input'), { type: 'text', value: f.name, maxLength: 24, title: 'Filament name' });
      const td = Object.assign(document.createElement('input'), { type: 'number', min: '0.1', max: '20', step: '0.1', value: String(f.td), title: 'Transmission distance (mm): thickness at which ~10% of light passes' });
      const changed = () => {
        preset.value = '';
        schedule();
      };
      enabled.onchange = () => { f.enabled = i === 0 || enabled.checked; row.classList.toggle('off', !f.enabled); changed(); };
      color.oninput = () => { f.color = color.value; changed(); };
      name.oninput = () => { f.name = name.value || `Filament ${i + 1}`; changed(); };
      td.oninput = () => {
        const v = parseFloat(td.value);
        if (Number.isFinite(v) && v > 0) { f.td = Math.min(20, Math.max(0.1, v)); changed(); }
      };
      row.classList.toggle('off', !f.enabled);
      row.append(enabled, slot, color, name, td);
      list.appendChild(row);
    });
  };
  preset.onchange = () => {
    if (!preset.value) return;
    filaments = structuredClone(LITHO_PRESETS[preset.value]);
    render();
    schedule();
  };
  const legend = Object.assign(document.createElement('p'), {
    className: 'hint',
    textContent: 'Slot 1 is the base (body). Slots 2-4 are stacked color layers. Last field: transmission distance (TD, mm).',
  });
  box.appendChild(legend);
  render();
  return box;
}

let pending = false;
function schedule() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    try {
      compute();
    } catch (e) {
      setStatus(`Error: ${(e as Error).message}`);
      console.error(e);
    }
  });
}

const MAX_PIXELS = 1_500_000;

const colorCellPx = (pixelMm: number) => Math.max(1, Math.round(settings.colorCellMm / pixelMm));

function lithoParams(pixelMm: number): LithoParams {
  return {
    pixelMm,
    minThickness: settings.minThickness,
    maxThickness: Math.max(settings.minThickness, settings.maxThickness),
    frameThickness: settings.frameThickness,
    colorLayers: settings.colorLayers,
    layerHeight: settings.layerHeight,
    colorPriority: settings.colorPriority,
    dither: settings.dither,
    colorCellPx: colorCellPx(pixelMm),
    filaments,
  };
}

function compute() {
  const aspect = settings.aspect === 'original' ? sourceAspect(source, settings.rotation) : Number(settings.aspect);
  const wMm = settings.widthMm;
  const hMm = wMm / aspect;
  const fullArea = (wMm + 2 * settings.borderMm) * (hMm + 2 * settings.borderMm);
  const px = Math.max(settings.pixelMm, Math.sqrt(fullArea / MAX_PIXELS));
  const cols = Math.max(2, Math.round(wMm / px));
  const rows = Math.max(2, Math.round(hMm / px));
  const border = Math.round(settings.borderMm / px);
  imgGrid = { cols, rows, border };
  gridSize = { cols: cols + 2 * border, rows: rows + 2 * border };
  lastPx = px;

  const img = renderFramed(source, cols, rows, settings);
  const srgb = adjust(img.data, settings);

  if (settings.mode === 'paint') {
    const p = paint!;
    p.setSettings({
      layerHeight: settings.layerHeight,
      baseLayers: settings.baseLayers,
      frameThickness: settings.frameThickness,
      invert: settings.invert,
      heightMode: settings.heightMode,
      light: settings.lightColor,
      exposure: settings.exposure,
    });
    p.setImage(srgb, cols, rows, border, px);
    if (p.preview.error) setStatus(p.preview.error);
    dirty3d = true;
    if (view === '3d') update3d();
    updateInfo();
    return;
  }

  if (settings.mode === 'mosaic') {
    mosaic.setSettings({
      layerHeight: settings.layerHeight,
      groundLayers: settings.baseLayers,
      tintLayers: settings.tintLayers,
      maxSegments: settings.tileSegments,
      stepped: settings.surface === 'stepped',
      dither: settings.mosaicDither,
      minIsland: settings.minIsland,
      frameThickness: settings.frameThickness,
      light: settings.lightColor,
      exposure: settings.exposure,
    });
    mosaic.setImage(srgb, cols, rows, border, px);
    draw2d();
    dirty3d = true;
    if (view === '3d') update3d();
    updateInfo();
    return;
  }

  const lp = lithoParams(px);
  const key = JSON.stringify([lp.colorLayers, lp.layerHeight, lp.minThickness, lp.maxThickness, lp.colorPriority, lp.filaments]);
  if (!solver || key !== solverKey) {
    solver = buildSolver(lp);
    solverKey = key;
  }
  result = solve(srgb, cols, rows, border, lp, solver, { color: settings.lightColor, exposure: settings.exposure });

  for (const [c, data] of [[simCanvas, result.sim], [frontCanvas, result.front]] as const) {
    c.width = result.cols;
    c.height = result.rows;
    c.getContext('2d')!.putImageData(new ImageData(data as Uint8ClampedArray<ArrayBuffer>, result.cols, result.rows), 0, 0);
  }
  draw2d();
  dirty3d = true;
  if (view === '3d') update3d();
  updateInfo();
}

function draw2d() {
  if (view === '3d') return;
  if (settings.mode === 'mosaic') return mosaic.draw(canvas, view === 'alt' ? 'swatches' : 'predicted');
  if (settings.mode !== 'litho' || !result) return;
  canvas.width = result.cols;
  canvas.height = result.rows;
  canvas.getContext('2d')!.drawImage(view === 'main' ? simCanvas : frontCanvas, 0, 0);
}

let timer3d = 0;
function update3d() {
  if (!dirty3d) return;
  clearTimeout(timer3d);
  timer3d = window.setTimeout(async () => {
    if (!preview3d) {
      const { Preview3D } = await import('./preview3d');
      preview3d ??= new Preview3D($('#stage3d'));
      preview3d.setBacklit($<HTMLInputElement>('#light-toggle input').checked);
    }
    let input: Preview3DInput;
    let sim: HTMLCanvasElement, front: HTMLCanvasElement;
    if (settings.mode === 'paint') {
      const p = paint!;
      const snap = p.preview.snapshot();
      if (!snap) return;
      const base = p.stack()[0]?.colorHex ?? '#ffffff';
      input = { frontLit: true, hf: { ...p.size, pixelMm: lastPx, body: p.heights() }, slab: 0, baseColor: base };
      sim = front = snap;
    } else if (settings.mode === 'mosaic') {
      const snap = mosaic.snapshot();
      if (!snap) return;
      const base = mosaic.result!.set.filaments[0]?.color ?? '#ffffff';
      input = { frontLit: true, hf: { ...mosaic.size, pixelMm: lastPx, body: mosaic.heights() }, slab: 0, baseColor: base };
      sim = front = snap;
    } else {
      if (!result) return;
      input = { frontLit: false, hf: result, slab: colorSlabThickness(result), baseColor: result.filaments[0].color };
      sim = simCanvas;
      front = frontCanvas;
    }
    preview3d.resize();
    preview3d.update(input, sim, front);
    dirty3d = false;
  }, 60);
}

/** Info bar, built with textContent (filament names are user input). */
function setInfo(headline: string, details: string, hint: string) {
  const b = document.createElement('b');
  b.textContent = headline;
  const h = document.createElement('span');
  h.className = 'hint';
  h.textContent = hint;
  $('#info').replaceChildren(b, ` · ${details}`, document.createElement('br'), h);
}

function updateInfo() {
  const px = lastPx;
  const lh = settings.layerHeight;
  if (settings.mode === 'mosaic') {
    const info = mosaic.info();
    if (info) setInfo(...info);
    return;
  }
  if (settings.mode === 'paint') {
    const p = paint!;
    const { cols, rows } = p.size;
    if (!cols) return;
    const stack = p.stack();
    const materials = new Set(stack.map((s) => s.materialId)).size;
    const bands = stack.map((s) => `${s.name} ${s.startZ.toFixed(2)}–${s.endZ.toFixed(2)}`).join(' → ');
    setInfo(
      `${(cols * px).toFixed(1)} × ${(rows * px).toFixed(1)} × ${(p.maxLayers * lh).toFixed(2)} mm`,
      `${cols}×${rows} px @ ${px.toFixed(2)} mm · ${materials} filament${materials > 1 ? 's' : ''}, ${stack.length - 1} change${stack.length === 2 ? '' : 's'}${materials > 4 ? ' (needs more than 4 AMS slots)' : ''}`,
      `${bands} mm. Print face-up as exported, ${lh.toFixed(2)} mm layers, 100% infill; first layer a whole multiple of ${lh.toFixed(2)} mm.`,
    );
    return;
  }
  if (!result) return;
  const slab = colorSlabThickness(settings);
  let maxBody = 0;
  for (const t of result.body) maxBody = Math.max(maxBody, t);
  const used = filaments.filter((f, i) => i === 0 || (f.enabled && settings.colorLayers > 0)).length;
  setInfo(
    `${(result.cols * px).toFixed(1)} × ${(result.rows * px).toFixed(1)} × ${(slab + maxBody).toFixed(2)} mm`,
    `${result.cols}×${result.rows} px @ ${px.toFixed(2)} mm · ${used} filament${used > 1 ? 's' : ''}` +
      (slab > 0 ? ` · color slab ${settings.colorLayers} × ${lh.toFixed(2)} mm, cells ${(colorCellPx(px) * px).toFixed(2)} mm` : ''),
    `Print face-down (the viewing side is on the bed). Use ${lh.toFixed(2)} mm for both first layer and layer height, 100% infill.`,
  );
}

function setStatus(s: string) {
  const el = $('#status');
  el.textContent = s;
  el.title = s;
}

function setupViewer() {
  document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b === btn));
      view = btn.dataset.view as typeof view;
      showView();
    };
  });
  const light = $<HTMLInputElement>('#light-toggle input');
  light.onchange = () => preview3d?.setBacklit(light.checked);

  for (const target of [canvas, glCanvas]) {
    let drag: { x: number; y: number } | null = null;
    target.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY };
      target.setPointerCapture(e.pointerId);
    });
    target.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const rect = target.getBoundingClientRect();
      const scale = Math.min(rect.width / gridSize.cols, rect.height / gridSize.rows);
      const range = panRange(source, imgGrid.cols, imgGrid.rows, settings);
      const dx = (e.clientX - drag.x) / scale;
      const dy = (e.clientY - drag.y) / scale;
      drag = { x: e.clientX, y: e.clientY };
      if (range.x > 0) settings.panX = Math.min(1, Math.max(-1, settings.panX + dx / range.x));
      if (range.y > 0) settings.panY = Math.min(1, Math.max(-1, settings.panY + dy / range.y));
      syncControls();
      schedule();
    });
    target.addEventListener('pointerup', () => (drag = null));
    target.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        settings.zoom = Math.min(6, Math.max(1, settings.zoom * Math.exp(-e.deltaY * 0.0015)));
        syncControls();
        schedule();
      },
      { passive: false },
    );
  }
}

async function openFile(file: File) {
  if (!file.type.startsWith('image/')) {
    setStatus('Not an image file');
    return;
  }
  try {
    setStatus('Loading…');
    source = await loadImage(file);
    sourceName = file.name.replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_') || 'lumilayer';
    Object.assign(settings, { zoom: 1, panX: 0, panY: 0, rotation: 0, flip: false });
    syncControls();
    setStatus('');
    schedule();
  } catch {
    setStatus('Could not read that image');
  }
}

function setupFileInput() {
  const input = $<HTMLInputElement>('#file');
  input.onchange = () => {
    if (input.files?.[0]) openFile(input.files[0]);
    input.value = '';
  };
  const hint = $('#drop-hint');
  window.addEventListener('dragover', (e) => {
    // Only react to files, not to reordering bands in the layer stack.
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    hint.hidden = false;
  });
  window.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) hint.hidden = true;
  });
  window.addEventListener('drop', (e) => {
    hint.hidden = true;
    const file = e.dataTransfer?.files[0];
    if (!file) return;
    e.preventDefault();
    openFile(file);
  });
}

let lithoWorker: Worker | null = null;

async function exportLitho(): Promise<ExportedFile | null> {
  if (!result) return null;
  lithoWorker ??= new Worker(new URL('./paint/threeMfWorker.ts', import.meta.url), { type: 'module' });
  // The preview rasters stay here; the worker only needs the geometry.
  const { sim: _sim, front: _front, ...geometry } = result;
  const file = await runExport(
    lithoWorker,
    { kind: 'litho', result: geometry, tolerance: settings.meshTolerance },
    [],
    'raise Color cell, raise Simplify, increase Pixel size or turn off Dithering',
    setStatus,
  );
  if (file) triggerDownload(new Blob([file.bytes], { type: 'model/3mf' }), exportFileName(sourceName, 'lithophane'));
  return file;
}

function setupExport() {
  const btn = $<HTMLButtonElement>('#export');
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      setStatus('Building 3MF in the background…');
      const m = settings.mode;
      const r = await (m === 'litho' ? exportLitho() : m === 'mosaic' ? mosaic.exportModel(sourceName) : paint!.exportModel(sourceName));
      setStatus(r ? `Exported ${r.parts} parts · ${(r.triangles / 1e6).toFixed(2)} M triangles · ${(r.bytes.byteLength / 1e6).toFixed(1)} MB` : 'Export cancelled');
    } catch (e) {
      console.error(e);
      setStatus(`Export failed: ${(e as Error).message}`);
    } finally {
      btn.disabled = false;
    }
  };
}

buildControls();
syncControls();
applyModeUi();
setupViewer();
setupFileInput();
setupExport();
schedule();
