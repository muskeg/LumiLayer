import './style.css';
import type { Filament } from './color';
import { adjust, demoImage, loadImage, panRange, renderFramed, sourceAspect, type Source } from './imaging';
import { buildSolver, colorSlabThickness, solve, type LithoParams, type LithoResult, type Solver } from './lithophane';
import { buildPrintMeshes } from './mesh';
import type { Preview3D } from './preview3d';
import { write3mf, type Part } from './threemf';

interface Settings {
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
  pixelMm: number;
  minThickness: number;
  maxThickness: number;
  colorLayers: number;
  layerHeight: number;
  colorPriority: number;
  dither: boolean;
  lightColor: string;
  exposure: number;
}

type Key = keyof Settings;
type Ctl =
  | { type: 'range' | 'number'; key: Key; label: string; min: number; max: number; step: number; unit?: string; hint?: string }
  | { type: 'select'; key: Key; label: string; options: [string, string][]; numeric?: boolean; hint?: string }
  | { type: 'checkbox' | 'color'; key: Key; label: string; hint?: string };

const DEFAULTS: Settings = {
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
  pixelMm: 0.3,
  minThickness: 0.6,
  maxThickness: 3,
  colorLayers: 5,
  layerHeight: 0.1,
  colorPriority: 1,
  dither: true,
  lightColor: '#fff4e2',
  exposure: 1,
};

const PRESETS: Record<string, Filament[]> = {
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

const SECTIONS: { title: string; open?: boolean; controls: Ctl[] }[] = [
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
      {
        type: 'select',
        key: 'rotation',
        label: 'Rotate',
        numeric: true,
        options: [['0', '0°'], ['90', '90°'], ['180', '180°'], ['270', '270°']],
      },
      { type: 'checkbox', key: 'flip', label: 'Mirror' },
      { type: 'range', key: 'zoom', label: 'Zoom', min: 1, max: 6, step: 0.01, unit: '×', hint: 'Scroll on the preview' },
      { type: 'range', key: 'panX', label: 'Pan X', min: -1, max: 1, step: 0.01, hint: 'Drag the preview' },
      { type: 'range', key: 'panY', label: 'Pan Y', min: -1, max: 1, step: 0.01 },
      { type: 'number', key: 'borderMm', label: 'Frame width', min: 0, max: 30, step: 0.5, unit: 'mm' },
      { type: 'number', key: 'frameThickness', label: 'Frame thickness', min: 0.6, max: 12, step: 0.1, unit: 'mm' },
    ],
  },
  {
    title: 'Image',
    controls: [
      { type: 'range', key: 'brightness', label: 'Brightness', min: -0.5, max: 0.5, step: 0.01 },
      { type: 'range', key: 'contrast', label: 'Contrast', min: -0.9, max: 0.9, step: 0.01 },
      { type: 'range', key: 'gamma', label: 'Gamma', min: 0.3, max: 3, step: 0.01 },
      { type: 'range', key: 'saturation', label: 'Saturation', min: 0, max: 2.5, step: 0.01 },
    ],
  },
  {
    title: 'Depth & resolution',
    open: true,
    controls: [
      { type: 'number', key: 'minThickness', label: 'Min body', min: 0.2, max: 5, step: 0.05, unit: 'mm', hint: 'Body thickness for highlights' },
      { type: 'number', key: 'maxThickness', label: 'Max body', min: 0.6, max: 10, step: 0.1, unit: 'mm', hint: 'Body thickness for shadows' },
      { type: 'range', key: 'pixelMm', label: 'Pixel size', min: 0.1, max: 1, step: 0.05, unit: 'mm', hint: 'Smaller = finer but heavier file' },
    ],
  },
  {
    title: 'Color mixing',
    open: true,
    controls: [
      { type: 'range', key: 'colorLayers', label: 'Color layers', min: 0, max: 10, step: 1, hint: 'Layers of the front color slab' },
      { type: 'number', key: 'layerHeight', label: 'Layer height', min: 0.04, max: 0.3, step: 0.02, unit: 'mm' },
      { type: 'range', key: 'colorPriority', label: 'Color priority', min: 0, max: 4, step: 0.05, hint: 'Hue accuracy vs. tone accuracy' },
      { type: 'checkbox', key: 'dither', label: 'Dithering', hint: 'Mix neighbouring color stacks to smooth gradients' },
    ],
  },
  {
    title: 'Preview light',
    controls: [
      { type: 'color', key: 'lightColor', label: 'Backlight' },
      { type: 'range', key: 'exposure', label: 'Intensity', min: 0.3, max: 3, step: 0.01 },
    ],
  },
];

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

const settings: Settings = { ...DEFAULTS };
let filaments: Filament[] = structuredClone(PRESETS['CMY + White']);
let source: Source = demoImage();
let sourceName = 'lumilayer';
let solver: Solver | null = null;
let solverKey = '';
let result: LithoResult | null = null;
let imgGrid = { cols: 1, rows: 1, border: 0 };
let view: 'backlit' | 'front' | '3d' = 'backlit';
let preview3d: Preview3D | null = null;
let dirty3d = true;

const canvas = $<HTMLCanvasElement>('#canvas2d');
const simCanvas = document.createElement('canvas');
const frontCanvas = document.createElement('canvas');
const inputs = new Map<Key, HTMLInputElement | HTMLSelectElement>();
const outputs = new Map<Key, HTMLOutputElement>();

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
    det.innerHTML = `<summary>${section.title}</summary>`;
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
    if (section.title === 'Color mixing') det.appendChild(buildFilaments());
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
    schedule();
  });
  row.appendChild(input);
  const out = document.createElement('output');
  row.appendChild(out);
  inputs.set(c.key, input);
  outputs.set(c.key, out);
  return row;
}

function syncControls() {
  const all = SECTIONS.flatMap((s) => s.controls);
  for (const c of all) {
    const input = inputs.get(c.key)!;
    const v = settings[c.key];
    if (c.type === 'checkbox') (input as HTMLInputElement).checked = !!v;
    else input.value = String(v);
    outputs.get(c.key)!.textContent = fmt(c, v);
  }
}

function buildFilaments(): HTMLElement {
  const box = document.createElement('div');
  box.className = 'filaments';
  const presetRow = document.createElement('label');
  presetRow.className = 'row select';
  presetRow.innerHTML = '<span>Preset</span>';
  const preset = document.createElement('select');
  preset.add(new Option('Custom', ''));
  for (const name of Object.keys(PRESETS)) preset.add(new Option(name, name));
  preset.value = 'CMY + White';
  presetRow.appendChild(preset);
  box.appendChild(presetRow);
  const list = document.createElement('div');
  box.appendChild(list);

  const render = () => {
    list.innerHTML = '';
    filaments.forEach((f, i) => {
      const row = document.createElement('div');
      row.className = 'filament';
      row.innerHTML = `
        <input type="checkbox" ${f.enabled ? 'checked' : ''} ${i === 0 ? 'disabled' : ''} title="${i === 0 ? 'Base filament is always used' : 'Use this filament'}">
        <span class="slot" title="Slot / extruder">${i + 1}</span>
        <input type="color" title="Filament color">
        <input type="text" maxlength="24" title="Filament name">
        <input type="number" min="0.1" max="20" step="0.1" title="Transmission distance (mm): thickness at which ~10% of light passes">`;
      const [enabled, color, name, td] = row.querySelectorAll('input');
      color.value = f.color;
      name.value = f.name;
      td.value = String(f.td);
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
      list.appendChild(row);
    });
  };
  preset.onchange = () => {
    if (!preset.value) return;
    filaments = structuredClone(PRESETS[preset.value]);
    render();
    schedule();
  };
  const legend = document.createElement('p');
  legend.className = 'hint';
  legend.textContent = 'Slot 1 is the base (body). Slots 2-4 are stacked color layers. Last field: transmission distance (TD, mm).';
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

  const img = renderFramed(source, cols, rows, settings);
  const srgb = adjust(img.data, settings);
  const p = lithoParams(px);
  const key = JSON.stringify([p.colorLayers, p.layerHeight, p.minThickness, p.maxThickness, p.colorPriority, p.filaments]);
  if (!solver || key !== solverKey) {
    solver = buildSolver(p);
    solverKey = key;
  }
  result = solve(srgb, cols, rows, border, p, solver, { color: settings.lightColor, exposure: settings.exposure });

  for (const [c, data] of [[simCanvas, result.sim], [frontCanvas, result.front]] as const) {
    c.width = result.cols;
    c.height = result.rows;
    c.getContext('2d')!.putImageData(new ImageData(data as Uint8ClampedArray<ArrayBuffer>, result.cols, result.rows), 0, 0);
  }
  draw2d();
  dirty3d = true;
  if (view === '3d') update3d();
  updateInfo(px);
}

function draw2d() {
  if (!result || view === '3d') return;
  canvas.width = result.cols;
  canvas.height = result.rows;
  canvas.getContext('2d')!.drawImage(view === 'backlit' ? simCanvas : frontCanvas, 0, 0);
}

let timer3d = 0;
function update3d() {
  if (!dirty3d || !result) return;
  clearTimeout(timer3d);
  timer3d = window.setTimeout(async () => {
    if (!preview3d) {
      const { Preview3D } = await import('./preview3d');
      preview3d ??= new Preview3D($('#stage3d'));
      preview3d.setBacklit($<HTMLInputElement>('#light-toggle input').checked);
    }
    if (!result) return;
    preview3d.resize();
    preview3d.update(result, simCanvas, frontCanvas);
    dirty3d = false;
  }, 60);
}

function updateInfo(px: number) {
  if (!result) return;
  const slab = colorSlabThickness(settings);
  let maxBody = 0;
  for (const t of result.body) maxBody = Math.max(maxBody, t);
  const w = (result.cols * px).toFixed(1);
  const h = (result.rows * px).toFixed(1);
  const used = filaments.filter((f, i) => i === 0 || (f.enabled && settings.colorLayers > 0)).length;
  const lh = settings.layerHeight.toFixed(2);
  $('#info').innerHTML =
    `<b>${w} × ${h} × ${(slab + maxBody).toFixed(2)} mm</b> · ${result.cols}×${result.rows} px @ ${px.toFixed(2)} mm` +
    ` · ${used} filament${used > 1 ? 's' : ''}` +
    (slab > 0 ? ` · color slab ${settings.colorLayers} × ${lh} mm` : '') +
    `<br><span class="hint">Print face-down (the viewing side is on the bed). Use ${lh} mm for both first layer and layer height, 100% infill.</span>`;
}

function setStatus(s: string) {
  $('#status').textContent = s;
}

function setupViewer() {
  document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b === btn));
      view = btn.dataset.view as typeof view;
      const is3d = view === '3d';
      canvas.hidden = is3d;
      $('#stage3d').hidden = !is3d;
      $('#light-toggle').hidden = !is3d;
      if (is3d) update3d();
      else draw2d();
    };
  });
  const light = $<HTMLInputElement>('#light-toggle input');
  light.onchange = () => preview3d?.setBacklit(light.checked);

  let drag: { x: number; y: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag || !result) return;
    const rect = canvas.getBoundingClientRect();
    const scale = Math.min(rect.width / result.cols, rect.height / result.rows);
    const range = panRange(source, imgGrid.cols, imgGrid.rows, settings);
    const dx = (e.clientX - drag.x) / scale;
    const dy = (e.clientY - drag.y) / scale;
    drag = { x: e.clientX, y: e.clientY };
    if (range.x > 0) settings.panX = Math.min(1, Math.max(-1, settings.panX + dx / range.x));
    if (range.y > 0) settings.panY = Math.min(1, Math.max(-1, settings.panY + dy / range.y));
    syncControls();
    schedule();
  });
  canvas.addEventListener('pointerup', () => (drag = null));
  canvas.addEventListener(
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
    e.preventDefault();
    hint.hidden = false;
  });
  window.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) hint.hidden = true;
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    hint.hidden = true;
    const file = e.dataTransfer?.files[0];
    if (file) openFile(file);
  });
}

function setupExport() {
  const btn = $<HTMLButtonElement>('#export');
  btn.onclick = async () => {
    if (!result) return;
    btn.disabled = true;
    const tick = () => new Promise((r) => setTimeout(r, 20));
    try {
      setStatus('Building meshes…');
      await tick();
      const r = result;
      const meshes = buildPrintMeshes(r);
      const parts: Part[] = meshes.flatMap((mesh, i) =>
        mesh
          ? [{ name: `${i === 0 ? 'Base' : `Color ${i}`} - ${r.filaments[i].name}`, color: r.filaments[i].color, extruder: i + 1, mesh }]
          : [],
      );
      const tris = parts.reduce((n, p) => n + p.mesh.indices.length / 3, 0);
      setStatus(`Writing 3MF (${(tris / 1e6).toFixed(2)} M triangles)…`);
      await tick();
      const data = await write3mf(parts);
      const url = URL.createObjectURL(new Blob([data as Uint8Array<ArrayBuffer>], { type: 'model/3mf' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `${sourceName}-lithophane.3mf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setStatus(`Exported ${parts.length} parts · ${(data.length / 1e6).toFixed(1)} MB`);
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
setupViewer();
setupFileInput();
setupExport();
schedule();
