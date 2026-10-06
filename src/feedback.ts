import { HEAVY_TRIANGLES, type HeavyExportPrompt } from './paint/exportClient';

const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
};

/** Heavy-model confirmation as a modal dialog (Esc or Cancel = don't export). */
export const askHeavyExport: HeavyExportPrompt = (triangles, tips) =>
  new Promise((resolve) => {
    const dlg = make('dialog', 'dialog');
    const m = (triangles / 1e6).toFixed(1);
    const head = make('div', 'dialog-head');
    head.append(make('h2', '', 'This model is heavy'), make('p', '', `${m} M triangles. Slicers may take a long time or seem stuck with files this big.`));
    // The meter puts the 3 M threshold at 40% of the bar.
    const scale = HEAVY_TRIANGLES / 0.4;
    const meter = make('div', 'meter');
    const fill = make('i');
    fill.style.width = `${Math.min(100, (triangles / scale) * 100)}%`;
    meter.appendChild(fill);
    const legend = make('div', 'meter-legend');
    legend.append(make('span', '', 'light'), make('span', '', `${HEAVY_TRIANGLES / 1e6} M`), make('span', '', 'heavy'));
    const list = make('ul', 'tips');
    for (const t of tips) list.appendChild(make('li', '', t));
    const foot = make('div', 'dialog-foot');
    const cancel = make('button', '', 'Cancel');
    const go = make('button', 'primary', 'Export anyway');
    foot.append(cancel, go);
    dlg.append(head, meter, legend, make('p', 'tips-title', 'To lighten it'), list, foot);
    const close = (ok: boolean) => {
      dlg.close();
      dlg.remove();
      resolve(ok);
    };
    cancel.onclick = () => close(false);
    go.onclick = () => close(true);
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      close(false);
    });
    // Some browsers skip the cancel event for repeated Esc presses; handle the key directly too.
    dlg.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(false);
      }
    });
    document.body.appendChild(dlg);
    dlg.showModal();
    cancel.focus();
  });

let toastBox: HTMLElement | null = null;

/** Short-lived notification in the corner of the preview. */
export function toast(title: string, detail = '', kind: 'ok' | 'error' = 'ok') {
  toastBox ??= document.body.appendChild(make('div', 'toasts'));
  toastBox.setAttribute('role', 'status');
  const t = make('div', `toast ${kind}`);
  const icon = make('span', 'toast-icon', kind === 'ok' ? '\u2713' : '!');
  const body = make('div');
  body.append(make('b', '', title));
  if (detail) body.append(make('span', '', detail));
  const x = make('button', 'icon', '\u2715');
  x.title = 'Dismiss';
  t.append(icon, body, x);
  const remove = () => t.remove();
  x.onclick = remove;
  setTimeout(remove, kind === 'error' ? 12000 : 6000);
  toastBox.appendChild(t);
}
