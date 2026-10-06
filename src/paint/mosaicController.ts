import { hexToRgb, srgbToLinear } from '../color';
import { exportFileName, triggerDownload } from '../download';
import { swatchGeometry, swatchPlate, swatchRows, type SwatchRow } from './swatches';
import {
  buildCombos, mosaicStats, mosaicVoxels, KdTree, loadoutOptics, combosFromList, renderMosaic, solveMosaic,
  type MosaicFilament, type MosaicResult, type ComboConfig, type ComboSet,
} from './mosaic';
import { AMS_SLOTS, el, isLight } from './ui';
import type { MosaicExportInput } from './export';
import { restoreLoadout, normalizeLoadout, storeLoadout, type FilamentProfile } from './model';
import { pickLoadout } from './loadout';
import { runExport, type ExportedFile } from './exportClient';

export interface MosaicSettings {
  layerHeight: number;
  groundLayers: number;
  tintLayers: number;
  maxSegments: number;
  stepped: boolean;
  dither: boolean;
  minIsland: number;
  frameThickness: number;
  light: string;
  exposure: number;
}

export type MosaicDisplay = 'predicted' | 'swatches';

interface ImageInput {
  srgb: Float32Array;
  cols: number;
  rows: number;
  border: number;
  pixelMm: number;
}

/** Filament mosaic mode: loadout, combo solving, swatch plate and 3MF export. Filament profiles are shared with painting. */
export class MosaicController {
  loadout: string[];
  result: MosaicResult | null = null;
  private settings: MosaicSettings = {
    layerHeight: 0.08, groundLayers: 7, tintLayers: 8, maxSegments: 3, stepped: true, dither: false, minIsland: 3,
    frameThickness: 1.2, light: '#ffffff', exposure: 1,
  };
  private image: ImageInput | null = null;
  private set: ComboSet | null = null;
  private tree: KdTree | null = null;
  private setKey = '';
  private swatches: { rows: SwatchRow[]; set: ComboSet } | null = null;
  private loadoutBox = el('div', { className: 'loadout' });
  private pickButton = el('button', { className: 'small accent', textContent: 'Auto-pick loadout for this image' });
  private swatchButton = el('button', { className: 'small', textContent: 'Download swatch plate' });

  constructor(private getProfiles: () => FilamentProfile[], private onChange: () => void, private onStatus: (s: string) => void = () => {}) {
    this.loadout = restoreLoadout(getProfiles(), AMS_SLOTS);
  }

  get size() {
    return { cols: this.result?.cols ?? 0, rows: this.result?.rows ?? 0 };
  }

  get pixelMm() {
    return this.image?.pixelMm ?? 0.4;
  }

  filaments(): MosaicFilament[] {
    const profiles = this.getProfiles();
    this.loadout = normalizeLoadout(this.loadout, profiles, AMS_SLOTS);
    return this.loadout.map((id) => {
      const p = profiles.find((q) => q.id === id)!;
      return { name: p.name, color: p.color, td: p.td };
    });
  }

  config(): ComboConfig {
    const s = this.settings;
    return { layerHeight: s.layerHeight, groundLayers: s.groundLayers, tintLayers: s.tintLayers, maxSegments: s.maxSegments };
  }

  setSettings(s: Partial<MosaicSettings>) {
    Object.assign(this.settings, s);
  }

  setImage(srgb: Float32Array, cols: number, rows: number, border: number, pixelMm: number) {
    this.image = { srgb, cols, rows, border, pixelMm };
    this.update();
  }

  /** Rebuild combos if the loadout or combo settings changed, then re-solve the image. */
  update() {
    const filaments = this.filaments();
    const cfg = this.config();
    const key = JSON.stringify([filaments, cfg]);
    if (key !== this.setKey) {
      const optics = loadoutOptics(filaments, cfg);
      this.set = buildCombos(filaments, optics, cfg);
      this.tree = new KdTree(this.set.lab);
      const rows = swatchRows(filaments);
      this.swatches = { rows, set: combosFromList(filaments, optics, cfg, rows.flatMap((r) => r.swatches)) };
      this.setKey = key;
      this.renderLoadout();
    }
    const img = this.image;
    if (!img || !this.set || !this.tree) return;
    const s = this.settings;
    this.result = solveMosaic(img.srgb, img.cols, img.rows, img.border, this.set, this.tree, {
      stepped: s.stepped,
      dither: s.dither,
      minIsland: s.minIsland,
      frameLayers: Math.max(1, Math.round(s.frameThickness / s.layerHeight)),
    });
  }

  private light() {
    return hexToRgb(this.settings.light).map((c) => srgbToLinear(c) * this.settings.exposure);
  }

  /** Draw the predicted print or the swatch plate into a 2D canvas. */
  draw(canvas: HTMLCanvasElement, display: MosaicDisplay) {
    if (display === 'swatches') return this.drawSwatches(canvas);
    const r = this.result;
    if (!r) return;
    canvas.width = r.cols;
    canvas.height = r.rows;
    canvas.getContext('2d')!.putImageData(new ImageData(renderMosaic(r, this.light()) as Uint8ClampedArray<ArrayBuffer>, r.cols, r.rows), 0, 0);
  }

  /** Predicted print at tile resolution (texture for the 3D view). */
  snapshot(): HTMLCanvasElement | null {
    if (!this.result) return null;
    const c = document.createElement('canvas');
    this.draw(c, 'predicted');
    return c;
  }

  /** Printed height (mm) of every tile. */
  heights(): Float32Array {
    const r = this.result;
    return r ? Float32Array.from(r.layers, (l) => l * this.settings.layerHeight) : new Float32Array(0);
  }

  swatchPlate(): MosaicResult | null {
    return this.swatches && this.swatches.rows.length ? swatchPlate(this.swatches.rows, this.swatches.set, this.pixelMm) : null;
  }

  private drawSwatches(canvas: HTMLCanvasElement) {
    const res = this.swatchPlate();
    const ctx = canvas.getContext('2d')!;
    if (!res || !this.swatches) {
      canvas.width = 480;
      canvas.height = 120;
      ctx.fillStyle = '#0b0c0f';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#9aa0aa';
      ctx.font = '16px system-ui, sans-serif';
      ctx.fillText('Pick at least two filaments in the loadout.', 20, 64);
      return;
    }
    const g = swatchGeometry(this.swatches.rows, this.pixelMm);
    const scale = Math.max(1, Math.round(1000 / res.cols));
    const font = `${Math.max(12, Math.round(g.swatchTiles * scale * 0.26))}px system-ui, sans-serif`;
    ctx.font = font;
    const labelW = Math.ceil(Math.max(...this.swatches.rows.map((r) => ctx.measureText(r.label).width))) + 40;
    canvas.width = res.cols * scale + labelW;
    canvas.height = res.rows * scale;
    ctx.fillStyle = '#0b0c0f';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const tmp = document.createElement('canvas');
    tmp.width = res.cols;
    tmp.height = res.rows;
    tmp.getContext('2d')!.putImageData(new ImageData(renderMosaic(res, this.light()) as Uint8ClampedArray<ArrayBuffer>, res.cols, res.rows), 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, res.cols * scale, res.rows * scale);
    ctx.font = font;
    ctx.fillStyle = '#c9ccd3';
    ctx.textBaseline = 'middle';
    this.swatches.rows.forEach((row, r) => {
      const { y } = g.swatchAt(r, 0);
      ctx.fillText(row.label, res.cols * scale + 20, (y + g.swatchTiles / 2) * scale);
    });
  }

  /** Headline, details and printing hint for the info bar. */
  info(): [string, string, string] | null {
    const r = this.result;
    if (!r) return null;
    const lh = this.settings.layerHeight;
    const px = this.pixelMm;
    let top = 0;
    for (const l of r.layers) top = Math.max(top, l);
    const st = mosaicStats(r);
    const names = r.set.filaments.map((f, i) => `${i + 1}. ${f.name}${i === 0 ? ' (ground)' : ''} ${Math.round(st.share[i] * 100)}%`).join(', ');
    return [
      `${(r.cols * px).toFixed(1)} × ${(r.rows * px).toFixed(1)} × ${(top * lh).toFixed(2)} mm`,
      `${r.cols}×${r.rows} tiles @ ${px.toFixed(2)} mm · ${st.combos} tile combos in use (of ${r.set.count}) · ${st.mixedLayers} layers with filament swaps · ${names}`,
      `Print face-up as exported, ${lh.toFixed(2)} mm layers (first layer a whole multiple of it), 100% infill. Tile size should be at least your nozzle width. Expect filament swaps on most tint layers.`,
    ];
  }

  // ---- export ------------------------------------------------------------------------------------

  exportModel(title: string) {
    if (!this.result) return Promise.reject(new Error('Nothing to export yet.'));
    return this.exportResult(this.result, title, 'mosaic');
  }

  private async exportResult(res: MosaicResult, title: string, kind: string): Promise<ExportedFile | null> {
    const { voxels, K } = mosaicVoxels(res);
    const px = this.pixelMm;
    const input: MosaicExportInput = {
      kind: 'mosaic', voxels, cols: res.cols, rows: res.rows, K,
      widthMm: res.cols * px, heightMm: res.rows * px, layerHeight: this.settings.layerHeight,
      filaments: res.set.filaments.map((f) => ({ name: f.name, color: f.color })),
      title,
    };
    const worker = new Worker(new URL('./threeMfWorker.ts', import.meta.url), { type: 'module' });
    try {
      const file = await runExport(worker, input, [voxels.buffer], 'increase Pixel size, raise Min island or turn off Dithering', this.onStatus);
      if (file) triggerDownload(new Blob([file.bytes], { type: 'model/3mf' }), exportFileName(title, kind));
      return file;
    } finally {
      worker.terminate();
    }
  }

  private async exportSwatches() {
    const res = this.swatchPlate();
    if (!res) return this.onStatus('Pick at least two filaments in the loadout first.');
    this.swatchButton.disabled = true;
    try {
      this.onStatus('Building swatch plate…');
      const r = await this.exportResult(res, 'lumilayer', 'swatch-plate');
      if (!r) return this.onStatus('Swatch plate export cancelled');
      this.onStatus(`Swatch plate exported (${r.parts} parts). Print it with the same layer height, then tune each filament's color and TD until the "Swatches" view looks like the print.`);
    } catch (e) {
      this.onStatus(`Swatch plate export failed: ${(e as Error).message}`);
    } finally {
      this.swatchButton.disabled = false;
    }
  }

  // ---- loadout -----------------------------------------------------------------------------------

  private async autoPick() {
    if (!this.image) return;
    this.pickButton.disabled = true;
    try {
      const { ids } = await pickLoadout(
        { srgb: this.image.srgb, profiles: this.getProfiles(), slots: AMS_SLOTS, config: this.config() },
        (f) => this.onStatus(`Trying loadouts… ${Math.round(f * 100)}%`),
      );
      this.setLoadout(ids);
      this.onStatus(`Picked loadout: ${this.filaments().map((f) => f.name).join(', ')}. Print the swatch plate and tune these filaments for an accurate preview.`);
    } catch (e) {
      this.onStatus(`Auto-pick failed: ${(e as Error).message}`);
    } finally {
      this.pickButton.disabled = false;
    }
  }

  private setLoadout(ids: string[]) {
    this.loadout = normalizeLoadout(ids, this.getProfiles(), AMS_SLOTS);
    storeLoadout(this.loadout);
    this.renderLoadout();
    this.onChange();
  }

  buildLoadoutPanel(): HTMLElement {
    this.pickButton.onclick = () => this.autoPick();
    this.swatchButton.onclick = () => this.exportSwatches();
    this.renderLoadout();
    return el('div', {}, this.pickButton, this.loadoutBox, el('div', { className: 'button-row' }, this.swatchButton),
      el('p', {
        className: 'hint',
        textContent: `Slot 1 is the ground under every tile (usually the darkest filament); the lightest filament controls brightness, and translucent ones on top tint what's below. ` +
          `Print the swatch plate, then tune each filament's color and TD until the "Swatches" view looks like it.`,
      }));
  }

  private renderLoadout() {
    const profiles = this.getProfiles();
    this.loadout = normalizeLoadout(this.loadout, profiles, AMS_SLOTS);
    const rows: HTMLElement[] = [];
    for (let slot = 0; slot < AMS_SLOTS; slot++) {
      const id = this.loadout[slot] ?? '';
      const profile = profiles.find((p) => p.id === id);
      const swatch = el('span', { className: 'swatch', textContent: String(slot + 1), title: slot === 0 ? 'Ground (AMS slot 1)' : `AMS slot ${slot + 1}` });
      swatch.style.background = profile?.color ?? 'transparent';
      swatch.style.color = profile && isLight(profile.color) ? '#000' : '#fff';
      const select = el('select', { title: slot === 0 ? 'Ground filament' : 'Filament' });
      if (slot > 0) select.add(new Option('— empty —', '', false, !profile));
      for (const p of profiles) select.add(new Option(p.name, p.id, false, p.id === id));
      select.onchange = () => {
        const ids = [...this.loadout];
        if (slot < ids.length) ids[slot] = select.value;
        else ids.push(select.value);
        this.setLoadout(ids.filter(Boolean));
      };
      rows.push(el('div', { className: 'slot-row' }, swatch, select, el('span', { className: 'range-label', textContent: slot === 0 ? 'ground' : '' })));
    }
    this.loadoutBox.replaceChildren(...rows);
  }
}
