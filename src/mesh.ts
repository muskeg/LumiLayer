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
  /** Regular grid sampling step (preview). Ignored when `tolerance` is set. */
  step: number;
  /** Max height error (mm) for adaptive simplification of the top surface. */
  tolerance?: number;
  bottomVertex?: (I: number, J: number) => number;
}

function gridSteps(size: number, step: number): number[] {
  const out: number[] = [];
  for (let v = 0; v < size; v += step) out.push(v);
  out.push(size);
  return out;
}

/** Heightfield top (zTop + body thickness) and side walls down to zBottom. The bottom is left open for the caller. */
export function addBody(b: MeshBuilder, r: LithoResult, o: BodyOptions) {
  const { cols, rows, pixelMm: px } = r;
  const W1 = cols + 1;
  const heights = new Float32Array(W1 * (rows + 1));
  for (let J = 0; J <= rows; J++)
    for (let I = 0; I <= cols; I++) {
      let sum = 0;
      let n = 0;
      for (let j = J - 1; j <= J; j++)
        for (let i = I - 1; i <= I; i++)
          if (i >= 0 && j >= 0 && i < cols && j < rows) {
            sum += r.body[j * cols + i];
            n++;
          }
      heights[J * W1 + I] = sum / n;
    }
  const h = (I: number, J: number) => heights[J * W1 + I];
  const topIds = new Int32Array(heights.length).fill(-1);
  const t = (I: number, J: number) => {
    const k = J * W1 + I;
    if (topIds[k] < 0) topIds[k] = b.addVertex((cols - I) * px, (rows - J) * px, o.zTop + heights[k]);
    return topIds[k];
  };
  const botIds = new Int32Array(heights.length).fill(-1);
  const d = (I: number, J: number) => {
    const k = J * W1 + I;
    if (botIds[k] < 0)
      botIds[k] = o.bottomVertex ? o.bottomVertex(I, J) : b.addVertex((cols - I) * px, (rows - J) * px, o.zBottom);
    return botIds[k];
  };

  let Is: number[], Js: number[];
  if (o.tolerance === undefined) {
    Is = gridSteps(cols, o.step);
    Js = gridSteps(rows, o.step);
    for (let jj = 0; jj < Js.length - 1; jj++)
      for (let ii = 0; ii < Is.length - 1; ii++)
        b.addQuad(t(Is[ii], Js[jj]), t(Is[ii + 1], Js[jj]), t(Is[ii + 1], Js[jj + 1]), t(Is[ii], Js[jj + 1]));
  } else {
    Is = gridSteps(cols, 1);
    Js = gridSteps(rows, 1);
    addAdaptiveTop(b, cols, rows, h, t, o.tolerance, o.zTop, px);
  }

  const lj = Js[Js.length - 1], li = Is[Is.length - 1];
  for (let ii = 0; ii < Is.length - 1; ii++) {
    const I0 = Is[ii], I1 = Is[ii + 1];
    b.addQuad(d(I0, 0), d(I1, 0), t(I1, 0), t(I0, 0));
    b.addQuad(d(I0, lj), t(I0, lj), t(I1, lj), d(I1, lj));
  }
  for (let jj = 0; jj < Js.length - 1; jj++) {
    const J0 = Js[jj], J1 = Js[jj + 1];
    b.addQuad(d(0, J0), t(0, J0), t(0, J1), d(0, J1));
    b.addQuad(d(li, J0), d(li, J1), t(li, J1), t(li, J0));
  }
}

/**
 * Quadtree simplification: a rectangle becomes one face when bilinear
 * interpolation of its corners is within `tol` of every corner height inside it.
 * Neighbouring corners on a face's edges are inserted to keep the surface crack-free.
 */
function addAdaptiveTop(
  b: MeshBuilder,
  cols: number,
  rows: number,
  h: (I: number, J: number) => number,
  t: (I: number, J: number) => number,
  tol: number,
  zTop: number,
  px: number,
) {
  const W1 = cols + 1;
  const leaves: number[] = [];
  const flat = (I0: number, J0: number, I1: number, J1: number) => {
    const h00 = h(I0, J0), h10 = h(I1, J0), h01 = h(I0, J1), h11 = h(I1, J1);
    for (let J = J0; J <= J1; J++) {
      const v = (J - J0) / (J1 - J0);
      const a = h00 + (h01 - h00) * v;
      const c = h10 + (h11 - h10) * v;
      for (let I = I0; I <= I1; I++) {
        const u = (I - I0) / (I1 - I0);
        if (Math.abs(h(I, J) - (a + (c - a) * u)) > tol) return false;
      }
    }
    return true;
  };
  const split = (I0: number, J0: number, I1: number, J1: number) => {
    if ((I1 - I0 <= 1 && J1 - J0 <= 1) || flat(I0, J0, I1, J1)) {
      leaves.push(I0, J0, I1, J1);
      return;
    }
    const Im = I1 - I0 > 1 ? (I0 + I1) >> 1 : I1;
    const Jm = J1 - J0 > 1 ? (J0 + J1) >> 1 : J1;
    split(I0, J0, Im, Jm);
    if (Im < I1) split(Im, J0, I1, Jm);
    if (Jm < J1) split(I0, Jm, Im, J1);
    if (Im < I1 && Jm < J1) split(Im, Jm, I1, J1);
  };
  split(0, 0, cols, rows);

  const marks = new Uint8Array(W1 * (rows + 1));
  for (let i = 0; i < leaves.length; i += 4)
    for (const I of [leaves[i], leaves[i + 2]]) for (const J of [leaves[i + 1], leaves[i + 3]]) marks[J * W1 + I] = 1;
  // Side walls use every perimeter point.
  for (let I = 0; I <= cols; I++) marks[I] = marks[rows * W1 + I] = 1;
  for (let J = 0; J <= rows; J++) marks[J * W1] = marks[J * W1 + cols] = 1;

  const poly: number[] = [];
  const visit = (I: number, J: number) => {
    if (marks[J * W1 + I]) poly.push(t(I, J));
  };
  for (let i = 0; i < leaves.length; i += 4) {
    const I0 = leaves[i], J0 = leaves[i + 1], I1 = leaves[i + 2], J1 = leaves[i + 3];
    poly.length = 0;
    for (let I = I0; I < I1; I++) visit(I, J0);
    for (let J = J0; J < J1; J++) visit(I1, J);
    for (let I = I1; I > I0; I--) visit(I, J1);
    for (let J = J1; J > J0; J--) visit(I0, J);
    if (poly.length === 4) {
      b.addQuad(poly[0], poly[1], poly[2], poly[3]);
    } else {
      const zc = (h(I0, J0) + h(I1, J0) + h(I0, J1) + h(I1, J1)) / 4;
      const center = b.addVertex((cols - (I0 + I1) / 2) * px, (rows - (J0 + J1) / 2) * px, zTop + zc);
      for (let k = 0; k < poly.length; k++) b.addTri(center, poly[k], poly[(k + 1) % poly.length]);
    }
  }
}

/** In-plane axes (u, v) per face axis, with u × v pointing along +axis. */
const PLANE_AXES = [
  [1, 2],
  [2, 0],
  [0, 1],
];

/**
 * Build one watertight mesh per filament. Colors are voxel stacks in the
 * front slab; the base mesh merges slab filler with the heightfield body.
 *
 * Coplanar voxel faces are greedily merged into rectangles. Any rectangle
 * corner lying on another rectangle's edge is inserted into that edge, so
 * there are no T-junctions and the meshes stay closed.
 */
export function buildPrintMeshes(r: LithoResult, tolerance = 0.02): (Mesh | null)[] {
  const { cols: W, rows: H, colorLayers: N, pixelMm: px, layerHeight: lh } = r;
  const dims = [W, H, N];
  const mat = slabMaterials(r);
  // Above the slab (k >= N) is the base body; outside the grid is empty (-1).
  const at = (i: number, j: number, k: number) => {
    if (i < 0 || j < 0 || k < 0 || i >= W || j >= H) return -1;
    return k >= N ? 0 : mat[(j * W + i) * N + k];
  };
  const latticeSize = (W + 1) * (H + 1) * (N + 1);
  const vmap = new Int32Array(latticeSize);
  const marks = new Uint8Array(latticeSize);
  const key = (I: number, J: number, K: number) => (K * (H + 1) + J) * (W + 1) + I;
  const out: (Mesh | null)[] = [];
  const c = [0, 0, 0];
  const lattice = (ax: number, p: number, u: number, v: number) => {
    c[ax] = p;
    c[PLANE_AXES[ax][0]] = u;
    c[PLANE_AXES[ax][1]] = v;
    return c;
  };

  for (let m = 0; m < 4; m++) {
    if (m > 0 && (N === 0 || !r.filaments[m]?.enabled)) {
      out.push(null);
      continue;
    }
    const b = new MeshBuilder();
    vmap.fill(-1);
    marks.fill(0);
    const vid = (I: number, J: number, K: number) => {
      const kk = key(I, J, K);
      let v = vmap[kk];
      if (v < 0) {
        v = b.addVertex((W - I) * px, (H - J) * px, K * lh);
        vmap[kk] = v;
      }
      return v;
    };

    // Pass 1: greedy rectangles per plane, stored as [axis, sign, plane, u0, v0, u1, v1].
    const rects: number[] = [];
    for (let ax = 0; ax < 3; ax++) {
      const [ua, va] = PLANE_AXES[ax];
      const du = dims[ua], dv = dims[va];
      const mask = new Uint8Array(du * dv);
      for (let p = 0; p <= dims[ax]; p++) {
        for (const sign of [-1, 1]) {
          // The face belongs to the cell on its inner side and exists where the outer neighbour differs.
          const owner = sign < 0 ? p : p - 1;
          let any = false;
          for (let v = 0; v < dv; v++)
            for (let u = 0; u < du; u++) {
              lattice(ax, owner, u, v);
              let f = 0;
              if (at(c[0], c[1], c[2]) === m) {
                c[ax] += sign;
                if (at(c[0], c[1], c[2]) !== m) f = 1;
              }
              mask[v * du + u] = f;
              any ||= f === 1;
            }
          if (!any) continue;
          for (let v = 0; v < dv; v++)
            for (let u = 0; u < du; u++) {
              if (!mask[v * du + u]) continue;
              let u1 = u + 1;
              while (u1 < du && mask[v * du + u1]) u1++;
              let v1 = v + 1;
              grow: while (v1 < dv) {
                for (let x = u; x < u1; x++) if (!mask[v1 * du + x]) break grow;
                v1++;
              }
              for (let y = v; y < v1; y++) mask.fill(0, y * du + u, y * du + u1);
              rects.push(ax, sign, p, u, v, u1, v1);
            }
        }
      }
    }

    for (let i = 0; i < rects.length; i += 7) {
      const ax = rects[i], p = rects[i + 2];
      for (const u of [rects[i + 3], rects[i + 5]])
        for (const v of [rects[i + 4], rects[i + 6]]) {
          lattice(ax, p, u, v);
          marks[key(c[0], c[1], c[2])] = 1;
        }
    }
    if (m === 0) {
      // Body side walls end on every perimeter lattice point at the top of the slab.
      for (let I = 0; I <= W; I++) marks[key(I, 0, N)] = marks[key(I, H, N)] = 1;
      for (let J = 0; J <= H; J++) marks[key(0, J, N)] = marks[key(W, J, N)] = 1;
    }

    // Pass 2: emit each rectangle as a polygon that includes all marked points on its edges.
    const poly: number[] = [];
    const visit = (ax: number, p: number, u: number, v: number) => {
      lattice(ax, p, u, v);
      if (marks[key(c[0], c[1], c[2])]) poly.push(vid(c[0], c[1], c[2]));
    };
    for (let i = 0; i < rects.length; i += 7) {
      const ax = rects[i], sign = rects[i + 1], p = rects[i + 2];
      const u0 = rects[i + 3], v0 = rects[i + 4], u1 = rects[i + 5], v1 = rects[i + 6];
      poly.length = 0;
      for (let u = u0; u < u1; u++) visit(ax, p, u, v0);
      for (let v = v0; v < v1; v++) visit(ax, p, u1, v);
      for (let u = u1; u > u0; u--) visit(ax, p, u, v1);
      for (let v = v1; v > v0; v--) visit(ax, p, u0, v);
      if (sign < 0) poly.reverse();
      if (poly.length === 4) {
        b.addQuad(poly[0], poly[1], poly[2], poly[3]);
      } else {
        lattice(ax, p, (u0 + u1) / 2, (v0 + v1) / 2);
        const center = b.addVertex((W - c[0]) * px, (H - c[1]) * px, c[2] * lh);
        for (let k = 0; k < poly.length; k++) b.addTri(center, poly[k], poly[(k + 1) % poly.length]);
      }
    }

    if (m === 0) addBody(b, r, { zBottom: N * lh, zTop: N * lh, step: 1, tolerance, bottomVertex: (I, J) => vid(I, J, N) });
    out.push(b.triangleCount > 0 ? b.finish() : null);
  }
  return out;
}
