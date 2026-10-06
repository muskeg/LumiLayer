import type { Filament } from './color';
import { DEFAULT_LITHO_PRESET, LITHO_PRESETS } from './settings';

/** Lithophane filament editor (preset + 4 slots); `onChange` receives the current list after every edit. */
export function buildLithoFilaments(onChange: (filaments: Filament[]) => void): HTMLElement {
  let filaments = structuredClone(LITHO_PRESETS[DEFAULT_LITHO_PRESET]);
  const box = document.createElement('div');
  box.className = 'filaments';
  const presetRow = document.createElement('label');
  presetRow.className = 'row select';
  const presetLabel = document.createElement('span');
  presetLabel.textContent = 'Preset';
  const preset = document.createElement('select');
  preset.add(new Option('Custom', ''));
  for (const name of Object.keys(LITHO_PRESETS)) preset.add(new Option(name, name));
  preset.value = DEFAULT_LITHO_PRESET;
  presetRow.append(presetLabel, preset);
  const list = document.createElement('div');
  box.append(presetRow, list);

  const render = () => {
    list.replaceChildren();
    filaments.forEach((f, i) => {
      const row = document.createElement('div');
      row.className = 'filament';
      const enabled = Object.assign(document.createElement('input'), { type: 'checkbox', checked: f.enabled, disabled: i === 0, title: i === 0 ? 'Base filament is always used' : 'Use this filament' });
      const slot = Object.assign(document.createElement('span'), { className: 'slot', textContent: String(i + 1), title: 'Slot / extruder' });
      const color = Object.assign(document.createElement('input'), { type: 'color', value: f.color, title: 'Filament color' });
      const name = Object.assign(document.createElement('input'), { type: 'text', value: f.name, maxLength: 24, title: 'Filament name' });
      const td = Object.assign(document.createElement('input'), { type: 'number', min: '0.1', max: '20', step: '0.1', value: String(f.td), title: 'Transmission distance (mm): thickness at which ~10% of light passes' });
      const changed = () => {
        preset.value = '';
        onChange(filaments);
      };
      enabled.onchange = () => { f.enabled = i === 0 || enabled.checked; row.classList.toggle('off', !f.enabled); changed(); };
      color.oninput = () => { f.color = color.value; changed(); };
      name.oninput = () => { f.name = name.value || `Filament ${i + 1}`; changed(); };
      td.oninput = () => {
        const v = parseFloat(td.value);
        if (Number.isFinite(v) && v > 0) { f.td = Math.min(20, Math.max(0.1, v)); changed(); }
      };
      row.classList.toggle('off', !f.enabled);
      row.append(enabled, slot, color, name, td);
      list.appendChild(row);
    });
  };
  preset.onchange = () => {
    if (!preset.value) return;
    filaments = structuredClone(LITHO_PRESETS[preset.value]);
    render();
    onChange(filaments);
  };
  const legend = Object.assign(document.createElement('p'), {
    className: 'hint',
    textContent: 'Slot 1 is the base (body). Slots 2-4 are stacked color layers. Last field: TD (transmission distance, mm), the thickness at which ~10% of the light gets through.',
  });
  box.appendChild(legend);
  render();
  return box;
}
