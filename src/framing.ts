import type { Settings } from './settings';

/** How the preview maps to the image: grid size in output pixels and how far the image can pan. */
export interface FramingView {
  grid(): { cols: number; rows: number };
  panRange(): { x: number; y: number };
}

/** Drag to pan, wheel to zoom on the preview canvases; `onChange` runs after `settings` is updated. */
export function attachFraming(targets: HTMLElement[], settings: Settings, view: FramingView, onChange: () => void) {
  for (const target of targets) {
    let drag: { x: number; y: number } | null = null;
    target.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY };
      target.setPointerCapture(e.pointerId);
    });
    target.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const rect = target.getBoundingClientRect();
      const { cols, rows } = view.grid();
      const scale = Math.min(rect.width / cols, rect.height / rows);
      const range = view.panRange();
      const dx = (e.clientX - drag.x) / scale;
      const dy = (e.clientY - drag.y) / scale;
      drag = { x: e.clientX, y: e.clientY };
      if (range.x > 0) settings.panX = Math.min(1, Math.max(-1, settings.panX + dx / range.x));
      if (range.y > 0) settings.panY = Math.min(1, Math.max(-1, settings.panY + dy / range.y));
      onChange();
    });
    target.addEventListener('pointerup', () => (drag = null));
    target.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        settings.zoom = Math.min(6, Math.max(1, settings.zoom * Math.exp(-e.deltaY * 0.0015)));
        onChange();
      },
      { passive: false },
    );
  }
}
