/** Keeps `--p` (fill percentage) on every range input so CSS can draw the filled part of the track. */
export function watchRangeFills(root: HTMLElement) {
  let queued = false;
  const refresh = () => {
    queued = false;
    for (const r of root.querySelectorAll<HTMLInputElement>('input[type=range]')) {
      const min = Number(r.min || 0), max = Number(r.max || 100);
      const p = max > min ? ((Number(r.value) - min) / (max - min)) * 100 : 0;
      r.style.setProperty('--p', `${p}%`);
    }
  };
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(refresh);
  };
  // Values also change from code (sync, band re-render), so refresh on DOM changes and on demand.
  root.addEventListener('input', schedule, true);
  new MutationObserver(schedule).observe(root, { childList: true, subtree: true });
  schedule();
  return schedule;
}
