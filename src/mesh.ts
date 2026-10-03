import type { LithoGeometry } from './lithophane';

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

  finish(flip = false): Mesh {
    const indices = this.idx.slice(0, this.ni);
    if (flip)
      for (let i = 0; i < indices.length; i += 3) {
        const t = indices[i + 1];
        indices[i + 1] = indices[i + 2];
        indices[i + 2] = t;
      }
    return { positions: this.pos.slice(0, this.nv * 3), indices };
  }
}

/*
 * Grid space: I = pixel column (left→right), J = pixel row (top→bottom),
 * K = depth away from the viewing face. World space rotates this 180° about Z
 * so the image reads correctly when looking at the z=0 (bed) face.
 */

/** Litho color slab: material of each voxel (0 = base filler, 1..3 = color filament), N layers per column. */
export function slabMaterials(r: LithoGeometry): Uint8Array {
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

/** Minimal heightfield description shared by the lithophane body and the previews. */
export interface Heightfield {
  cols: number;
  rows: number;
  pixelMm: number;
  /** Height (mm) per pixel, row-major. */
  body: Float32Array;
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
export function addBody(b: MeshBuilder, r: Heightfield, o: BodyOptions) {
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

/** A voxel grid in lattice space plus its mapping to world coordinates. */
export interface VoxelGrid {
  W: number;
  H: number;
  K: number;
  /** Material of cell (i, j, k), or -1 for empty. Must also answer for cells just outside the grid. */
  at(i: number, j: number, k: number): number;
  X(I: number): number;
  Y(J: number): number;
  Z(K: number): number;
}

/**
 * Append the closed surface of every cell of material `m` to `b`, and return the lattice-vertex lookup.
 *
 * Coplanar faces are greedily merged into rectangles. Any rectangle corner lying on another rectangle's
 * edge is inserted into that edge (no T-junctions), and edges where two same-material cells touch only
 * diagonally get one midpoint vertex per cell, so every edge has exactly two faces.
 */
export function meshVoxels(
  g: VoxelGrid,
  m: number,
  b: MeshBuilder,
  extraMarks?: (mark: (I: number, J: number, K: number) => void) => void,
): (I: number, J: number, K: number) => number {
  const { W, H, at, X, Y, Z } = g;
  const dims = [W, H, g.K];
  const latticeSize = (W + 1) * (H + 1) * (g.K + 1);
  const vmap = new Int32Array(latticeSize).fill(-1);
  const marks = new Uint8Array(latticeSize);
  const key = (I: number, J: number, K: number) => (K * (H + 1) + J) * (W + 1) + I;
  const c = [0, 0, 0];
  const lattice = (ax: number, p: number, u: number, v: number) => {
    c[ax] = p;
    c[PLANE_AXES[ax][0]] = u;
    c[PLANE_AXES[ax][1]] = v;
    return c;
  };
  const vid = (I: number, J: number, K: number) => {
    const kk = key(I, J, K);
    let v = vmap[kk];
    if (v < 0) {
      v = b.addVertex(X(I), Y(J), Z(K));
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
  extraMarks?.((I, J, K) => (marks[key(I, J, K)] = 1));

  // Pinch edges: two diagonal cells of this material touch only along a unit edge.
  const pinch = new Set<number>();
  const mids = new Map<number, number>();
  const P = [0, 0, 0];
  for (let ax = 0; ax < 3; ax++) {
    const [pa, pb] = PLANE_AXES[ax];
    for (P[ax] = 0; P[ax] < dims[ax]; P[ax]++)
      for (P[pa] = 1; P[pa] < dims[pa]; P[pa]++)
        for (P[pb] = 1; P[pb] < dims[pb]; P[pb]++) {
          const q = (da: number, db: number) => {
            c[ax] = P[ax];
            c[pa] = P[pa] - 1 + da;
            c[pb] = P[pb] - 1 + db;
            return at(c[0], c[1], c[2]) === m;
          };
          const s00 = q(0, 0), s11 = q(1, 1), s01 = q(0, 1), s10 = q(1, 0);
          if ((s00 && s11 && !s01 && !s10) || (s01 && s10 && !s00 && !s11)) {
            const k0 = key(P[0], P[1], P[2]);
            pinch.add(k0 * 3 + ax);
            marks[k0] = 1;
            P[ax]++;
            marks[key(P[0], P[1], P[2])] = 1;
            P[ax]--;
          }
        }
  }
  const oc = [0, 0, 0];
  const midpoint = (edgeAx: number, E: number[]) => {
    const [pa, pb] = PLANE_AXES[edgeAx];
    const quadrant = (oc[pa] < E[pa] ? 0 : 1) + (oc[pb] < E[pb] ? 0 : 2);
    const id = (key(E[0], E[1], E[2]) * 3 + edgeAx) * 4 + quadrant;
    let v = mids.get(id);
    if (v === undefined) {
      v = b.addVertex(X(E[0] + (edgeAx === 0 ? 0.5 : 0)), Y(E[1] + (edgeAx === 1 ? 0.5 : 0)), Z(E[2] + (edgeAx === 2 ? 0.5 : 0)));
      mids.set(id, v);
    }
    return v;
  };

  // Pass 2: emit each rectangle as a polygon that includes all marked points on its edges.
  const poly: number[] = [];
  const E = [0, 0, 0];
  // Visit lattice point (u, v), then the unit step towards (u + du, v + dv) whose face cell is (cu, cv).
  const step = (ax: number, p: number, owner: number, u: number, v: number, du: number, dv: number, cu: number, cv: number) => {
    lattice(ax, p, u, v);
    if (marks[key(c[0], c[1], c[2])]) poly.push(vid(c[0], c[1], c[2]));
    if (pinch.size === 0) return;
    const edgeAx = PLANE_AXES[ax][du !== 0 ? 0 : 1];
    lattice(ax, p, Math.min(u, u + du), Math.min(v, v + dv));
    E[0] = c[0]; E[1] = c[1]; E[2] = c[2];
    if (!pinch.has(key(E[0], E[1], E[2]) * 3 + edgeAx)) return;
    lattice(ax, owner, cu, cv);
    oc[0] = c[0]; oc[1] = c[1]; oc[2] = c[2];
    poly.push(midpoint(edgeAx, E));
  };
  for (let i = 0; i < rects.length; i += 7) {
    const ax = rects[i], sign = rects[i + 1], p = rects[i + 2];
    const u0 = rects[i + 3], v0 = rects[i + 4], u1 = rects[i + 5], v1 = rects[i + 6];
    const owner = sign < 0 ? p : p - 1;
    poly.length = 0;
    for (let u = u0; u < u1; u++) step(ax, p, owner, u, v0, 1, 0, u, v0);
    for (let v = v0; v < v1; v++) step(ax, p, owner, u1, v, 0, 1, u1 - 1, v);
    for (let u = u1; u > u0; u--) step(ax, p, owner, u, v1, -1, 0, u - 1, v1 - 1);
    for (let v = v1; v > v0; v--) step(ax, p, owner, u0, v, 0, -1, u0, v - 1);
    if (sign < 0) poly.reverse();
    if (poly.length === 4) {
      b.addQuad(poly[0], poly[1], poly[2], poly[3]);
    } else {
      lattice(ax, p, (u0 + u1) / 2, (v0 + v1) / 2);
      const center = b.addVertex(X(c[0]), Y(c[1]), Z(c[2]));
      for (let k = 0; k < poly.length; k++) b.addTri(center, poly[k], poly[(k + 1) % poly.length]);
    }
  }
  return vid;
}

/** Lithophane: one watertight mesh per filament (slab voxels; the base merges slab filler with the body). */
export function buildPrintMeshes(r: LithoGeometry, tolerance = 0.02): (Mesh | null)[] {
  const { cols: W, rows: H, colorLayers: N, pixelMm: px, layerHeight: lh } = r;
  const mat = slabMaterials(r);
  const grid: VoxelGrid = {
    W, H, K: N,
    // Above the slab (k >= N) is the base body; outside the grid is empty.
    at: (i, j, k) => (i < 0 || j < 0 || k < 0 || i >= W || j >= H ? -1 : k >= N ? 0 : mat[(j * W + i) * N + k]),
    // Viewed from the bed side: rotated 180° about Z, so winding is preserved.
    X: (I) => (W - I) * px,
    Y: (J) => (H - J) * px,
    Z: (K) => K * lh,
  };
  const out: (Mesh | null)[] = [];
  for (let m = 0; m < 4; m++) {
    if (m > 0 && (N === 0 || !r.filaments[m]?.enabled)) {
      out.push(null);
      continue;
    }
    const b = new MeshBuilder();
    const vid = meshVoxels(grid, m, b, (mark) => {
      if (m !== 0) return;
      // Body side walls end on every perimeter lattice point at the top of the slab.
      for (let I = 0; I <= W; I++) { mark(I, 0, N); mark(I, H, N); }
      for (let J = 0; J <= H; J++) { mark(0, J, N); mark(W, J, N); }
    });
    if (m === 0) addBody(b, r, { zBottom: N * lh, zTop: N * lh, step: 1, tolerance, bottomVertex: (I, J) => vid(I, J, N) });
    out.push(b.triangleCount > 0 ? b.finish() : null);
  }
  return out;
}

export interface VoxelMaterialInput {
  cols: number;
  rows: number;
  /** Layers per tile in `voxels`. */
  K: number;
  pixelMm: number;
  pixelMmY?: number;
  layerHeight: number;
  /** Material per voxel at ((row * cols + col) * K + k), 255 = empty. */
  voxels: Uint8Array;
  materialCount: number;
}

/** Filament mosaic: one watertight mesh per material, viewed from the top like buildLayerBandMeshes. */
export function buildVoxelMeshes(input: VoxelMaterialInput): (Mesh | null)[] {
  const { cols: W, rows: H, K, pixelMm: px, layerHeight: lh, voxels } = input;
  const py = input.pixelMmY ?? px;
  const grid: VoxelGrid = {
    W, H, K,
    at: (i, j, k) => {
      if (i < 0 || j < 0 || k < 0 || i >= W || j >= H || k >= K) return -1;
      const m = voxels[(j * W + i) * K + k];
      return m === 255 ? -1 : m;
    },
    X: (I) => I * px,
    Y: (J) => (H - J) * py,
    Z: (k) => k * lh,
  };
  const out: (Mesh | null)[] = [];
  for (let m = 0; m < input.materialCount; m++) {
    const b = new MeshBuilder();
    meshVoxels(grid, m, b);
    out.push(b.triangleCount > 0 ? b.finish(true) : null);
  }
  return out;
}

export interface LayerBandInput {
  cols: number;
  rows: number;
  pixelMm: number;
  /** Row pitch if different from pixelMm. */
  pixelMmY?: number;
  layerHeight: number;
  /** Printed height of each pixel, in whole layers. */
  layers: Uint16Array;
  /** Material id for each layer index (bottom = 0). */
  materialOfLayer: Int32Array;
  materialCount: number;
}

/**
 * Front-lit painting: heightfield columns cut into one watertight mesh per material, where each layer
 * belongs to exactly one material. Viewed from the top, so the grid is mirrored (winding flipped).
 */
export function buildLayerBandMeshes(input: LayerBandInput): (Mesh | null)[] {
  const { cols: W, rows: H, pixelMm: px, layerHeight: lh, layers, materialOfLayer } = input;
  const py = input.pixelMmY ?? px;
  let K = 0;
  for (let p = 0; p < layers.length; p++) K = Math.max(K, layers[p]);
  const grid: VoxelGrid = {
    W, H, K,
    at: (i, j, k) => (i < 0 || j < 0 || k < 0 || i >= W || j >= H || k >= layers[j * W + i] ? -1 : materialOfLayer[Math.min(k, materialOfLayer.length - 1)]),
    X: (I) => I * px,
    Y: (J) => (H - J) * py,
    Z: (k) => k * lh,
  };
  const out: (Mesh | null)[] = [];
  for (let m = 0; m < input.materialCount; m++) {
    const b = new MeshBuilder();
    meshVoxels(grid, m, b);
    out.push(b.triangleCount > 0 ? b.finish(true) : null);
  }
  return out;
}
