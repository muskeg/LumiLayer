# Improvement Plan

Engineering improvements that raise quality, performance, and maintainability *without* adding
user-facing features. Prioritized P0 (do first) → P2 (nice to have). Each item names the
concrete seam and the risk it removes. Bug fixes are in `bug-fixes-plan.md`; new user-facing
capabilities are in `new-features-plan.md`.

Severity: 🔴 = real user harm if left. 🟠 = maintainability/correctness risk. 🟡 = hygiene.

---

## P0 — high value, low effort

### I1 — Move litho export to a Web Worker (close the thread-model asymmetry) ✅ done (rev. 2)

**What was done:** `exportLitho` sends `{ kind: 'litho', result (minus sim/front), tolerance,
confirmAbove }` to `threeMfWorker.ts`, which runs `buildLithoParts`. Above 3 M triangles it
replies `{ confirm, triangles }` and holds the parts; the main thread asks and sends
`litho-write { confirmed }`. The geometry is *copied*, not transferred, because the preview
keeps using `result`.

**(corrected)** The first pass said litho "zips on the main thread" and suggested keeping the
`confirm` "and moving the work that follows it". In fact deflate was already off-thread
(fflate's async `zip`), and the expensive work — the mesh build — came *before* the `confirm`,
so the gate never prevented the freeze (see B13). The two-step protocol is what fixes it.

---

### I2 — Consolidate the three filament types into one 🟡 (corrected: was 🔴)
`Filament` (color.ts), `FilamentProfile` (paint/model.ts), and `MosaicFilament`
(paint/mosaic.ts) are near-identical `{name, color, td}` shapes. `MosaicFilament` is already a
structural subset of `FilamentProfile`. This is a tidy-up, not the root of B2/B5/B6:
B2 is unreachable, B6 is fixed, and B5 is a model question.

**What to do (if at all):** alias `MosaicFilament` to `Pick<FilamentProfile, 'name' | 'color' | 'td'>`.
Do **not** add a `tdConvention` field: TD is a filament property; the convention belongs to
each model (see B5).

**Effort:** S.

---

### I3 — Pin the GPU/CPU painting recurrence together ✅ done (rev. 2, fix for B1)
Shader constants interpolated from TS (`K_TD`, `TD_FLOOR`, `MATCH_TIE`); differential test
against a port of `matchLayers`. The test found and drove the fixes for B11 (near-tie
disagreement) and B12 (TD floor mismatch).

---

## P1 — maintainability

### I4 — Split `main.ts` ✅ done (rev. 3)
`main.ts` went from ~810 to ~400 lines. New modules:

- `settings.ts` — `Settings`, `DEFAULTS`, `MODE_DEFAULTS`, `VIEW_LABELS`, `LITHO_PRESETS`, the
  `SECTIONS` table (mode panels referenced by id, so the table is pure data), `MAX_PIXELS` and
  `frameGrid` (the grid sizing that was inline in `compute`; now tested).
- `controls.ts` — `buildControlPanel` returns `{ sync, showMode }`; the "Reset image" button is
  driven by a `resetLabel` on the section instead of a title check.
- `framing.ts` — `attachFraming` (drag-to-pan, wheel-to-zoom).
- `lithoFilaments.ts` — the litho preset + slot editor.

Export wiring stayed in `main.ts`: after `runExport` it is ~20 lines. Verified: tests, build,
and a browser pass over all three modes (sections per mode, preset change, wheel zoom, reset,
exports), with no page errors.

---

### I5 — Break `mosaicController → controller` coupling ✅ done (rev. 3)
`el`, `isLight` and `AMS_SLOTS` moved to `paint/ui.ts`; both controllers import from there.

---

### I6 — Add the missing tests ✅ done (rev. 3)
Added: `exportWorker.test.ts` (the real worker module behind a fake `Worker`: direct write,
confirm → write, cancel leaves nothing pending, grid-cap error), framing geometry
(`panRange`, `sourceAspect`), suggestion and auto-pick determinism, and a flat-block
triangle-count guard on the greedy mesher. `runExport` gained an optional `confirmAbove`
parameter so the confirm path is testable without a 3 M-triangle model.

Still untested: canvas code (`renderFramed` drawing, 2D previews) — it needs a DOM canvas.

---

## P2 — polish / DX

### I7 — Unify "brightness" into one documented `luma`/`luminance` pair ✅ done (rev. 3, fixes B3/B4)
`color.ts` exports `luminance()` (linear) and `luma()` / `hexLuma()` (sRGB), each documented
with its domain; every inlined copy and `lumaOf` were replaced. Tests cover the domains,
desaturation and the `isLight` threshold.

---

### I8 — Reduce the 3MF main-thread copy for litho ✅ moot (rev. 2)
All 3MF writing now happens in the worker (`write3mfSync`), and `buildModelXml` already streams
through `XmlWriter` in ~1 MB chunks. Nothing left on the main thread to optimize.

---

### I9 — Typed message protocol for the worker ✅ done (rev. 2)
`WorkerRequest = PaintExportInput | MosaicExportInput | LithoExportInput | WriteRequest`
and `WorkerResponse` / `BuildResponse` are exported from `threeMfWorker.ts`; the main-thread
side lives in one place, `runExport` in `paint/exportClient.ts`.
(as types) by `main.ts` and both controllers. Painting is the only variant without a `kind`
tag; adding `kind: 'paint'` would make the union fully discriminated.

---

### I10 — Document the TD meanings at the point of use ✅ done (rev. 3)
The shared Filaments panel (painting + mosaic) switches its hint and the TD slider tooltips with
the mode (`PaintController.setTdHelp`, texts in `TD_HELP`): painting explains the 5% hiding
reading and that the Backlit view reads ~10% light; mosaic explains the 5% contrast reading and
tinting. The panel also says the profiles are shared by both modes. The litho legend states the
~10% light reading.

---

### I11 — Content Security Policy ✅ done (rev. 2, see V2)

---

## Prioritized backlog

| # | Sev | Item | Effort |
| --- | --- | --- | --- |
| I3 | 🔴 | Pin GPU/CPU painting recurrence (fix B1) | ✅ done |
| I1 | 🔴 | Litho export → worker with build → confirm → write | ✅ done |
| I9 | 🟡 | Typed worker message protocol | ✅ done |
| I8 | 🟡 | Audit 3MF streaming for large models | ✅ moot |
| I11 | 🟠 | CSP in the production build | ✅ done |
| I6 | 🟠 | Add missing tests (worker protocol, framing, determinism, mesh size guard) | ✅ done |
| I4 | 🟠 | Split `main.ts` | ✅ done |
| I5 | 🟠 | Break `mosaicController → controller` coupling | ✅ done |
| I2 | 🟡 | Alias `MosaicFilament` (no `tdConvention`) | open |
| I7 | 🟡 | Unify `luma`/`luminance` (fix B3/B4) | ✅ done |
| I10 | 🟡 | TD-meaning tooltips | ✅ done |

**Suggested order:** only I2 (a small type alias) is left.
