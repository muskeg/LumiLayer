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

### I4 — Split `main.ts` (~800 lines, the only non-pure file with real logic) 🟠
The file mixes: settings table + defaults, controls builder, mode dispatch, framing drag/zoom,
export, and viewer. Natural seams, all mechanical:

- `settings.ts` — the `Settings` type, `DEFAULTS`, `MODE_DEFAULTS`, the control `Section` table.
- `framing.ts` — the drag/zoom/pan handlers + `panRange`/`sourceAspect` usage.
- `export.ts` — `exportLitho` / `exportPainting` (already half factored).
- `main.ts` shrinks to wiring: DOM refs, mode switching, `compute()` dispatch.

**Benefit:** each concern is independently testable (the framing and settings logic today has
zero tests because they're entangled with the DOM).

**Effort:** M (pure refactor, no behavior change — protect with the existing 32 tests + a couple
of new settings/framing tests).

---

### I5 — Break `mosaicController → controller` coupling 🟠
`mosaicController.ts` imports `el`, `isLight`, `AMS_SLOTS` from `controller.ts`. Those are
generic utilities that live in a sibling controller by accident.

**What to do:** move `el`, `isLight`, `AMS_SLOTS` (and any other shared DOM helpers) into a
neutral `paint/ui.ts`. Both controllers then import from `paint/ui.ts`, removing the
controller-to-controller edge.

**Benefit:** the two controllers become independent peers over shared utilities instead of a
hidden dependency; easier to test and to evolve separately.

**Effort:** S.

---

### I6 — Add the missing tests 🟠
`core.test.ts` (32 tests) covers the pure core well, but these pure/testable paths have none:

- `imaging.ts` — `adjust` (incl. the BT.601 → Rec.709 change from B3) and `renderFramed`
  crop/rotate/zoom math.
- `suggest.ts` / `loadout.ts` — invariant tests (e.g. suggested stack is ≤ `AMS_SLOTS` filaments,
  bands partition the height, auto-pick is deterministic for a fixed image).
- `mesh.ts` — the three builders already have manifold tests; add a *size/perf* guard (a small
  case with known triangle count) to catch regressions.
- `threeMfWorker.ts` — the message protocol, especially the litho `confirm` → `litho-write`
  round-trip (today verified only manually in the browser).

**Benefit:** the refactor items (I1–I5) become safe, and regressions are caught.

**Effort:** M.

---

## P2 — polish / DX

### I7 — Unify "brightness" into one documented `luma`/`luminance` pair 🟡 (fixes B3/B4)
Introduce `luma()` (Rec.709 on sRGB values) and `luminance()` (Rec.709 on linear values) in
`color.ts`, with a one-line comment on each stating the domain. Replace the inlined
`0.299/0.587/0.114` in `imaging.adjust` and the duplicated `0.2126/…` in `lumaOf`, `isLight`,
and `swatches`. A snapshot test proves no behavior change.

**Effort:** S.

---

### I8 — Reduce the 3MF main-thread copy for litho ✅ moot (rev. 2)
All 3MF writing now happens in the worker (`write3mfSync`), and `buildModelXml` already streams
through `XmlWriter` in ~1 MB chunks. Nothing left on the main thread to optimize.

---

### I9 — Typed message protocol for the worker ✅ done (rev. 2)
`WorkerRequest = PaintExportInput | MosaicExportInput | LithoExportInput | LithoWriteRequest`
and `WorkerResponse` / `LithoWorkerResponse` are exported from `threeMfWorker.ts` and imported
(as types) by `main.ts` and both controllers. Painting is the only variant without a `kind`
tag; adding `kind: 'paint'` would make the union fully discriminated.

---

### I10 — Document the TD meanings at the point of use 🟡
Already covered in `02-color-and-light-models.md` §2; surface a one-line tooltip on each mode's
TD input (also a B5 fix). A profile TD is now also read by the painting Backlit view (10%
convention).

**Effort:** S (UX copy).

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
| I6 | 🟠 | Add missing tests (imaging, worker protocol, suggest/loadout invariants) | open |
| I4 | 🟠 | Split `main.ts` | open |
| I5 | 🟠 | Break `mosaicController → controller` coupling | open |
| I2 | 🟡 | Alias `MosaicFilament` (no `tdConvention`) | open |
| I7 | 🟡 | Unify `luma`/`luminance` (fix B3/B4) | open |
| I10 | 🟡 | TD-meaning tooltips | open |

**Suggested order:** I6 first so the P1 refactors (I4, I5) are protected, then I7, I10, I2.
