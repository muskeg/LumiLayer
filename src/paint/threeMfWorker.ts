/// <reference lib="webworker" />
import {
  buildLithoParts, buildMosaicParts, buildPaintingParts, countTriangles, packParts,
  type LithoExportInput, type MosaicExportInput, type PaintExportInput, type PaintExportResult, type WriteRequest,
} from './export';
import type { Part } from '../threemf';

export type ExportRequest = PaintExportInput | MosaicExportInput | LithoExportInput;
export type WorkerRequest = ExportRequest | WriteRequest;

export type WorkerResponse =
  | { ok: true; bytes: ArrayBuffer; triangles: number; parts: number }
  | { ok: false; error: string };

/** First reply to an ExportRequest: the file, or a request for confirmation when it exceeds `confirmAbove`. */
export type BuildResponse = WorkerResponse | { ok: true; confirm: true; triangles: number };

const scope = self as unknown as DedicatedWorkerGlobalScope;

let pending: { parts: Part[]; title: string } | null = null;

function reply({ bytes, triangles, parts }: PaintExportResult) {
  // Transfer an exact-size buffer so the main thread receives the file without a copy.
  const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
  const msg: WorkerResponse = { ok: true, bytes: buffer as ArrayBuffer, triangles, parts };
  scope.postMessage(msg, [msg.bytes]);
}

function build(d: ExportRequest): { parts: Part[]; title: string } {
  if (!('kind' in d)) return { parts: buildPaintingParts(d), title: d.title ?? 'LumiLayer painting' };
  if (d.kind === 'mosaic') return { parts: buildMosaicParts(d), title: d.title ?? 'LumiLayer filament mosaic' };
  return { parts: buildLithoParts(d.result, d.tolerance), title: d.title ?? 'LumiLayer lithophane' };
}

scope.onmessage = (e: MessageEvent<WorkerRequest>) => {
  try {
    const d = e.data;
    if ('kind' in d && d.kind === 'write') {
      const p = pending;
      pending = null;
      if (!d.confirmed) return;
      if (!p) throw new Error('No export is waiting to be written.');
      return reply(packParts(p.parts, p.title));
    }
    pending = null;
    const { parts, title } = build(d);
    const triangles = countTriangles(parts);
    if (d.confirmAbove === undefined || triangles <= d.confirmAbove) return reply(packParts(parts, title));
    pending = { parts, title };
    const msg: BuildResponse = { ok: true, confirm: true, triangles };
    scope.postMessage(msg);
  } catch (err) {
    const msg: WorkerResponse = { ok: false, error: err instanceof Error ? err.message : String(err) };
    scope.postMessage(msg);
  }
};
