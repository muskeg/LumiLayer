# 03 — Data Flow

How a photo becomes a 3MF, buffer by buffer. The same overall pipeline is shared across all
three modes; only the "solve" stage and the "mesh" stage differ.

```
File / URL
   │  loadImage()                     → Source { data: Float32Array RGBA (sRGB), cols, rows }
   ▼
renderFramed(source, cols, rows, settings)     // per-pixel crop/rotate/zoom/pan into a framed grid
   │
   ▼
adjust(img.data, settings)                         // brightness / contrast / gamma / saturation
   │                                             // → srgb: Float32Array RGBA, values 0..1 (still sRGB-gamma)
   ▼
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ mode dispatch  (main.ts :: compute)                                                      │
│                                                                                          │
│  LITHO        buildSolver(lp)  → solve(srgb, …)  → LithoResult {sim, front, per-pixel …} │
│               (main thread, cached solver)                                               │
│                                                                                          │
│  PAINT        PaintController.setImage(srgb, …)  → GPU preview                           │
│  MOSAIC       MosaicController.setImage(srgb, …) → combo solve + renderMosaic (CPU, 2D)  │
└──────────────────────────────────────────────────────────────────────────────────────────┘
   │
   ▼
Preview (2D canvas drawImage / WebGL2 / 3D three.js)  — for the user to judge
   │
   ▼
Export  (all in paint/threeMfWorker.ts)
   LITHO        {kind:'litho', result minus sim/front}  → buildLithoParts
                  → > 3 M triangles? {confirm} → main asks → {kind:'litho-write'} → write3mfSync
   PAINT        heights() [read back from GPU] → postMessage(input, [heights.buffer]) → buildPainting3mf
   MOSAIC       mosaicVoxels(result)           → postMessage(input, [voxels.buffer])  → buildMosaic3mf
   │                                             → 3MF bytes transferred back
   ▼
triggerDownload(blob, exportFileName(...))
```

## 1. The shared input contract

Everything downstream consumes a single normalized type:

- `Source` / the `srgb` array is a **row-major `Float32Array` of RGBA**, values in `0..1`,
  **sRGB-gamma encoded** (linear is applied only inside the optics, not stored).
- The framed grid is described by `{ cols, rows, border, pixelMm }`. `border` is the number of
  *pixels* of empty margin around the image; `gridSize = cols + 2·border` is what the meshers
  and solvers index over. This "grid-with-border" convention is used consistently and is the
  load-bearing piece of the geometry: the frame and the body are both expressed in grid
  coordinates.
- `pixelMm` is derived in `compute` by capping the total pixel count at `MAX_PIXELS = 1.5M`:
  `px = max(settings.pixelMm, sqrt(fullArea / MAX_PIXELS))`. This is the single most important
  DoS guard in the app — it bounds the size of every downstream array regardless of the source
  image.

## 2. The "preview == export" invariant

This is the central architectural guarantee and it is implemented differently per mode:

- **Painting** — the export heights are **read back from the GPU shader** that the user is
  looking at. `PaintController.heights()` calls `preview.readLayers()`, which runs the same
  fragment shader in "count layers" mode and `gl.readPixels` returns a `Uint8Array` of layer
  counts; those are scaled by `layerHeight` into the `Float32Array` heights. There is a CPU
  fallback (using `optics.ts`) for when WebGL is unavailable. Because the *same shader* produces
  both the picture and the numbers, what you see is exactly what prints. This is the strongest
  form of the invariant and the reason the GPU shader is treated as the source of truth.
- **Mosaic** — the solve (combo per tile) is done on the CPU (`solveMosaic`), and both preview
  and export consume that same CPU result, so they cannot diverge.
- **Litho** — the solver (`solve`) is the single producer of the `LithoResult`; both the 2D
  preview and `buildPrintMeshes` read from it. Again single-source.

> The one place the invariant is *weaker* is the painting CPU fallback in `heights()`: it
> re-implements the shader's recurrence in `optics.ts`. Since revision 2 the two share their
> constants (interpolated into the GLSL) and a differential test asserts they pick the same
> layer; near-ties are resolved to the lower height on both sides (`MATCH_TIE`).

## 3. Buffer ownership and lifetimes (per mode)

| Buffer | Type | Owner | Lifetime | Notes |
| --- | --- | --- | --- | --- |
| `Source.data` | `Float32Array` RGBA | `main.ts` | until next image | the decoded input |
| framed + `srgb` | `Float32Array` RGBA | `main.ts` (local to `compute`) | one `compute` cycle | recreated every recompute |
| **Litho** solver LUTs | `Float32Array` | `buildSolver` result | until solver key changes | cached on `solver`/`solverKey` |
| **Litho** `result` | `LithoResult` (many typed arrays) | `main.ts` | until next recompute | per-pixel body thickness + combo |
| **Litho** export input | `LithoGeometry` (= `LithoResult` minus `sim`/`front`) | worker | per export | **copied** (structured clone), since the preview keeps using `result` |
| **Litho** parts | `Part[]` | worker | until written or cancelled | held between the `confirm` reply and `litho-write` |
| **Paint** `px` | `Float32Array` RGBA | `PaintController` | per image | uploaded to GPU |
| **Paint** GPU image | WebGL `RGBA32F` texture | `preview.ts` (GPU) | per image | `gl.texImage2D` with the same `Float32Array` |
| **Paint** layer counts | `Uint8Array` (RGBA8) | `readLayers()` | per read | `gl.readPixels`, bottom-row first, flipped |
| **Paint** `heights` | `Float32Array` | `heights()` | per export | **`.buffer` transferred** to worker |
| **Paint/Mosaic** 3MF | `Uint8Array` | worker | until download | built by fflate in worker |
| **Mosaic** combo set | `KdTree` + `ComboSet` | `MosaicController` | until combo inputs change | deduped Oklab points |
| **Mosaic** voxels | `Uint8Array` (slot per voxel, 255 = empty) | `mosaicVoxels()` | per export | **`.buffer` transferred** to worker |

**Transfer semantics:** painting transfers `heights.buffer` and mosaic transfers
`voxels.buffer` (zero copy; the arrays are detached on the main thread). Litho *copies* its
geometry, because `result` is still on screen. The worker returns the finished 3MF as an
exact-size transferred `ArrayBuffer`. The worker zips with `zipSync`; fflate's async `zip`
would spawn `blob:` workers, which the CSP's `worker-src 'self'` forbids.

## 4. Where the heavy work happens (thread map)

| Stage | Thread | Why |
| --- | --- | --- |
| Decode / frame / adjust | main | once per image; bounded by `MAX_PIXELS` |
| Litho solve | main | per recompute; CPU, cached solver |
| Paint preview (per pixel) | **GPU** | the shader *is* the height matcher |
| Mosaic solve (combo search) + preview | main | CPU; k-d tree NN, bounded by dedupe grid; `renderMosaic` → 2D canvas |
| 2D preview draw | main | `drawImage` |
| 3D preview | main | three.js (lazily imported) |
| **Mesh + 3MF, all modes** | **worker** | keeps the UI live during the heaviest step |

The litho export used to be the exception (meshes built on the main thread, and the
3M-triangle `confirm` only shown *after* the expensive build). Revision 2 moved it to the
worker with a two-step build → confirm → write protocol.

## 5. Memory layout of the geometry

`meshVoxels` (in `mesh.ts`) is the shared greedy-rectangle manifold mesher: it takes a
voxel/band occupancy and produces one watertight, non-self-intersecting solid per material by
greedily merging coplanar voxels into rectangles and pairing exposed faces, with explicit
handling of T-junctions and pinches. Both litho (`buildPrintMeshes`) and mosaic
(`buildVoxelMeshes`) and painting (`buildLayerBandMeshes`) route through this, which is why the
"manifold / watertight" guarantee has a single implementation and a single test
(`core.test.ts` asserts every exported part has a closed edge set — every edge appears exactly
twice — and a positive signed volume).

Position/normals are `Float32Array`, indices are `Uint32Array` (safe beyond 65k vertices), and
the 3MF writer streams in ~1 MB chunks to avoid building one giant string.
