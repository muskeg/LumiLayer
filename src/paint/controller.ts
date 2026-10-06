import { hexLuma, luma } from '../color';
import { exportFileName, triggerDownload } from '../download';
import type { PaintExportInput } from './export';
import {
  DEFAULT_PROFILES, FRAME_SENTINEL, MAX_BANDS, MAX_LAYERS, TD_MAX, TD_MIN,
  layersFromLuminance, loadProfiles, loadStack, newProfileId, normalizeStack, resolveStack, saveProfiles, saveStack,
  type Band, type FilamentProfile, type StackLayer,
} from './model';
import { PaintPreview, type OpticalMode } from './preview';
import { bandOptics, bestLayer, pathLabs, targetLab, type HeightMode } from './optics';
import { runExport, type ExportedFile } from './exportClient';
import { suggestStack } from './suggest';

/** Filament slots of a single AMS unit. */
export const AMS_SLOTS = 4;

/** What one TD means in each mode's optical model (the profiles, and so the values, are shared). */
const TD_HELP = {
  paint: 'after one TD of filament only 5% of the color below still shows (Front-lit view); the Backlit view reads it as ~10% of the light getting through.',
  mosaic: 'after one TD of filament only 5% of the contrast below still shows, so translucent (high-TD) filaments tint the tiles under them.',
};

export interface PaintSettings {
  layerHeight: number;
  /** Height of the darkest pixels, in layers. */
  baseLayers: number;
  frameThickness: number;
  invert: boolean;
  heightMode: HeightMode;
  light: string;
  exposure: number;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

/** Filament painting mode: profiles, layer stack, GPU preview and 3MF export. */
export class PaintController {
  profiles: FilamentProfile[] = loadProfiles();
  bands: Band[] = loadStack(this.profiles);
  readonly preview: PaintPreview;
  /** RGBA per pixel: sRGB color and luminance (alpha, FRAME_SENTINEL for the frame). */
  private pixels: Float32Array | null = null;
  private source: Float32Array | null = null;
  private cols = 0;
  private rows = 0;
  private pixelMm = 0.2;
  private settings: PaintSettings = { layerHeight: 0.08, baseLayers: 6, frameThickness: 1.2, invert: false, heightMode: 'match', light: '#ffffff', exposure: 1 };
  private stackList = el('div', { className: 'stack' });
  private filamentList = el('div', { className: 'profiles' });
  private addBandButton = el('button', { className: 'small', textContent: '+ Add band on top' });
  private suggestButton = el('button', { className: 'small accent', textContent: 'Suggest stack for this image' });
  private saveTimer = 0;
  private worker: Worker | null = null;
  private tdMode: keyof typeof TD_HELP = 'paint';
  private tdHint = el('p', { className: 'hint' });

  constructor(canvas: HTMLCanvasElement, private onChange: () => void, private onStatus: (s: string) => void = () => {}) {
    this.preview = new PaintPreview(canvas);
    this.pushStack();
  }

  // ---- state -------------------------------------------------------------------------------------

  get maxLayers() {
    return this.bands[this.bands.length - 1].top;
  }

  get minLayers() {
    return Math.max(1, Math.min(this.maxLayers - 1, Math.round(this.settings.baseLayers)));
  }

  get frameLayers() {
    return Math.max(1, Math.min(this.maxLayers, Math.round(this.settings.frameThickness / this.settings.layerHeight)));
  }

  get size() {
    return { cols: this.cols, rows: this.rows };
  }

  stack(): StackLayer[] {
    return resolveStack(this.bands, this.profiles, this.settings.layerHeight);
  }

  setSettings(s: Partial<PaintSettings>) {
    const invertChanged = s.invert !== undefined && s.invert !== this.settings.invert;
    Object.assign(this.settings, s);
    if (invertChanged && this.pixels) {
      const px = this.pixels;
      for (let i = 3; i < px.length; i += 4) if (px[i] !== FRAME_SENTINEL) px[i] = 1 - px[i];
      this.preview.setImage(px, this.cols, this.rows);
    }
    this.renderStack();
    this.pushStack();
  }

  setOpticalMode(mode: OpticalMode) {
    this.preview.setParams({ mode });
  }

  /** Build the RGBA texture (color + luminance, or FRAME_SENTINEL alpha for the frame) from an adjusted sRGB image. */
  setImage(srgb: Float32Array, imgCols: number, imgRows: number, border: number, pixelMm: number) {
    const cols = imgCols + 2 * border, rows = imgRows + 2 * border;
    const px = new Float32Array(cols * rows * 4);
    for (let i = 3; i < px.length; i += 4) px[i] = FRAME_SENTINEL;
    for (let y = 0; y < imgRows; y++)
      for (let x = 0; x < imgCols; x++) {
        const s = (y * imgCols + x) * 3;
        const o = ((y + border) * cols + x + border) * 4;
        const v = luma(srgb[s], srgb[s + 1], srgb[s + 2]);
        px[o] = srgb[s];
        px[o + 1] = srgb[s + 1];
        px[o + 2] = srgb[s + 2];
        px[o + 3] = this.settings.invert ? 1 - v : v;
      }
    this.pixels = px;
    this.source = srgb;
    this.cols = cols;
    this.rows = rows;
    this.pixelMm = pixelMm;
    this.preview.setImage(px, cols, rows);
  }

  /** Printed height (mm) of every pixel: read back from the preview shader, so the export matches exactly. */
  heights(): Float32Array {
    const px = this.pixels;
    const n = px ? px.length / 4 : 0;
    const out = new Float32Array(n);
    if (!px) return out;
    const lh = this.settings.layerHeight;
    const gpu = this.preview.readLayers();
    if (gpu && gpu.length === n) {
      for (let i = 0; i < n; i++) out[i] = gpu[i] * lh;
      return out;
    }
    // No WebGL: same formulas on the CPU.
    const { minLayers, maxLayers, frameLayers } = this;
    const path = pathLabs(bandOptics(this.stack(), lh), lh, minLayers, maxLayers);
    const lab = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const a = px[i * 4 + 3];
      let layers: number;
      if (a < 0 || this.settings.heightMode === 'luminance') layers = layersFromLuminance(a, minLayers, maxLayers, frameLayers);
      else {
        targetLab(px[i * 4], px[i * 4 + 1], px[i * 4 + 2], lab);
        layers = bestLayer(path, minLayers, lab[0], lab[1], lab[2]);
      }
      out[i] = layers * lh;
    }
    return out;
  }

  exportInput(title: string): PaintExportInput {
    return {
      heights: this.heights(),
      cols: this.cols,
      rows: this.rows,
      widthMm: this.cols * this.pixelMm,
      heightMm: this.rows * this.pixelMm,
      baseHeight: this.minLayers * this.settings.layerHeight,
      layerHeight: this.settings.layerHeight,
      stack: this.stack(),
      title,
    };
  }

  /** Build the 3MF in a Web Worker and download it; null if the user cancels a heavy export. */
  async exportModel(title: string): Promise<ExportedFile | null> {
    const input = this.exportInput(title);
    this.worker ??= new Worker(new URL('./threeMfWorker.ts', import.meta.url), { type: 'module' });
    const file = await runExport(this.worker, input, [input.heights.buffer], 'increase Pixel size or lower the top band', this.onStatus);
    if (file) triggerDownload(new Blob([file.bytes], { type: 'model/3mf' }), exportFileName(title, 'painting'));
    return file;
  }

  /** Replace the stack with the best up-to-4-filament stack for the current image, from the user's profiles. */
  async suggest() {
    if (!this.source) return;
    const btn = this.suggestButton;
    btn.disabled = true;
    try {
      const { bands } = await suggestStack(
        {
          srgb: this.source,
          invert: this.settings.invert,
          heightMode: this.settings.heightMode,
          minLayers: this.minLayers,
          maxLayers: this.maxLayers,
          layerHeight: this.settings.layerHeight,
          profiles: this.profiles,
          maxFilaments: AMS_SLOTS,
        },
        (f) => this.onStatus(`Comparing filament stacks… ${Math.round(f * 100)}%`),
      );
      this.bands = bands;
      this.changed(true);
      const names = this.stack().map((s) => s.name).join(' → ');
      this.onStatus(`Suggested (bottom to top): ${names}. Check that the colors and TDs match your actual rolls.`);
    } catch (e) {
      this.onStatus(`Suggestion failed: ${(e as Error).message}`);
    } finally {
      btn.disabled = false;
    }
  }

  private pushStack() {
    this.preview.setLayers(this.stack());
    this.preview.setParams({
      layerHeight: this.settings.layerHeight,
      minLayers: this.minLayers,
      maxLayers: this.maxLayers,
      frameLayers: this.frameLayers,
      heightMode: this.settings.heightMode,
      light: this.settings.light,
      exposure: this.settings.exposure,
    });
    this.onChange();
  }

  private persist() {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      saveProfiles(this.profiles);
      saveStack(this.bands);
    }, 250);
  }

  private changed(structure: boolean) {
    if (structure) {
      this.bands = normalizeStack(this.bands, this.profiles);
      this.renderStack();
    }
    this.pushStack();
    this.persist();
  }

  // ---- filament manager --------------------------------------------------------------------------

  buildFilamentPanel(): HTMLElement {
    const add = el('button', { className: 'small', textContent: '+ Add filament' });
    add.onclick = () => {
      this.profiles.push({ id: newProfileId(this.profiles), name: 'New filament', color: '#888888', td: 1.5 });
      this.renderProfiles();
      this.changed(true);
    };
    const reset = el('button', { className: 'small', textContent: 'Reset to defaults' });
    reset.onclick = () => {
      if (!confirm('Replace your filament profiles with the defaults?')) return;
      this.profiles = structuredClone(DEFAULT_PROFILES);
      this.renderProfiles();
      this.changed(true);
    };
    this.renderProfiles();
    this.setTdHelp(this.tdMode);
    return el('div', {}, this.filamentList, el('div', { className: 'button-row' }, add, reset), this.tdHint);
  }

  /** The filament panel is shared by painting and mosaic; explain TD for the active one. */
  setTdHelp(mode: keyof typeof TD_HELP) {
    this.tdMode = mode;
    this.tdHint.textContent = `TD (transmission distance, mm): ${TD_HELP[mode]} Profiles are saved in this browser and shared by painting and mosaic.`;
    for (const td of this.filamentList.querySelectorAll<HTMLInputElement>('input[type=range]')) td.title = this.tdTitle();
  }

  private tdTitle() {
    return `Transmission distance (mm): ${TD_HELP[this.tdMode]}`;
  }

  private renderProfiles() {
    this.filamentList.replaceChildren(
      ...this.profiles.map((p) => {
        const color = el('input', { type: 'color', value: p.color, title: 'Filament color' });
        const name = el('input', { type: 'text', value: p.name, maxLength: 40, title: 'Filament name' });
        const td = el('input', { type: 'range', min: String(TD_MIN), max: String(TD_MAX), step: '0.1', value: String(p.td), title: this.tdTitle() });
        const tdOut = el('output', { textContent: `${p.td.toFixed(1)}mm` });
        const del = el('button', { className: 'icon', textContent: '✕', title: 'Delete filament', disabled: this.profiles.length <= 1 });
        color.oninput = () => { p.color = color.value; this.changed(true); };
        name.oninput = () => { p.name = name.value.trim() || 'Filament'; this.changed(true); };
        td.oninput = () => { p.td = Number(td.value); tdOut.textContent = `${p.td.toFixed(1)}mm`; this.changed(false); };
        del.onclick = () => {
          this.profiles = this.profiles.filter((q) => q !== p);
          this.renderProfiles();
          this.changed(true);
        };
        return el('div', { className: 'profile' }, color, name, td, tdOut, del);
      }),
    );
  }

  // ---- layer stack -------------------------------------------------------------------------------

  buildStackPanel(): HTMLElement {
    this.addBandButton.onclick = () => {
      if (this.bands.length >= MAX_BANDS || this.maxLayers >= MAX_LAYERS) return;
      const last = this.bands[this.bands.length - 1];
      const next = this.profiles.find((p) => p.id !== last.filamentId) ?? this.profiles[0];
      this.bands.push({ filamentId: next.id, top: Math.min(MAX_LAYERS, last.top + 4) });
      this.changed(true);
    };
    this.renderStack();
    this.suggestButton.onclick = () => this.suggest();
    return el('div', {}, this.suggestButton, this.stackList, this.addBandButton,
      el('p', { className: 'hint', textContent: `Suggest picks the best ${AMS_SLOTS} (or fewer) of your filament profiles and their heights for this image. Top of the print first; the badge is the AMS slot. Drag ⠿ (or focus it and use ↑/↓) to reorder; sliders set where each band ends.` }));
  }

  private renderStack() {
    const lh = this.settings.layerHeight;
    const n = this.bands.length;
    const resolved = this.stack();
    const rows: HTMLElement[] = [];
    let dragFrom = -1;
    for (let i = n - 1; i >= 0; i--) {
      const band = this.bands[i];
      const profile = this.profiles.find((p) => p.id === band.filamentId) ?? this.profiles[0];
      const startOf = () => (i > 0 ? this.bands[i - 1].top : 0);
      const start = startOf();

      const handle = el('span', { className: 'handle', textContent: '⠿', tabIndex: 0, title: 'Drag to reorder (or ↑/↓)' });
      const slot = resolved[i].materialId + 1;
      const swatch = el('span', {
        className: slot > AMS_SLOTS ? 'swatch over' : 'swatch',
        textContent: String(slot),
        title: slot > AMS_SLOTS ? `Slot ${slot}: needs more than one ${AMS_SLOTS}-slot AMS` : `AMS slot ${slot}`,
      });
      swatch.style.background = profile.color;
      swatch.style.color = isLight(profile.color) ? '#000' : '#fff';
      const select = el('select', { title: 'Filament' });
      for (const p of this.profiles) select.add(new Option(p.name, p.id, false, p.id === profile.id));
      const slider = el('input', {
        type: 'range',
        min: String(start + 1),
        max: String(i < n - 1 ? this.bands[i + 1].top - 1 : MAX_LAYERS),
        step: '1',
        value: String(band.top),
        title: 'Band top (layers)',
      });
      const label = el('span', { className: 'range-label', textContent: bandLabel(start, band.top, lh) });
      const del = el('button', { className: 'icon', textContent: '✕', title: 'Remove band', disabled: n <= 1 });

      select.onchange = () => { band.filamentId = select.value; this.changed(true); };
      slider.oninput = () => {
        band.top = Number(slider.value);
        label.textContent = bandLabel(startOf(), band.top, lh);
        // Live update of neighbours without rebuilding the list, so the drag isn't interrupted.
        const above = rows[n - 1 - (i + 1)];
        if (above) {
          (above.querySelector('input[type=range]') as HTMLInputElement).min = String(band.top + 1);
          above.querySelector('.range-label')!.textContent = bandLabel(band.top, this.bands[i + 1].top, lh);
        }
        const below = rows[n - 1 - (i - 1)];
        if (below) (below.querySelector('input[type=range]') as HTMLInputElement).max = String(band.top - 1);
        this.pushStack();
      };
      slider.onchange = () => this.changed(true);
      del.onclick = () => {
        this.bands.splice(i, 1);
        this.changed(true);
      };

      const row = el('div', { className: 'band' }, handle, swatch, select, slider, label, del);
      row.draggable = false;
      handle.onpointerdown = () => (row.draggable = true);
      handle.onkeydown = (e) => {
        const to = e.key === 'ArrowUp' ? i + 1 : e.key === 'ArrowDown' ? i - 1 : -1;
        if (to < 0 || to >= n) return;
        e.preventDefault();
        this.moveFilament(i, to);
        (this.stackList.children[n - 1 - to]?.querySelector('.handle') as HTMLElement | null)?.focus();
      };
      row.ondragstart = (e) => {
        dragFrom = i;
        e.dataTransfer!.effectAllowed = 'move';
        e.dataTransfer!.setData('text/plain', String(i));
        row.classList.add('dragging');
      };
      row.ondragend = () => {
        row.draggable = false;
        row.classList.remove('dragging');
      };
      row.ondragover = (e) => {
        if (dragFrom < 0) return;
        e.preventDefault();
        row.classList.add('drop-target');
      };
      row.ondragleave = () => row.classList.remove('drop-target');
      row.ondrop = (e) => {
        e.preventDefault();
        row.classList.remove('drop-target');
        if (dragFrom >= 0 && dragFrom !== i) this.moveFilament(dragFrom, i);
        dragFrom = -1;
      };
      rows.push(row);
    }
    this.stackList.replaceChildren(...rows);
    this.addBandButton.disabled = n >= MAX_BANDS || this.maxLayers >= MAX_LAYERS;
  }

  /** Reorder which filament goes in which band; band heights stay where they are. */
  private moveFilament(from: number, to: number) {
    const ids = this.bands.map((b) => b.filamentId);
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved);
    this.bands.forEach((b, k) => (b.filamentId = ids[k]));
    this.changed(true);
  }
}

function bandLabel(start: number, top: number, lh: number) {
  return `${(start * lh).toFixed(2)}–${(top * lh).toFixed(2)} mm`;
}

export const isLight = (hex: string) => hexLuma(hex) > 140 / 255;
