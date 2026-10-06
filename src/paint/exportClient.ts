import type { BuildResponse, ExportRequest, WorkerRequest, WorkerResponse } from './threeMfWorker';

/** Above this many triangles the user confirms before the 3MF is written. */
export const HEAVY_TRIANGLES = 3_000_000;

export type ExportedFile = { bytes: ArrayBuffer; triangles: number; parts: number };

/** Asks whether to write a heavy model; `tips` are ways to lighten it. */
export type HeavyExportPrompt = (triangles: number, tips: string[]) => Promise<boolean>;

let heavyPrompt: HeavyExportPrompt = async (triangles, tips) =>
  confirm(`This model has ${(triangles / 1e6).toFixed(1)} M triangles. Slicers may take very long or appear stuck.\n\nTo lighten it: ${tips.join(', ')}.\n\nExport anyway?`);

/** The app replaces the plain confirm() with its own dialog. */
export const setHeavyExportPrompt = (p: HeavyExportPrompt) => {
  heavyPrompt = p;
};

/**
 * Build the parts in the worker; if the model is heavy, ask before writing it (`lighten` lists what the
 * user can change). Resolves to null when the user cancels.
 */
export async function runExport(
  worker: Worker,
  request: ExportRequest,
  transfer: Transferable[],
  lighten: string[],
  onStatus: (s: string) => void,
  confirmAbove = HEAVY_TRIANGLES,
): Promise<ExportedFile | null> {
  const send = <T>(msg: WorkerRequest, t: Transferable[] = []) =>
    new Promise<T>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<T>) => resolve(e.data);
      worker.onerror = (e) => reject(new Error(e.message || 'Export worker failed'));
      worker.postMessage(msg, t);
    });
  const built = await send<BuildResponse>({ ...request, confirmAbove }, transfer);
  let res: WorkerResponse;
  if ('confirm' in built) {
    if (!(await heavyPrompt(built.triangles, lighten))) {
      worker.postMessage({ kind: 'write', confirmed: false } satisfies WorkerRequest);
      return null;
    }
    onStatus(`Writing 3MF (${(built.triangles / 1e6).toFixed(1)} M triangles)…`);
    res = await send<WorkerResponse>({ kind: 'write', confirmed: true });
  } else res = built;
  if (!res.ok) throw new Error(res.error);
  return res;
}
