import { DEFAULTS, MODE_DEFAULTS, SECTIONS, type Ctl, type ExtraPanel, type Key, type Mode, type Section, type Settings } from './settings';

export interface ControlPanel {
  /** Push `settings` values into the inputs (after code changed them). */
  sync(): void;
  /** Show only the sections and rows that apply to `mode`, numbered in order. */
  showMode(mode: Mode): void;
}

function fmt(c: Ctl, v: unknown): string {
  if (c.type === 'number') return c.unit ?? '';
  if (c.type !== 'range') return '';
  const decimals = c.step >= 1 ? 0 : c.step >= 0.1 ? 1 : 2;
  return `${Number(v).toFixed(decimals)}${c.unit && c.unit !== '×' ? ` ${c.unit}` : (c.unit ?? '')}`;
}

/** Builds the settings panel from SECTIONS; `onChange` gets the edited key, or null after a section reset. */
export function buildControlPanel(
  root: HTMLElement,
  settings: Settings,
  extras: Record<ExtraPanel, () => HTMLElement>,
  onChange: (key: Key | null) => void,
): ControlPanel {
  const record = settings as unknown as Record<string, unknown>;
  const inputs = new Map<Key, HTMLInputElement | HTMLSelectElement | HTMLElement>();
  const outputs = new Map<Key, HTMLOutputElement>();
  const rows = new Map<Key, HTMLElement>();
  const sections: { section: Section; el: HTMLDetailsElement; num: HTMLElement; sum: HTMLElement; adv: HTMLDetailsElement | null }[] = [];
  const controls = SECTIONS.flatMap((s) => s.controls);
  let mode: Mode = settings.mode;

  const refreshSummaries = () => {
    for (const s of sections) s.sum.textContent = s.section.summary?.(settings) ?? '';
  };

  const sync = () => {
    for (const c of controls) {
      const input = inputs.get(c.key)!;
      const v = settings[c.key];
      if (c.type === 'checkbox') (input as HTMLInputElement).checked = !!v;
      else if (c.type === 'seg') for (const b of input.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.value === String(v)));
      else (input as HTMLInputElement).value = String(v);
      outputs.get(c.key)!.textContent = fmt(c, v);
    }
    refreshSummaries();
  };

  const commit = (c: Ctl, v: unknown) => {
    record[c.key] = v;
    outputs.get(c.key)!.textContent = fmt(c, v);
    refreshSummaries();
    onChange(c.key);
  };

  const buildControl = (c: Ctl): HTMLElement => {
    // Segmented rows hold buttons, which a <label> would forward clicks to.
    const row = document.createElement(c.type === 'seg' ? 'div' : 'label');
    row.className = c.type === 'seg' ? 'row segmented' : `row ${c.type}`;
    if (c.hint) row.title = c.hint;
    const name = document.createElement('span');
    name.textContent = c.label;
    row.appendChild(name);
    let input: HTMLInputElement | HTMLSelectElement | HTMLElement;
    if (c.type === 'seg') {
      input = document.createElement('div');
      input.className = 'seg sm full';
      input.setAttribute('role', 'group');
      input.setAttribute('aria-label', c.label);
      for (const [v, l] of c.options) {
        const b = document.createElement('button');
        b.type = 'button';
        b.value = v;
        b.textContent = l;
        b.onclick = () => {
          for (const x of input.querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
          commit(c, c.numeric ? Number(v) : v);
        };
        input.appendChild(b);
      }
    } else if (c.type === 'select') {
      const sel = document.createElement('select');
      for (const [v, l] of c.options) sel.add(new Option(l, v));
      sel.addEventListener('input', () => commit(c, c.numeric ? Number(sel.value) : sel.value));
      input = sel;
    } else {
      const inp = document.createElement('input');
      inp.type = c.type;
      if (c.type === 'range' || c.type === 'number') {
        inp.min = String(c.min);
        inp.max = String(c.max);
        inp.step = String(c.step);
      }
      inp.addEventListener('input', () => {
        if (c.type === 'checkbox') return commit(c, inp.checked);
        if (c.type === 'range' || c.type === 'number') {
          const n = parseFloat(inp.value);
          if (Number.isFinite(n)) commit(c, Math.min(c.max, Math.max(c.min, n)));
          return;
        }
        commit(c, inp.value);
      });
      input = inp;
    }
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
    det.className = 'step';
    det.open = !!section.open;
    const summary = document.createElement('summary');
    const num = document.createElement('span');
    num.className = 'step-num';
    const title = document.createElement('span');
    title.className = 'step-title';
    title.textContent = section.title;
    const sum = document.createElement('span');
    sum.className = 'step-sum';
    summary.append(num, title, sum);
    det.appendChild(summary);
    for (const c of section.controls) if (!c.advanced) det.appendChild(buildControl(c));
    let adv: HTMLDetailsElement | null = null;
    if (section.controls.some((c) => c.advanced)) {
      adv = document.createElement('details');
      adv.className = 'advanced';
      const s = document.createElement('summary');
      s.textContent = 'Advanced';
      adv.appendChild(s);
      for (const c of section.controls) if (c.advanced) adv.appendChild(buildControl(c));
      det.appendChild(adv);
    }
    if (section.extra) det.appendChild(extras[section.extra]());
    if (section.resetLabel) {
      const reset = document.createElement('button');
      reset.textContent = section.resetLabel;
      reset.className = 'small';
      reset.onclick = () => {
        for (const c of section.controls) if (!c.modes || c.modes.includes(mode)) record[c.key] = MODE_DEFAULTS[mode][c.key] ?? DEFAULTS[c.key];
        sync();
        onChange(null);
      };
      det.appendChild(reset);
    }
    sections.push({ section, el: det, num, sum, adv });
    root.appendChild(det);
  }

  return {
    sync,
    showMode(m) {
      mode = m;
      const applies = (c: Ctl) => !c.modes || c.modes.includes(m);
      let n = 0;
      for (const s of sections) {
        s.el.hidden = !!s.section.modes && !s.section.modes.includes(m);
        if (!s.el.hidden) s.num.textContent = String(++n);
        if (s.adv) s.adv.hidden = !s.section.controls.some((c) => c.advanced && applies(c));
      }
      for (const c of controls) rows.get(c.key)!.hidden = !applies(c);
      refreshSummaries();
    },
  };
}
