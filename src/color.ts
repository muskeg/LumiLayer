export type RGB = [number, number, number];

export interface Filament {
  name: string;
  color: string;
  /** Transmission distance: thickness (mm) at which ~10% of light still passes. */
  td: number;
  enabled: boolean;
}

export function hexToRgb(hex: string): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0xffffff;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgbToHex([r, g, b]: RGB): string {
  const h = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

export const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
export const linearToSrgb = (c: number) =>
  c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;

export const luminance = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** CIE L* scaled to 0..1 from relative luminance. */
export function lightness(y: number): number {
  const l = y > 216 / 24389 ? 116 * Math.cbrt(y) - 16 : (24389 / 27) * y;
  return Math.min(1, Math.max(0, l / 100));
}

export function linearToOklab(r: number, g: number, b: number, out: Float32Array | number[], o = 0) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  out[o] = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  out[o + 1] = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  out[o + 2] = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
}

const SCATTER = Math.LN10;
const CHROMA_GAIN = 4;

/**
 * Per-channel Beer-Lambert absorption coefficient (1/mm) of a filament.
 * Scattering attenuates all channels equally (10% left at TD); the hue adds
 * extra absorption in the channels the filament color lacks.
 */
export function absorption(f: Filament): RGB {
  const td = Math.max(0.05, f.td);
  return hexToRgb(f.color).map(
    (c) => (SCATTER + CHROMA_GAIN * -Math.log(Math.max(srgbToLinear(c), 0.005))) / td,
  ) as RGB;
}
