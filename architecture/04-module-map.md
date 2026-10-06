# 04 — Module Map

File-by-file responsibilities, public APIs, invariants, and coupling. The codebase is small and
intentionally flat: **pure math modules** with no DOM, and a thin **UI layer** (`main.ts` +
`paint/controller.ts` + `paint/mosaicController.ts`) that owns the DOM and orchestration.

## 1. Dependency graph (top = depends on, bottom = depends on nothing)

```
main.ts ──────────────► color(type), download, imaging, lithophane, preview3d, paint/controller, paint/mosaicController,
                        paint/threeMfWorker (types + new Worker)
paint/controller ────────────► download, paint/model, paint/preview, paint/optics, paint/suggest, paint/export(type), paint/threeMfWorker(type)
paint/mosaicController ──────► color, download, paint/model, paint/mosaic, paint/swatches, paint/loadout, paint/export(type),
                               paint/threeMfWorker(type), paint/controller (el/isLight/AMS_SLOTS)
paint/threeMfWorker ─────────► paint/export, threemf(type)
paint/export ─────────────────► mesh, threemf, lithophane(type), paint/model(type)
paint/preview ────────────────► color, paint/optics, paint/model
paint/suggest ─────────────────► paint/model, paint/optics
paint/loadout ─────────────────► paint/mosaic, paint/km, paint/model, paint/optics, paint/suggest
paint/swatches ────────────────► paint/mosaic
paint/mosaic ─────────────────► paint/km, paint/optics, color
paint/optics ─────────────────► paint/model(type), color
paint/km ─────────────────────► color
paint/model ──────────────────► color (hexToRgb, luma)
mesh ─────────────────────────► lithophane(type)
threemf ──────────────────────► fflate, mesh(type)  [pure packaging]
preview3d ────────────────────► three, mesh
lithophane ───────────────────► color
imaging ──────────────────────► (none)
color ─────────────────────────► (none)  [pure]
```

(corrected) The first pass listed `paint/model → color` and `imaging → color`; neither import
exists.

The pure core (`color`, `mesh`, `threemf`, `imaging`, `paint/{model,km,optics,mosaic}`) has
**zero DOM access**, which is what makes it testable and what the tests exercise.

## 2. Pure core

| Module | Responsibility | Public API (exports) | Invariants / notes |
| --- | --- | --- | --- |
| `color.ts` | sRGB↔linear, L\*, Oklab, brightness, `absorption`, `TD_FLOOR` | `Filament`, `RGB`, `hexToRgb`, `rgbToHex`, `srgbToLinear`, `linearToSrgb`, `luminance` (linear), `luma` / `hexLuma` (sRGB), `lightness`, `linearToOklab`, `absorption`, `TD_FLOOR` | the only brightness helpers in the codebase. `hexToRgb` falls back to **white** on bad input; not reachable from the UI today (🟡). `absorption` serves every backlit view. |
| `imaging.ts` | decode, frame/crop/rotate/zoom/pan, brightness/contrast/gamma/saturation | `loadImage`, `demoImage`, `renderFramed`, `adjust`, `sourceAspect`, `panRange`, `Source` | desaturates toward `luma()` (Rec. 709, same as the heightmap). |
| `lithophane.ts` | litho solver: combo enumeration + 32³ LUT + transmittance tables, per-pixel body thickness | `buildSolver`, `solve`, `targetFor`, `bestCombo`, `colorSlabThickness`, `LithoParams`, `LithoResult`, `LithoGeometry`, `Solver` | closed-form body thickness; Oklab `cbrt(s)` scale trick. |
| `mesh.ts` | manifold voxel mesher + the three build entry points | `MeshBuilder`, `slabMaterials`, `addBody`, `meshVoxels`, `buildPrintMeshes`, `buildVoxelMeshes`, `buildLayerBandMeshes` | one shared manifold mesher; the single source of the watertight guarantee. |
| `threemf.ts` | 3MF package assembly (XML + zip) | `XmlWriter`, `buildModelXml`, `write3mfSync`, `Part` | XML is escaped; streamed in ~1 MB chunks. Sync only (async fflate `zip` removed: it needs `blob:` workers). |
| `download.ts` | safe download trigger + filename | `triggerDownload`, `exportFileName` | filename sanitized; object URL revoked after 10 s (deliberate: revoking immediately can cancel downloads in some browsers). |
| `paint/model.ts` | profiles, bands, stack resolution, persistence, luminance→layers | `FilamentProfile`, `Band`, `StackLayer`, `resolveStack`, `normalizeStack`, `layersFromLuminance`, `defaultLoadout`, `normalizeLoadout`, `loadProfiles`, … | `FilamentProfile` is the **persisted** filament (id + name + color + td). `sanitizeProfile` is internal (not exported). |
| `paint/km.ts` | Kubelka–Munk two-flux, TD→scattering | `filamentOptics`, `stackOn`, `TD_CONTRAST`, `FilamentOptics` | stable closed form; log-space bisection. |
| `paint/optics.ts` | painting Beer–Lambert CPU model + matching | `K_TD`, `CHROMA_WEIGHT`, `MATCH_TIE`, `bandOptics`, `pathLabs`, `targetLab`, `bestLayer` | `K_TD = −ln(0.05)`; **CPU mirror of the shader**, pinned by a differential test. |
| `paint/mosaic.ts` | combo set, k-d tree, mosaic solve, dither, island merge, voxel output | `ComboSet`, `buildCombos`, `combosFromList`, `KdTree`, `solveMosaic`, `mergeIslands`, `mosaicVoxels`, `renderMosaic`, `mosaicStats`, `MosaicFilament` | `FRAME = −1`, `EMPTY = −2` sentinels; dedupe grid `0.008`. |
| `paint/swatches.ts` | swatch plate generation | `swatchRows`, `swatchPlate` | top-left notch. |
| `paint/suggest.ts` | suggest a ≤4-filament stack for an image | `sampleImage`, `suggestStack` | 2-stage: rank sequences then refine tops. |
| `paint/loadout.ts` | pick the best ≤4-filament loadout | `pickLoadout`, `gamutError` | rank all, re-score shortlist. |

## 3. GPU / worker / DOM layer

| Module | Responsibility | Notes |
| --- | --- | --- |
| `paint/preview.ts` | WebGL2 shaders; per-pixel height matching; display + `readLayers` read-back | **source of truth** for painting heights. `K_TD`/`TD_FLOOR`/`MATCH_TIE` interpolated from TS; Backlit view uses `absorption()` (`u_filamentAbs`). Handles `webglcontextlost`/`restored`. |
| `paint/export.ts` | part builders for all three modes + `packParts` | `buildLithoParts`, `buildPaintingParts`, `buildMosaicParts`, `buildPainting3mf`, `packParts`, `countTriangles`, `MAX_EXPORT_CELLS` (worker-side grid cap), message types. |
| `paint/threeMfWorker.ts` | dedicated worker; builds every 3MF | paint (transferred heights), mosaic (transferred voxels), litho (copied geometry). Above `confirmAbove` triangles it replies `confirm` and waits for `{ kind: 'write' }`. Exports `ExportRequest`, `WorkerRequest`, `WorkerResponse`, `BuildResponse`. |
| `paint/exportClient.ts` | main-thread side of the export protocol | `runExport` (send → optional `confirm()` → write), `HEAVY_TRIANGLES = 3 M`; used by `main.ts` and both controllers. |
| `paint/controller.ts` | `PaintController`: profiles, bands, GPU preview, worker export, stack panel, suggest; exports `el`, `isLight`, `AMS_SLOTS = 4` | `heights()` reads GPU layer counts, CPU fallback via `optics.ts`. Reuses one worker. |
| `paint/mosaicController.ts` | `MosaicController`: loadout, combo solve, CPU preview, swatch plate, worker export, auto-pick | imports `el`, `isLight`, `AMS_SLOTS` **from `controller.ts`** (🟠 coupling). Creates a new worker per export. |
| `preview3d.ts` | isolated three.js `Preview3D`, lazily imported | decoupled from export; own rAF loop. |
| `main.ts` | settings, mode dispatch, UI shell, `compute`, `exportLitho`, `exportPainting`, framing | the orchestrator; owns a lazily created litho export worker. |
| `index.html` + `vite.config.ts` | app shell, control DOM; build config | the build injects a CSP `<meta>` (build only; dev needs HMR + inline styles). |

## 4. The Filament type triad (🟡 consolidation target)

Three nearly-identical "a filament has a name, color, and td" shapes exist:

| Type | File | Fields | Used by |
| --- | --- | --- | --- |
| `Filament` | `color.ts` | `name`, `color`, `td`, `enabled` | litho presets & solver (in memory, not persisted) |
| `FilamentProfile` | `paint/model.ts` | `id`, `name`, `color`, `td` | persisted paint/mosaic profiles |
| `MosaicFilament` | `paint/mosaic.ts` | `name`, `color`, `td` | mosaic combo solve — a structural subset of `FilamentProfile` |

(corrected) Unifying them is a tidy-up, not a correctness fix. A `tdConvention` field (the
first pass's idea) would be the wrong model: TD is a property of the filament, the convention
belongs to each optical model.

## 5. Coupling hot-spots

- **`mosaicController` → `controller`** for `el`, `isLight`, `AMS_SLOTS`. These are generic
  utilities that live in a sibling controller by accident. Move them to a shared `paint/ui.ts`
  (or `paint/dom.ts`) so the two controllers depend on a neutral module, not on each other.
- **`main.ts`** owns ~800 lines: settings table, controls builder, mode dispatch, framing drag,
  export. It is the largest file and the only non-pure file with real logic. The natural seams
  are: a `settings.ts` (table + defaults), a `framing.ts` (drag/zoom), and the export functions.
- **Two places implement the painting Beer–Lambert recurrence** (`preview.ts` shader +
  `optics.ts` `pathLabs`). Pinned since revision 2 by shared constants and a differential test.
- **`main.ts` imports both controllers**, and each controller reaches back into `paint/model`
  and (mosaic) `paint/controller`. The dependency arrows are mostly one-way and clean; the one
  back-edge is `mosaicController → controller`.

## 6. Test coverage map

`core.test.ts` (37 tests) and `exportWorker.test.ts` (5 tests) exercise the non-DOM code:

- solver: enumeration, LUT, `bestCombo`, `targetFor`
- mesh: manifold closure (edge-pairing + positive signed volume) for the three builders; a flat
  block must mesh to exactly 12 triangles (greedy-merging regression guard)
- 3MF: package structure (litho via `buildLithoParts` + `write3mfSync`, painting)
- painting: CPU `pathLabs`/`bestLayer` vs a statement-for-statement port of the shader's
  `matchLayers` (480 random cases, including a TD below `TD_FLOOR`)
- KM: convergence to filament color, translucent filtering, TD contrast
- mosaic: combo dedupe, `KdTree` nearest-neighbor vs brute force, island merge
- model: `layersFromLuminance`, `normalizeStack`, `sanitizeProfile`, loadout auto-pick;
  suggestion and auto-pick are deterministic
- imaging: `panRange` / `sourceAspect` cover geometry, `adjust` desaturation
- color: `luma` vs `luminance` domains, `isLight` threshold
- export protocol (`exportWorker.test.ts`): the real worker module behind a fake `Worker` —
  direct write, confirm → write, cancel (nothing left pending), grid cap error

**Not covered:** canvas/DOM code (`renderFramed`, 2D previews, controllers) and the GLSL
itself (its port is tested).
