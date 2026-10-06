import { hexLuma } from '../color';

/** Filament slots of a single AMS unit. */
export const AMS_SLOTS = 4;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

/** Whether black text reads better than white on this color. */
export const isLight = (hex: string) => hexLuma(hex) > 140 / 255;
