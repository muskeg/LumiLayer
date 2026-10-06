import '@fontsource-variable/inter';
import './style.css';
import type { Filament } from './color';
import { buildControlPanel, type ControlPanel } from './controls';
import { exportFileName, triggerDownload } from './download';
import { attachFraming } from './framing';
import { watchRangeFills } from './rangeFill';
import { adjust, demoImage, loadImage, panRange, renderFramed, sourceAspect, type Source } from './imaging';
import { buildLithoFilaments } from './lithoFilaments';
import { buildSolver, colorSlabThickness, solve, type LithoParams, type LithoResult, type Solver } from './lithophane';
import { PaintController } from './paint/controller';
import { runExport, setHeavyExportPrompt, type ExportedFile } from './paint/exportClient';
import { askHeavyExport, toast } from './feedback';
import { MosaicController } from './paint/mosaicController';
import type { Preview3D, Preview3DInput } from './preview3d';
import { DEFAULT_LITHO_PRESET, DEFAULTS, frameGrid, LITHO_PRESETS, MODE_DEFAULTS, VIEW_LABELS, type Settings } from './settings';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

const canvas = $<HTMLCanvasElement>('#canvas2d');
const glCanvas = $<HTMLCanvasElement>('#canvasGl');
const simCanvas = document.createElement('canvas');
const frontCanvas = document.createElement('canvas');

const settings: Settings = { ...DEFAULTS };
let filaments: Filament[] = structuredClone(LITHO_PRESETS[DEFAULT_LITHO_PRESET]);
let source: Source = demoImage();
let sourceName = 'lumilayer';
let solver: Solver | null = null;
let solverKey = '';
let result: LithoResult | null = null;
let imgGrid = { cols: 1, rows: 1, border: 0 };
let gridSize = { cols: 1, rows: 1 };
let lastPx = DEFAULTS.pixelMm;
let view: 'main' | 'alt' | '3d' = 'main';
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

let panel: ControlPanel;
let refreshRangeFills = () => {};
const syncControls = () => {
  panel.sync();
  refreshRangeFills();
};

function onModeChange() {
  Object.assign(settings, MODE_DEFAULTS[settings.mode]);
  syncControls();
  applyModeUi();
}

function applyModeUi() {
  const m = settings.mode;
  panel.showMode(m);
  $('button[data-view="main"]').textContent = VIEW_LABELS[m].main;
  $('button[data-view="alt"]').textContent = VIEW_LABELS[m].alt;
  if (m !== 'litho') paint!.setTdHelp(m);
  for (const b of document.querySelectorAll<HTMLButtonElement>('#mode-switch button')) b.setAttribute('aria-pressed', String(b.dataset.mode === m));
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
  updateRulers();
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
  const { px, cols, rows, border } = frameGrid(settings, aspect);
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

/** Info bar as stat chips, built with textContent (filament names are user input). */
function setInfo(headline: string, details: string, hint: string) {
  const chip = (text: string, strong = false) => {
    const c = document.createElement(strong ? 'b' : 'span');
    c.className = 'stat';
    c.textContent = text;
    return c;
  };
  const h = document.createElement('span');
  h.className = 'hint';
  h.textContent = hint;
  h.title = hint;
  $('#info').replaceChildren(chip(headline, true), ...details.split(' · ').map((d) => chip(d)), h);
}

function updateInfo() {
  updateRulers();
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

/** Width and height of the print in mm, drawn along its edges (same contain-fit as the canvases). */
function updateRulers() {
  const stage = $('#stage');
  const rx = $('#ruler-x'), ry = $('#ruler-y');
  const show = view !== '3d' && gridSize.cols > 1;
  rx.hidden = ry.hidden = !show;
  if (!show) return;
  const pad = parseFloat(getComputedStyle(stage).paddingLeft) || 0;
  const cw = stage.clientWidth - 2 * pad, ch = stage.clientHeight - 2 * pad;
  const aspect = gridSize.cols / gridSize.rows;
  const w = Math.min(cw, ch * aspect), h = w / aspect;
  const x0 = pad + (cw - w) / 2, y0 = pad + (ch - h) / 2;
  Object.assign(rx.style, { left: `${x0}px`, top: `${y0 + h + 6}px`, width: `${w}px` });
  Object.assign(ry.style, { left: `${x0 + w + 6}px`, top: `${y0}px`, height: `${h}px` });
  rx.firstElementChild!.textContent = `${(gridSize.cols * lastPx).toFixed(1)} mm`;
  ry.firstElementChild!.textContent = `${(gridSize.rows * lastPx).toFixed(1)} mm`;
}

function setStatus(s: string) {
  const el = $('#status');
  el.textContent = s;
  el.title = s;
}

function setupViewer() {
  for (const b of document.querySelectorAll<HTMLButtonElement>('#mode-switch button'))
    b.onclick = () => {
      if (settings.mode === b.dataset.mode) return;
      settings.mode = b.dataset.mode as Settings['mode'];
      onModeChange();
      schedule();
    };
  document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b === btn));
      view = btn.dataset.view as typeof view;
      showView();
    };
  });
  const light = $<HTMLInputElement>('#light-toggle input');
  light.onchange = () => preview3d?.setBacklit(light.checked);
  attachFraming([canvas, glCanvas], settings, {
    grid: () => gridSize,
    panRange: () => panRange(source, imgGrid.cols, imgGrid.rows, settings),
  }, () => {
    syncControls();
    schedule();
  });
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
    ['Raise Color cell', 'Raise Simplify (Print › Advanced)', 'Increase Pixel size', 'Turn off Dithering'],
    setStatus,
  );
  if (file) triggerDownload(new Blob([file.bytes], { type: 'model/3mf' }), exportFileName(sourceName, 'lithophane'));
  return file;
}

function setupExport() {
  setHeavyExportPrompt(askHeavyExport);
  const btn = $<HTMLButtonElement>('#export');
  btn.onclick = async () => {
    btn.disabled = true;
    $('#stage').classList.add('busy');
    try {
      setStatus('Building 3MF in the background…');
      const m = settings.mode;
      const r = await (m === 'litho' ? exportLitho() : m === 'mosaic' ? mosaic.exportModel(sourceName) : paint!.exportModel(sourceName));
      if (r) {
        const summary = `${r.parts} parts · ${(r.triangles / 1e6).toFixed(2)} M triangles · ${(r.bytes.byteLength / 1e6).toFixed(1)} MB`;
        setStatus(`Exported ${summary}`);
        toast('3MF exported', summary);
      } else setStatus('Export cancelled');
    } catch (e) {
      console.error(e);
      setStatus(`Export failed: ${(e as Error).message}`);
      toast('Export failed', (e as Error).message, 'error');
    } finally {
      btn.disabled = false;
      $('#stage').classList.remove('busy');
    }
  };
}

panel = buildControlPanel(
  $('#controls'),
  settings,
  {
    lithoFilaments: () => buildLithoFilaments((f) => { filaments = f; schedule(); }),
    stack: () => paint!.buildStackPanel(),
    loadout: () => mosaic.buildLoadoutPanel(),
    filaments: () => paint!.buildFilamentPanel(),
  },
  (key) => {
    if (key === 'mode') onModeChange();
    schedule();
  },
);
refreshRangeFills = watchRangeFills($('#controls'));
new ResizeObserver(updateRulers).observe($('#stage'));
syncControls();
applyModeUi();
setupViewer();
setupFileInput();
setupExport();
schedule();
