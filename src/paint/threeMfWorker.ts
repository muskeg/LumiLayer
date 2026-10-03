/// <reference lib="webworker" />
import {
  buildLithoParts, buildMosaic3mf, buildPainting3mf, countTriangles, packParts,
  type LithoExportInput, type LithoWriteRequest, type MosaicExportInput, type PaintExportInput, type PaintExportResult,
} from './export';
import type { Part } from '../threemf';

export type WorkerRequest = PaintExportInput | MosaicExportInput | LithoExportInput | LithoWriteRequest;

export type WorkerResponse =
  | { ok: true; bytes: ArrayBuffer; triangles: number; parts: number }
  | { ok: false; error: string };

/** A litho export answers with this first when it is heavy enough to need the user's confirmation. */
export type LithoWorkerResponse = WorkerResponse | { ok: true; confirm: true; triangles: number };

const scope = self as unknown as DedicatedWorkerGlobalScope;

let pending: { parts: Part[]; title: string } | null = null;

function reply({ bytes, triangles, parts }: PaintExportResult) {
  // Transfer an exact-size buffer so the main thread receives the file without a copy.
  const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
  const msg: WorkerResponse = { ok: true, bytes: buffer as ArrayBuffer, triangles, parts };
  scope.postMessage(msg, [msg.bytes]);
}

scope.onmessage = (e: MessageEvent<WorkerRequest>) => {
  try {
    const d = e.data;
    if ('kind' in d && d.kind === 'litho-write') {
      const p = pending;
      pending = null;
      if (!d.confirmed) return;
      if (!p) throw new Error('No lithophane export is waiting to be written.');
      return reply(packParts(p.parts, p.title));
    }
    pending = null;
    if ('kind' in d && d.kind === 'litho') {
      const parts = buildLithoParts(d.result, d.tolerance);
      const title = d.title ?? 'LumiLayer lithophane';
      const triangles = countTriangles(parts);
      if (triangles <= d.confirmAbove) return reply(packParts(parts, title));
      pending = { parts, title };
      const msg: LithoWorkerResponse = { ok: true, confirm: true, triangles };
      return scope.postMessage(msg);
    }
    reply('kind' in d ? buildMosaic3mf(d) : buildPainting3mf(d));
  } catch (err) {
    const msg: WorkerResponse = { ok: false, error: err instanceof Error ? err.message : String(err) };
    scope.postMessage(msg);
  }
};
