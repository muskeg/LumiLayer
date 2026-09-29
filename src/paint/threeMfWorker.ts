/// <reference lib="webworker" />
import { buildPainting3mf, type PaintExportInput } from './export';

export type WorkerResponse =
  | { ok: true; bytes: ArrayBuffer; triangles: number; parts: number }
  | { ok: false; error: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (e: MessageEvent<PaintExportInput>) => {
  try {
    const { bytes, triangles, parts } = buildPainting3mf(e.data);
    // Transfer an exact-size buffer so the main thread receives the file without a copy.
    const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
    const msg: WorkerResponse = { ok: true, bytes: buffer as ArrayBuffer, triangles, parts };
    scope.postMessage(msg, [msg.bytes]);
  } catch (err) {
    const msg: WorkerResponse = { ok: false, error: err instanceof Error ? err.message : String(err) };
    scope.postMessage(msg);
  }
};
