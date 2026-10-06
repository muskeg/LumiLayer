import { DEFAULTS, SECTIONS, type Ctl, type ExtraPanel, type Key, type Mode, type Settings } from './settings';

export interface ControlPanel {
  /** Push `settings` values into the inputs (after code changed them). */
  sync(): void;
  /** Show only the sections and rows that apply to `mode`. */
  showMode(mode: Mode): void;
}

function fmt(c: Ctl, v: unknown): string {
  if (c.type !== 'range') return '';
  const decimals = c.step >= 1 ? 0 : c.step >= 0.1 ? 1 : 2;
  return `${Number(v).toFixed(decimals)}${c.unit ?? ''}`;
}

/** Builds the settings panel from SECTIONS; `onChange` gets the edited key, or null after a section reset. */
export function buildControlPanel(
  root: HTMLElement,
  settings: Settings,
  extras: Record<ExtraPanel, () => HTMLElement>,
  onChange: (key: Key | null) => void,
): ControlPanel {
  const record = settings as unknown as Record<string, unknown>;
  const inputs = new Map<Key, HTMLInputElement | HTMLSelectElement>();
  const outputs = new Map<Key, HTMLOutputElement>();
  const rows = new Map<Key, HTMLElement>();
  const sectionEls = new Map<(typeof SECTIONS)[number], HTMLElement>();
  const controls = SECTIONS.flatMap((s) => s.controls);

  const sync = () => {
    for (const c of controls) {
      const input = inputs.get(c.key)!;
      const v = settings[c.key];
      if (c.type === 'checkbox') (input as HTMLInputElement).checked = !!v;
      else input.value = String(v);
      outputs.get(c.key)!.textContent = fmt(c, v);
    }
  };

  const buildControl = (c: Ctl): HTMLElement => {
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
      onChange(c.key);
    });
    row.appendChild(input);
    const out = document.createElement('output');
    row.appendChild(out);
    inputs.set(c.key, input);
    outputs.set(c.key, out);
    rows.set(c.key, row);
    return row;
  };

  for (const section of SECTIONS) {
    const det = document.createElement('details');
    det.open = !!section.open;
    const summary = document.createElement('summary');
    summary.textContent = section.title;
    det.appendChild(summary);
    for (const c of section.controls) det.appendChild(buildControl(c));
    if (section.resetLabel) {
      const reset = document.createElement('button');
      reset.textContent = section.resetLabel;
      reset.className = 'small';
      reset.onclick = () => {
        for (const c of section.controls) record[c.key] = DEFAULTS[c.key];
        sync();
        onChange(null);
      };
      det.appendChild(reset);
    }
    if (section.extra) det.appendChild(extras[section.extra]());
    sectionEls.set(section, det);
    root.appendChild(det);
  }

  return {
    sync,
    showMode(mode) {
      for (const [section, elem] of sectionEls) elem.hidden = !!section.modes && !section.modes.includes(mode);
      for (const c of controls) if (c.modes) rows.get(c.key)!.hidden = !c.modes.includes(mode);
    },
  };
}
