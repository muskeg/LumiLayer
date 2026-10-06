import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import type { PaintExportInput } from './paint/export';
import { runExport } from './paint/exportClient';
import { DEFAULT_PROFILES, resolveStack } from './paint/model';
import type { WorkerRequest } from './paint/threeMfWorker';

// Runs the real worker module in-process: `self` routes its replies to whichever fake Worker is talking.
type Handler = (e: { data: unknown }) => void;
let current: { onmessage: Handler | null } | null = null;
let workerScope: { onmessage: Handler | null };

class FakeWorker {
  onmessage: Handler | null = null;
  onerror: ((e: unknown) => void) | null = null;
  postMessage(msg: unknown) {
    current = this;
    const data = structuredClone(msg);
    queueMicrotask(() => workerScope.onmessage!({ data }));
  }
}

beforeAll(async () => {
  workerScope = {
    onmessage: null,
    postMessage: (m: unknown) => queueMicrotask(() => current?.onmessage?.({ data: m })),
  } as typeof workerScope;
  vi.stubGlobal('self', workerScope);
  await import('./paint/threeMfWorker');
});

afterEach(() => vi.unstubAllGlobals());

const lh = 0.08;
function paintInput(cols = 6, rows = 5): PaintExportInput {
  const stack = resolveStack([{ filamentId: 'black', top: 4 }, { filamentId: 'white', top: 10 }], DEFAULT_PROFILES, lh);
  const heights = Float32Array.from({ length: cols * rows }, (_, i) => (3 + (i % 7)) * lh);
  return { heights, cols, rows, widthMm: cols * 0.5, heightMm: rows * 0.5, baseHeight: 3 * lh, layerHeight: lh, stack, title: 't' };
}

const worker = () => new FakeWorker() as unknown as Worker;

describe('export worker protocol', () => {
  it('writes light models straight away, without asking', async () => {
    const ask = vi.fn(() => true);
    vi.stubGlobal('confirm', ask);
    const file = await runExport(worker(), paintInput(), [], ['tips'], () => {});
    expect(ask).not.toHaveBeenCalled();
    expect(file!.parts).toBe(2);
    const files = unzipSync(new Uint8Array(file!.bytes));
    expect(strFromU8(files['3D/3dmodel.model'])).toContain('<build>');
  });

  it('asks above the threshold, and writes the held parts when accepted', async () => {
    const ask = vi.fn((_message: string) => true);
    vi.stubGlobal('confirm', ask);
    const status = vi.fn();
    const file = await runExport(worker(), paintInput(), [], ['Raise Pixel size'], status, 1);
    expect(ask).toHaveBeenCalledOnce();
    expect(ask.mock.calls[0][0]).toContain('Raise Pixel size');
    expect(status).toHaveBeenCalledWith(expect.stringContaining('Writing 3MF'));
    expect(file!.triangles).toBeGreaterThan(1);
  });

  it('drops the held parts when cancelled', async () => {
    vi.stubGlobal('confirm', () => false);
    const w = worker();
    expect(await runExport(w, paintInput(), [], ['tips'], () => {}, 1)).toBeNull();
    // Nothing is left to write after a cancel.
    const reply = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      w.onmessage = (e) => resolve(e.data);
      w.postMessage({ kind: 'write', confirmed: true } satisfies WorkerRequest);
    });
    expect(reply).toEqual({ ok: false, error: 'No export is waiting to be written.' });
  });

  it('rejects grids beyond the worker-side cap with a readable error', async () => {
    vi.stubGlobal('confirm', () => true);
    const input = { ...paintInput(), cols: 4000, rows: 2000 };
    await expect(runExport(worker(), input, [], ['tips'], () => {})).rejects.toThrow(/too large to export/);
  });
});
