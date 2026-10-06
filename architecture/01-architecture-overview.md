# 01 — Architecture Overview

LumiLayer is a single-page, **local-only** web application. There is no backend, no
network, no accounts, and no telemetry. The entire pipeline — image in, 3MF out — runs in
the browser: solving and previews on the main thread (plus the GPU for the painting preview),
and **all three export paths** in a dedicated Web Worker.

## 1. The product in one sentence

Given a photo, produce a physically print-ready multi-color model — one of three
optically-motivated "print languages" — and emit a 3MF whose geometry and per-part
filament assignment are understood by Bambu Studio / Orca.

The three modes are not three UI skins; they are three genuinely different
*rendering models of how light interacts with stacked translucent plastic*, each with its
own solver and its own mesh builder (all built on the shared `meshVoxels`).

| Mode | Light path | Color source | Height source | Optical model |
| --- | --- | --- | --- | --- |
| **Lithophane** | Backlit | Thin CMY-style slab in front | Body thickness (inverse of brightness) | Beer–Lambert transmission |
| **Filament painting** | Front-lit (plus a Backlit preview view) | Stack of height bands, one filament per band | Either brightness, or "height whose printed color matches" | Kubelka–Munk, one layer at a time (same model as the mosaic, both views; rev. 3) |
| **Filament mosaic** | Front-lit | Per-tile short filament combos | Ground + combo height | Kubelka–Munk two-flux |

## 2. High-level module decomposition

```
                         ┌────────────────────────────────────────────┐
                         │                main.ts                     │
                         │  settings · UI shell · mode dispatch ·      │
                         │  framing · scheduling · export orchestration│
                         └───────┬──────────────┬──────────────┬──────┘
                 image in        │              │              │   UI panels / state
              ┌──────────────────┴───┐   ┌──────┴─────┐  ┌─────┴──────────────┐
              │     imaging.ts       │   │  color.ts  │  │  paint/controller  │
              │ load, frame, adjust  │   │ sRGB↔linear│  │  paint/mosaic*     │
              │ (canvas 2D)          │   │ Oklab, luma│  │  (state + panels)  │
              └──────────┬───────────┘   └──────┬─────┘  └──────────┬─────────┘
                         │ Float32 sRGB         │                   │
        ┌─────────────────┼──────────────────────┼──────────────────┴─────────┐
        │                │                      │                              │
   ┌────┴─────┐     ┌────┴───────────┐     ┌────┴──────────┐            ┌──────┴──────┐
   │ litho-   │     │ paint/optics   │     │ paint/km.ts    │            │ preview3d   │
   │ phane.ts │     │ + paint/preview│     │ Kubelka–Munk   │            │ (three.js)  │
   │ solver   │     │ (WebGL2 shader)│     │                │            │ 3D viewport │
   └────┬─────┘     └────┬───────────┘     └────┬──────────┘            └──────┬──────┘
        │ LithoResult     │ heights[]            │ ComboSet / MosaicResult       │
   ┌────┴─────────────────┴──────────────────────┴─────────────────────────────┴───┐
   │                            mesh.ts  (shared geometry)                          │
   │  MeshBuilder · slabMaterials · addBody · meshVoxels · buildPrintMeshes        │
   │  buildLayerBandMeshes · buildVoxelMeshes                                      │
   └───────────────────────────────┬─────────────────────────────────────────────────┘
                                   │ (Mesh | null)[]
                          ┌────────┴────────┐
                          │    threemf.ts   │   XmlWriter + fflate zip
                          │ buildModelXml / │
                          │ write3mf(Sync)  │
                          └────────┬────────┘
                                   │
                          ┌────────┴────────┐
                          │   download.ts   │   Blob → object URL → anchor click
                          └─────────────────┘
```

### What each layer owns

- **`imaging.ts`** — the only place that touches the input image. Decodes (with a
  `maxDim` downscale), applies framing (zoom/pan/rotate/flip) via a 2D canvas with
  `willReadFrequently`, and does tone adjustment (brightness/contrast/gamma/saturation).
  Outputs sRGB floats 0..1.
- **`color.ts`** — pure color math: sRGB↔linear, CIE L*, Oklab, Rec.709 luminance, the
  shared `TD_FLOOR`, and the Beer–Lambert absorption coefficient for a filament — the
  definition of "what a filament's color means optically" for the **lithophane** (presets only;
  profile filaments use the KM model in `paint/km.ts`).
- **`lithophane.ts`** — the backlit solver. Enumerates color-layer combos, precomputes a
  32³ lookup table mapping (quantized target RGB) → best combo, and produces per-pixel
  color-layer counts + body thickness + two preview rasters (backlit sim and front face).
- **`paint/optics.ts`** — the front-lit *band* model used by filament painting (Beer–Lambert
  layer-hiding), and the CPU mirror of the GPU height-matching shader.
- **`paint/preview.ts`** — the WebGL2 fragment shader that renders the painting preview at
  display-refresh rate and, in a second pass, writes per-pixel layer counts back for export.
  Its `MATCH_TIE` constant is interpolated from the TS modules, and it receives each band's
  one-layer KM reflectance/transmittance (`u_layerR`, `u_layerT`) from the same `oneLayer` the
  CPU uses.
- **`paint/km.ts`** — the Kubelka–Munk two-flux model for the mosaic; numerically stable
  layer reflectance/transmittance tables plus a `TD → scattering` solver (bisection).
- **`paint/mosaic.ts`** — combo enumeration + dedupe, a hand-rolled k-d tree, the per-tile
  solver (with Floyd–Steinberg dithering and island merging), and voxelization.
- **`paint/suggest.ts` / `paint/loadout.ts`** — offline optimizers that pick the best
  filament *sequence* (painting) or *set* (mosaic) for the image, using the same optics as
  the preview so the recommendation is faithful.
- **`paint/swatches.ts`** — the swatch plate: a mosaic with known combos so the user can
  tune color/TD against a real print.
- **`mesh.ts`** — all geometry. A single `meshVoxels` routine (greedy coplanar rectangle
  merging with T-junction-free edge marking and diagonal-pinch handling) is shared by all
  three modes; `addBody` builds the lithophane body (with optional quadtree simplification).
- **`threemf.ts`** — serializes parts to the 3MF/3dmodel XML (streamed via `XmlWriter` to
  avoid giant intermediate strings) plus the Bambu/Orca `model_settings.config`, and zips it
  synchronously (`write3mfSync`, called only inside the export worker).
- **`paint/export.ts` + `paint/threeMfWorker.ts`** — part builders for all three modes
  (`buildLithoParts`, `buildPaintingParts`, `buildMosaicParts`) and the worker that runs them.
- **`preview3d.ts`** — an isolated three.js scene (lazy-loaded) that visualizes the result;
  deliberately decoupled from the export path.

## 3. The three "print languages" in detail

### 3.1 Lithophane (backlit)

Two stacked zones, viewed from the bed side:

1. **Color slab** (front): `colorLayers` thin layers. Each pixel column is a stack of 0..n
   layers of the enabled color filaments (slots 2–4) with the rest filled by the base
   filament. The combo is chosen *per color cell* (a block of `colorCellPx` pixels) to
   minimize a chroma-weighted Oklab error **after** the body thickness has been set to hit
   the target luminance.
2. **Body** (back): a base-filament heightfield whose thickness per pixel is solved in
   closed form so that total transmission matches the pixel's target luminance
   (log-linear in CIE L*, so perceived tone maps evenly onto thickness).

The solver (`buildSolver`) precomputes the transmission of every combo *relative to an
all-base stack of the same height*, and a 32³ LUT maps quantized sRGB → best combo. Dithering
is a Floyd–Steinberg pass in Oklab space, clamped so out-of-gamut colors don't smear.

Key mathematical insight (documented in-code): a neutral body scales linear RGB by a
constant `s`, which scales Oklab by `cbrt(s)` — so "best combo at a given brightness" is a
well-posed, cheap problem.

### 3.2 Filament painting (front-lit, banded)

Heights come from one of two rules:

- **Best color match (default):** the height whose *printed* color (walking up the band
  stack with Kubelka–Munk, one layer at a time) is closest to the pixel in chroma-weighted Oklab. This is
  computed **on the GPU** (`matchLayers` in the fragment shader) and the per-pixel layer
  counts are *read back* — so the export is exactly the heights the preview shows. (The CPU
  mirror in `optics.ts` is float64 vs the GPU's float32; errors within `MATCH_TIE` count as
  ties and go to the lower height, so float noise can't make them disagree.)
- **From brightness:** a plain heightmap, `min + lum·(max−min)` rounded half-up, optionally
  inverted.

The layer stack is a list of bands (bottom→top), each a filament with an exclusive top
height. The same filament may occupy multiple non-adjacent bands (they share one material
id, but each band is a separate Z slice). `resolveStack` maps bands → Z ranges + material ids;
`materialOfLayers` maps each layer index → the material of the band containing its mid-height.

The **Backlit** tab of painting mode shows the same heightfield held up to a light, using the
KM transmittance of the same layer stack (rev. 3; rev. 2 had used the litho `absorption()`, and
before that an ad-hoc `exp(−K_TD/TD·(1−sRGB)·d)` that let white filament pass all light). A
dark bottom band is therefore (correctly) close to opaque in this view.

### 3.3 Filament mosaic (front-lit, per-tile combos)

Instead of one global height→filament curve, every nozzle-wide tile chooses its own short
combo of filaments from a 4-slot loadout (slot 0 = ground, usually the darkest). Combos are
enumerated (up to `maxSegments` segments of loadout filaments within `tintLayers` layers,
adjacent segments differ, first is not the ground), and combos that print the same Oklab
color collapse to the simplest. Each tile takes the nearest combo (weighted k-d tree in
Oklab), with optional dithering and small-island merging.

The optics are **Kubelka–Munk**, not Beer–Lambert: a filament's color fixes the
absorption/scattering ratio (K/S) per channel and its TD fixes the scattering S, so a
translucent filament (large TD) *tints what is below* (subtractive filtering) rather than
hiding it. This is what lets 4 filaments reach hundreds of distinct colors.

## 4. Process & threading model

| Work | Where | Why |
| --- | --- | --- |
| Image decode, framing, tone adjust | main thread (2D canvas) | Cheap, one-shot per input |
| Litho solve | main thread | Cached solver + 32³ LUT; fast enough per recompute |
| Painting preview | **GPU** (WebGL2) | Refresh-rate interactivity while dragging |
| Painting height read-back | GPU (`readPixels`) | Guarantees export == preview |
| Mosaic solve + preview | main thread (CPU, `renderMosaic` → 2D canvas) | k-d tree NN over deduped combos |
| **All** mesh builds + 3MF writes | **Web Worker** (`threeMfWorker.ts`) | Keeps the UI responsive for large grids |
| 3D viewport | main thread (three.js, lazy) | Visualization only, never on the export path |

> **Export protocol (revision 2, all modes since rev. 3):** `runExport` (`paint/exportClient.ts`)
> sends the request with `confirmAbove = 3 M` triangles. The worker builds the parts; if they
> exceed it, it answers `{ confirm: true, triangles }` and keeps the parts. The main thread asks
> the user (with mode-specific tips to lighten the model) and sends `{ kind: 'write',
> confirmed }`. The expensive mesh build never blocks the UI, and cancelling skips the XML + zip
> step. (Before: litho built meshes on the main thread *before* its `confirm`, and painting and
> mosaic had no gate at all.)

## 5. Notable design decisions (the good parts)

1. **Same-formula preview/export invariant.** For painting, the export heights are *read
   back from the shader that draws the preview* (`readLayers`). For mosaic, the same
   `solveMosaic` output feeds both the raster and the voxels. This eliminates the entire
   class of "preview ≠ print" bugs and is the single most valuable architectural choice.
2. **Shared manifold meshing.** One `meshVoxels` produces watertight, 2-manifold parts for
   all three modes; the tests assert edge-pairing and positive signed volume. This is
   genuinely hard to get right (T-junctions, diagonal pinch edges) and it's centralized.
3. **Numerically-stable optics.** KM layer reflectance uses the exact two-flux closed form
   (valid for any S·d ≥ 0) rather than an unstable infinite series; the TD→scattering
   mapping is a log-space bisection. Beer–Lambert paths use `exp` directly.
4. **Memory discipline.** Typed arrays throughout; `XmlWriter` flushes at 1 MB; the worker
   transfers (not copies) buffers; `Preview3D` is lazy-imported so `three` isn't on the
   critical path.
5. **Faithful recommendations.** `suggest`/`pickLoadout` score candidate stacks/loadouts with
   the *same* optics and height-assignment as the preview, and prefer simpler stacks within a
   tolerance — so "Suggest" is trustworthy, not just a heuristic.
6. **Defensive persistence.** localStorage reads are wrapped in try/catch, JSON is
   validated field-by-field (`sanitizeProfile`, `normalizeStack`, `normalizeLoadout`), and
   the app degrades to in-memory state if storage is disabled.
7. **No dynamic code, no network.** All DOM is built via `textContent`/`createElement`;
   3MF XML is escaped; the only async I/O is a same-origin worker and a lazy module. The
   production build enforces this with a CSP meta tag (`connect-src 'none'`,
   `worker-src 'self'`), injected by a build-only plugin in `vite.config.ts`.

## 6. Coupling & layering observations

- `el`, `isLight` and `AMS_SLOTS` live in `paint/ui.ts` (rev. 3), so the two mode controllers
  no longer import each other.
- `main.ts` (~400 lines since rev. 3) is the orchestrator: state, mode dispatch, `compute`,
  previews, info bar, file input and export wiring. The settings table and defaults are in
  `settings.ts` (pure, with `frameGrid`), the panel builder in `controls.ts`, drag/zoom in
  `framing.ts`, and the litho filament editor in `lithoFilaments.ts`.
- The litho path and the paint/mosaic paths each define their own `Filament`-like type
  (`Filament` in `color.ts` vs `FilamentProfile` in `paint/model.ts` vs `MosaicFilament` in
  `paint/mosaic.ts`). `MosaicFilament` is an alias of a `FilamentProfile` subset (rev. 3), so
  the real split is litho (in-memory presets, not persisted) vs paint/mosaic (persisted
  profiles).
- TD has two readings, one per kind of filament data: litho presets (Beer–Lambert, ~10% light
  left at 1 TD) and filament profiles (Kubelka–Munk, 5% of background contrast left at 1 TD),
  the latter used by every painting and mosaic view since rev. 3 (B5).

- The 2D view buttons are named by role (rev. 3): `data-view="main"` is how the print is meant
  to be seen, `data-view="alt"` the secondary view; `VIEW_LABELS` in `settings.ts` gives the
  per-mode labels (litho Backlit / Unlit, painting Front-lit / Backlit, mosaic Front-lit /
  Swatches).

## 7. Testing posture

Two test files, 45 tests. `core.test.ts` covers the riskiest math and geometry: solver
tone mapping, combo budget, manifold closure and volume conservation across modes and
filament sets, a flat-block triangle-count guard on the greedy mesher, band→material mapping,
3MF package structure, **CPU vs shader height matching (a statement-for-statement port of
`matchLayers`)**, KM convergence and TD contrast, combo enumeration/dedupe, k-d-tree
correctness, island merging, swatch plate, loadout normalization, auto-pick quality and
determinism, framing geometry (`panRange`/`sourceAspect`/`frameGrid`), and the brightness helpers.
`exportWorker.test.ts` runs the real worker module in-process behind a fake `Worker` and
covers the export protocol end to end: direct write, confirm → write, cancel, and the grid cap.
Gaps: the canvas-based parts (`renderFramed`, 2D previews) and the GLSL itself (only its port
is tested).
