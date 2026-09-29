/// <reference lib="webworker" />
import { buildMosaic3mf, buildPainting3mf, type MosaicExportInput, type PaintExportInput } from './export';

export type WorkerRequest = PaintExportInput | MosaicExportInput;

export type WorkerResponse =
  | { ok: true; bytes: ArrayBuffer; triangles: number; parts: number }
  | { ok: false; error: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (e: MessageEvent<WorkerRequest>) => {
  try {
    const d = e.data;
    const { bytes, triangles, parts } = 'kind' in d && d.kind === 'mosaic' ? buildMosaic3mf(d) : buildPainting3mf(d as PaintExportInput);
    // Transfer an exact-size buffer so the main thread receives the file without a copy.
    const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
    const msg: WorkerResponse = { ok: true, bytes: buffer as ArrayBuffer, triangles, parts };
    scope.postMessage(msg, [msg.bytes]);
  } catch (err) {
    const msg: WorkerResponse = { ok: false, error: err instanceof Error ? err.message : String(err) };
    scope.postMessage(msg);
  }
};
