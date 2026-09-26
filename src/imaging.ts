export interface Framing {
  zoom: number;
  panX: number;
  panY: number;
  rotation: number;
  flip: boolean;
}

export interface Adjust {
  brightness: number;
  contrast: number;
  gamma: number;
  saturation: number;
}

export type Source = HTMLCanvasElement | ImageBitmap;

export async function loadImage(file: Blob, maxDim = 2048): Promise<ImageBitmap> {
  const bmp = await createImageBitmap(file);
  const scale = maxDim / Math.max(bmp.width, bmp.height);
  if (scale >= 1) return bmp;
  const resized = await createImageBitmap(bmp, {
    resizeWidth: Math.round(bmp.width * scale),
    resizeHeight: Math.round(bmp.height * scale),
    resizeQuality: 'high',
  });
  bmp.close();
  return resized;
}

export function demoImage(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 800;
  c.height = 600;
  const ctx = c.getContext('2d')!;
  const hue = ctx.createLinearGradient(0, 0, c.width, 0);
  for (let i = 0; i <= 6; i++) hue.addColorStop(i / 6, `hsl(${i * 60}, 90%, 50%)`);
  ctx.fillStyle = hue;
  ctx.fillRect(0, 0, c.width, c.height);
  const shade = ctx.createLinearGradient(0, 0, 0, c.height);
  shade.addColorStop(0, 'rgba(255,255,255,1)');
  shade.addColorStop(0.5, 'rgba(255,255,255,0)');
  shade.addColorStop(0.5, 'rgba(0,0,0,0)');
  shade.addColorStop(1, 'rgba(0,0,0,1)');
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 110px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 8;
  ctx.strokeStyle = '#000';
  ctx.strokeText('LumiLayer', c.width / 2, c.height / 2);
  ctx.fillText('LumiLayer', c.width / 2, c.height / 2);
  return c;
}

export function sourceAspect(src: Source, rotation: number): number {
  return rotation % 180 ? src.height / src.width : src.width / src.height;
}

function coverGeometry(src: Source, cols: number, rows: number, f: Framing) {
  const rw = f.rotation % 180 ? src.height : src.width;
  const rh = f.rotation % 180 ? src.width : src.height;
  const scale = Math.max(cols / rw, rows / rh) * f.zoom;
  return {
    scale,
    overflowX: Math.max(0, (rw * scale - cols) / 2),
    overflowY: Math.max(0, (rh * scale - rows) / 2),
  };
}

/** How many output pixels the image can move in each direction (pan = ±1). */
export function panRange(src: Source, cols: number, rows: number, f: Framing) {
  const g = coverGeometry(src, cols, rows, f);
  return { x: g.overflowX, y: g.overflowY };
}

export function renderFramed(src: Source, cols: number, rows: number, f: Framing): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, cols, rows);
  const g = coverGeometry(src, cols, rows, f);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(cols / 2 + f.panX * g.overflowX, rows / 2 + f.panY * g.overflowY);
  ctx.rotate((f.rotation * Math.PI) / 180);
  ctx.scale(f.flip ? -g.scale : g.scale, g.scale);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return ctx.getImageData(0, 0, cols, rows);
}

/** Apply tone adjustments; returns sRGB floats (0..1) as RGB triplets. */
export function adjust(rgba: Uint8ClampedArray, a: Adjust): Float32Array {
  const n = rgba.length / 4;
  const out = new Float32Array(n * 3);
  const k = Math.tan(((Math.min(0.99, Math.max(-0.99, a.contrast)) + 1) * Math.PI) / 4);
  const invGamma = 1 / Math.max(0.05, a.gamma);
  const clamp = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
  for (let i = 0; i < n; i++) {
    let r = rgba[i * 4] / 255, g = rgba[i * 4 + 1] / 255, b = rgba[i * 4 + 2] / 255;
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    r = y + (r - y) * a.saturation;
    g = y + (g - y) * a.saturation;
    b = y + (b - y) * a.saturation;
    const tone = (v: number) => Math.pow(clamp((clamp(v) - 0.5) * k + 0.5 + a.brightness), invGamma);
    out[i * 3] = tone(r);
    out[i * 3 + 1] = tone(g);
    out[i * 3 + 2] = tone(b);
  }
  return out;
}
