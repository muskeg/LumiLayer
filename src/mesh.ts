import type { LithoResult } from './lithophane';

export interface Mesh {
  positions: Float32Array;
  indices: Uint32Array;
}

export class MeshBuilder {
  private pos = new Float32Array(3 * 4096);
  private idx = new Uint32Array(3 * 8192);
  private nv = 0;
  private ni = 0;

  addVertex(x: number, y: number, z: number): number {
    if ((this.nv + 1) * 3 > this.pos.length) {
      const next = new Float32Array(this.pos.length * 2);
      next.set(this.pos);
      this.pos = next;
    }
    this.pos[this.nv * 3] = x;
    this.pos[this.nv * 3 + 1] = y;
    this.pos[this.nv * 3 + 2] = z;
    return this.nv++;
  }

  addTri(a: number, b: number, c: number) {
    if (this.ni + 3 > this.idx.length) {
      const next = new Uint32Array(this.idx.length * 2);
      next.set(this.idx);
      this.idx = next;
    }
    this.idx[this.ni++] = a;
    this.idx[this.ni++] = b;
    this.idx[this.ni++] = c;
  }

  /** Quad a-b-c-d, counter-clockwise when seen from outside. */
  addQuad(a: number, b: number, c: number, d: number) {
    this.addTri(a, b, c);
    this.addTri(a, c, d);
  }

  get triangleCount() {
    return this.ni / 3;
  }

  finish(): Mesh {
    return { positions: this.pos.slice(0, this.nv * 3), indices: this.idx.slice(0, this.ni) };
  }
}

/*
 * Grid space: I = pixel column (left→right), J = pixel row (top→bottom),
 * K = depth away from the viewing face. World space rotates this 180° about Z
 * so the image reads correctly when looking at the z=0 (bed) face.
 */

/** Material of each voxel in the color slab: 0 = base filler, 1..3 = color filament. */
export function slabMaterials(r: LithoResult): Uint8Array {
  const n = r.colorLayers;
  const total = r.cols * r.rows;
  const mat = new Uint8Array(total * n);
  for (let p = 0; p < total; p++) {
    let k = 0;
    for (let f = 0; f < 3; f++) {
      const c = r.counts[p * 3 + f];
      for (let q = 0; q < c && k < n; q++) mat[p * n + k++] = f + 1;
    }
  }
  return mat;
}

interface BodyOptions {
  zBottom: number;
  zTop: number;
  step: number;
  bottomVertex?: (I: number, J: number) => number;
  emitBottom?: (i: number, j: number) => boolean;
}

function gridSteps(size: number, step: number): number[] {
  const out: number[] = [];
  for (let v = 0; v < size; v += step) out.push(v);
  out.push(size);
  return out;
}

/** Closed heightfield solid: flat bottom at zBottom, top at zTop + body thickness. */
export function addBody(b: MeshBuilder, r: LithoResult, o: BodyOptions) {
  const { cols, rows, pixelMm: px } = r;
  const Is = gridSteps(cols, o.step);
  const Js = gridSteps(rows, o.step);
  const nI = Is.length;
  const nJ = Js.length;
  const corner = (I: number, J: number) => {
    let sum = 0;
    let n = 0;
    for (let j = J - 1; j <= J; j++)
      for (let i = I - 1; i <= I; i++)
        if (i >= 0 && j >= 0 && i < cols && j < rows) {
          sum += r.body[j * cols + i];
          n++;
        }
    return sum / n;
  };
  const top = new Uint32Array(nI * nJ);
  const bot = new Uint32Array(nI * nJ);
  for (let jj = 0; jj < nJ; jj++)
    for (let ii = 0; ii < nI; ii++) {
      const I = Is[ii], J = Js[jj];
      const x = (cols - I) * px, y = (rows - J) * px;
      top[jj * nI + ii] = b.addVertex(x, y, o.zTop + corner(I, J));
      bot[jj * nI + ii] = o.bottomVertex ? o.bottomVertex(I, J) : b.addVertex(x, y, o.zBottom);
    }
  const t = (ii: number, jj: number) => top[jj * nI + ii];
  const d = (ii: number, jj: number) => bot[jj * nI + ii];
  for (let jj = 0; jj < nJ - 1; jj++)
    for (let ii = 0; ii < nI - 1; ii++) {
      b.addQuad(t(ii, jj), t(ii + 1, jj), t(ii + 1, jj + 1), t(ii, jj + 1));
      if (!o.emitBottom || o.emitBottom(Is[ii], Js[jj]))
        b.addQuad(d(ii, jj), d(ii, jj + 1), d(ii + 1, jj + 1), d(ii + 1, jj));
    }
  const lj = nJ - 1, li = nI - 1;
  for (let ii = 0; ii < nI - 1; ii++) {
    b.addQuad(d(ii, 0), d(ii + 1, 0), t(ii + 1, 0), t(ii, 0));
    b.addQuad(d(ii, lj), t(ii, lj), t(ii + 1, lj), d(ii + 1, lj));
  }
  for (let jj = 0; jj < nJ - 1; jj++) {
    b.addQuad(d(0, jj), t(0, jj), t(0, jj + 1), d(0, jj + 1));
    b.addQuad(d(li, jj), d(li, jj + 1), t(li, jj + 1), t(li, jj));
  }
}

const AXES: [number, number, number][][] = [
  [[0, 1, 0], [0, 0, 1]],
  [[0, 0, 1], [1, 0, 0]],
  [[1, 0, 0], [0, 1, 0]],
];

/**
 * Build one watertight mesh per filament. Colors are voxel stacks in the
 * front slab; the base mesh merges slab filler with the heightfield body.
 */
export function buildPrintMeshes(r: LithoResult): (Mesh | null)[] {
  const { cols: W, rows: H, colorLayers: N, pixelMm: px, layerHeight: lh } = r;
  const mat = slabMaterials(r);
  const at = (i: number, j: number, k: number) => mat[(j * W + i) * N + k];
  const vmap = new Int32Array(N > 0 ? (W + 1) * (H + 1) * (N + 1) : 0);
  const out: (Mesh | null)[] = [];

  for (let m = 0; m < 4; m++) {
    if (m > 0 && (N === 0 || !r.filaments[m]?.enabled)) {
      out.push(null);
      continue;
    }
    const b = new MeshBuilder();
    vmap.fill(-1);
    const vid = (I: number, J: number, K: number) => {
      const key = (K * (H + 1) + J) * (W + 1) + I;
      let v = vmap[key];
      if (v < 0) {
        v = b.addVertex((W - I) * px, (H - J) * px, K * lh);
        vmap[key] = v;
      }
      return v;
    };
    const face = (axis: number, sign: number, i: number, j: number, k: number) => {
      const [u, v] = AXES[axis];
      const a = vid(i, j, k);
      const bb = vid(i + u[0], j + u[1], k + u[2]);
      const c = vid(i + u[0] + v[0], j + u[1] + v[1], k + u[2] + v[2]);
      const d = vid(i + v[0], j + v[1], k + v[2]);
      if (sign > 0) b.addQuad(a, bb, c, d);
      else b.addQuad(a, d, c, bb);
    };
    // The base body sits directly on the slab, so filler tops are interior.
    const topIsInterior = m === 0;
    for (let j = 0; j < H; j++)
      for (let i = 0; i < W; i++)
        for (let k = 0; k < N; k++) {
          if (at(i, j, k) !== m) continue;
          if (i === 0 || at(i - 1, j, k) !== m) face(0, -1, i, j, k);
          if (i === W - 1 || at(i + 1, j, k) !== m) face(0, 1, i + 1, j, k);
          if (j === 0 || at(i, j - 1, k) !== m) face(1, -1, i, j, k);
          if (j === H - 1 || at(i, j + 1, k) !== m) face(1, 1, i, j + 1, k);
          if (k === 0 || at(i, j, k - 1) !== m) face(2, -1, i, j, k);
          if (k === N - 1 ? !topIsInterior : at(i, j, k + 1) !== m) face(2, 1, i, j, k + 1);
        }
    if (m === 0) {
      const slab = N * lh;
      addBody(b, r, {
        zBottom: slab,
        zTop: slab,
        step: 1,
        bottomVertex: N > 0 ? (I, J) => vid(I, J, N) : undefined,
        emitBottom: N > 0 ? (i, j) => at(i, j, N - 1) !== 0 : undefined,
      });
    }
    out.push(b.triangleCount > 0 ? b.finish() : null);
  }
  return out;
}
