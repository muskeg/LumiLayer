# Bug Fixes Plan

Concrete defects, in priority order. 🔴 wrong print / crash. 🟠 consistency or a latent
correctness risk. 🟡 hygiene / foot-gun.

Each entry: **Symptom → Root cause → Reproduction → Fix → Test**. All findings were verified
against the source. **Revision 2** re-verified every entry, corrected the ones marked
(corrected), added B9–B13, and fixed the items marked ✅.

---

## B1 — Two independent implementations of the painting Beer–Lambert recurrence can diverge
✅ fixed (rev. 2)

**What was done:**
- The GLSL is a template literal (it already interpolated `${MAX_BANDS}`), so `K_TD`,
  `TD_FLOOR` and `MATCH_TIE` are now interpolated from `optics.ts` / `color.ts`. No separate
  constants module or headless GL was needed.
- A differential test ports `matchLayers` statement-for-statement and compares it with
  `bestLayer(pathLabs(…))` on 480 random pixel/stack cases. It immediately found B11 and B12.

**Original finding:** `paint/preview.ts` (GLSL, `K_TD` hard-coded) and `paint/optics.ts`
(`pathLabs`/`bestLayer`, used by the no-WebGL fallback in `PaintController.heights()` and by
`suggest.ts`) implemented the same recurrence independently, with no test comparing them.

**Remaining limit:** the test pins the CPU to a *port* of the shader. If the GLSL changes, the
port in `core.test.ts` must change with it (it sits next to the test for that reason). A
headless-GL read-back of `readLayers()` would remove that last gap.

---

## B2 — Litho path does not validate `Filament.color`; bad preset renders as white
🟡 (corrected: was 🟠; not reachable today)

**(corrected)** Litho colors come only from hard-coded valid presets and an
`<input type="color">`, which always yields `#rrggbb`. The white fallback cannot trigger from
the UI. Throwing from `buildSolver` would be over-engineering; revisit only if litho filaments
ever become importable/persisted (then route them through the same validator as
`sanitizeProfile`). The original analysis follows for reference.

**Symptom:** `hexToRgb` in `color.ts` silently returns `[1,1,1]` (white) for any input that
doesn't match `^#?([0-9a-f]{6})$i`. The paint/mosaic path validates hex on load
(`sanitizeProfile`), but the **litho preset path never does** — `LITHO_PRESETS` and any
user-editable `Filament[]` are passed straight into `buildSolver`. A typo like `#ff` or a
non-hex string produces an all-white filament, with no warning.

**Root cause:** `hexToRgb` conflates "parse" and "parse-or-default-to-white."

**Reproduction:** set a litho preset filament's color to `"#ff0"` (3-digit hex, not
accepted) or `"red"`; the solver silently treats it as white.

**Fix:**
1. Add a `parseHex(hex): RGB | null` that returns `null` on failure, and keep `hexToRgb` as a
   thin convenience that calls it and falls back to white **only** where a default is
   acceptable (e.g. the light-color control, where white is a reasonable default).
2. In `buildSolver` / `lithoParams`, validate every `Filament.color` up front; if any is
   invalid, throw a descriptive error that names the offending filament so the UI can surface
   it (rather than producing a wrong print).
3. In the UI, when the user edits a filament color in the paint/mosaic profile editor, the
   existing `sanitizeProfile` already rejects bad hex — keep that, and mirror it for the litho
   preset editor if one is added (see new-features-plan).

**Test:** unit test `parseHex` over a table of valid/invalid inputs; a `buildSolver` test
asserting it throws on a bad color.

---

## B3 — `imaging.adjust` saturation uses BT.601 luma, everywhere else uses Rec.709
🟡

**Symptom:** Desaturating a pixel by `saturation = 0` (or any value) moves it toward a luma
computed with BT.601 weights (`0.299/0.587/0.114`), while the litho solver, the painting
alpha channel, and the mosaic luma all use Rec.709 (`0.2126/0.7152/0.0722`). The difference is
small (a few luma points in the mid-tones) but is another instance of "brightness" being
defined three ways across the codebase.

**Root cause:** copy-paste from the classic 0.299/0.587/0.114 grayscale recipe.

**Fix:** introduce a single `luma(r,g,b)` helper in `color.ts` (Rec.709, on sRGB values,
clamped to 0..1) and use it in `imaging.adjust`, `paint/model.ts` (`lumaOf`), and the
`isLight` / `swatches` luminance thresholds. Keep `luminance` (Rec.709 on **linear** values)
as a distinct, well-named function for the litho path. A one-line comment in each should make
the sRGB-vs-linear distinction explicit.

**Test:** a unit test that `luma` and the inlined 0.299 expression agree on a small grid of
samples (so the change is provably the *only* behavioral difference), then delete the inlined
version.

---

## B4 — `lumaOf` vs `luminance`: same Rec.709 weights, different input domain
🟡 (not a crash; a consistency gap)

**Symptom:** For the *same* input pixel (r,g,b in 0..1), `lumaOf` (paint/mosaic) and
`luminance` (litho) return **different numbers**: `lumaOf` applies the weights to sRGB values
while `luminance` applies them to values that the litho path linearizes first (see
`lithophane.ts:80-81`). This is defensible — Rec.709 on gamma values is the classic
"grayscale" recipe — but it means "brightness of pixel X" has two answers in this codebase,
and the "darkest/lightest filament" heuristics (in `defaultLoadout`, `swatchRows`) and the
`layersFromLuminance` path all use the gamma-space luma.

**Root cause:** two independently written helpers that happen to share weights.

**Fix:** fold into the B3 consolidation: one `luma()` (sRGB-domain) and one
`luminance()` (linear-domain), both exported from `color.ts`, with a doc comment on each
stating the domain. Replace every inlined expression.

**Test:** after the refactor, a snapshot test that the litho `targetFor` output is
byte-identical to today's (it should be — the linear-domain path is unchanged), and that the
painting/mosaic `lumaOf` output is byte-identical to today's (it should be — the sRGB-domain
path is unchanged). The point is to *prove* no behavior change, only consolidation.

---

## B5 — TD meaning differs across models for the same filament value
🟠 (user-confusing, not a crash)

**(corrected)** The scenario "tune in litho, reuse in paint" needs the user to retype the value:
litho filaments are in-memory presets, not shared with profiles. The overlap users actually
meet is **painting vs mosaic**, which read the *same stored profile TD* through different
models (Beer–Lambert hiding vs KM contrast). The first pass's conversion formula
(`td_paint ≈ td_litho / log(10/5) / …`) was meaningless, and a `tdConvention` type field is
the wrong design: TD is a measured property of the filament; the convention belongs to the
model.

**Fix:** keep one physical TD per filament and have each model derive its constants from it
(calibrate `K_TD` and `TD_CONTRAST` so the same measured TD predicts consistent looks). The
short-term part is done (rev. 3): every TD input and the shared Filaments panel say what 1 TD
means in the active mode (I10).

**Test:** none directly (UX/model change); a visual review is sufficient.

---

## B6 — Two `hexToRgb` implementations with *different* fallbacks (white vs black)
✅ fixed (rev. 2)

`paint/preview.ts` now imports `hexToRgb` and `srgbToLinear` from `color.ts`; its private copies
(black fallback, `#` required) are gone.

---

## B7 — `imaging.adjust` clamping — VERIFIED OK, no change needed
✅ (closed)

Verified: `adjust` applies `clamp = v<0?0:v>1?1:v` inside its `tone` helper before the gamma
power, so output is guaranteed in `[0,1]`. No out-of-range floats reach the solver or shader.
No fix required.

---

## B8 — CPU fallback vs shader frame handling — VERIFIED CONSISTENT
✅ (closed)

Verified: the fragment shader branches on `px.a < 0.0` to use `u_frameLayers`, and the CPU
fallback in `PaintController.heights()` branches on `a < 0` (the `FRAME_SENTINEL = −1` alpha)
to use the frame height. The two agree. (The remaining B1 concern about the *color* recurrence is independent; see B1.)

---

## B9 — Painting Backlit view used its own, wrong optical model
✅ fixed (rev. 2) — missed by the first pass

**Symptom:** the painting **Backlit** tab rendered `c *= exp(−K_TD/TD·(1−sRGB color)·d)`:
absorption from *gamma-encoded* color, the 5% painting TD reading, and zero absorption for white
(a white band passed all light).

**Fix:** the shader's backlit branch now multiplies by `exp(−u_filamentAbs[i]·d)`, with
`u_filamentAbs` = `absorption({ color, td })` from `color.ts` — the litho model. Every backlit
view now shares one model. Visible consequence: a dark bottom band is (correctly) near-opaque.

---

## B10 — Painting view buttons are named against their labels
✅ fixed (rev. 3)

In paint mode `data-view="backlit"` was labelled **Front-lit** and `data-view="front"`
**Backlit**. Views are now named by role (`main` / `alt` / `3d`) with a per-mode
`VIEW_LABELS` table in `main.ts`.

---

## B11 — CPU and GPU height matching disagreed on near-ties
✅ fixed (rev. 2) — found by the B1 test

**Symptom:** when a saturated band repeats the same color over several heights, the match
errors are equal up to float noise (the CPU path stores Oklab in a `Float32Array`; the GPU
computes in float32). The two paths then picked different heights — up to 6 layers apart in the
test — for the same color.

**Fix:** `MATCH_TIE = 1e-6` (≈ ΔE 0.001) in `optics.ts`, interpolated into the shader. Errors
within it are ties and go to the lower height on both sides (less filament, deterministic).

---

## B12 — TD floor differed between CPU (0.05) and GPU (1e-3)
✅ fixed (rev. 2)

Not reachable from the UI (profiles clamp TD ≥ `TD_MIN = 0.1`), but a real divergence.
`TD_FLOOR = 0.05` now lives in `color.ts` and is used by `absorption`, `bandOptics` and the
shader.

---

## B13 — Litho heavy-model `confirm` came after the expensive mesh build
✅ fixed (rev. 2)

**Symptom:** `exportLitho` built all meshes on the main thread, *then* asked "Export anyway?".
The gate could not prevent the freeze it warned about.

**Fix:** litho export runs in `threeMfWorker.ts`: build parts → if > 3 M triangles reply
`{ confirm, triangles }` and hold the parts → main asks → `write { confirmed }`. Verified
in the browser: 5.4 M triangles → cancel ("Export cancelled") and accept (47 MB 3MF), UI live
throughout.

---

## Summary table

| ID | Severity | One-liner | Status |
| --- | --- | --- | --- |
| B1 | 🟠 | Two independent Beer–Lambert implementations (GPU + CPU) could diverge; no test pinned them. | ✅ fixed |
| B2 | 🟡 | Litho path does not validate filament color (not reachable from the UI). | open, low |
| B3 | 🟡 | `imaging.adjust` saturation uses BT.601 luma; others use Rec.709. | open |
| B4 | 🟡 | `lumaOf` (sRGB) vs `luminance` (linear) — same weights, different domain. | open |
| B5 | 🟠 | TD meaning differs by model; painting vs mosaic share stored TDs. | open (UX/model) |
| B6 | 🟠 | Two `hexToRgb` with different fallbacks. | ✅ fixed |
| B7 | ✅ | `adjust` clamping — verified OK, no change. | closed |
| B8 | ✅ | CPU fallback vs shader frame handling — verified consistent. | closed |
| B9 | 🟠 | Painting Backlit view used an ad-hoc gamma-space model. | ✅ fixed |
| B10 | 🟡 | Painting view buttons named against their labels. | ✅ fixed |
| B11 | 🟠 | CPU/GPU height matching disagreed on near-ties. | ✅ fixed |
| B12 | 🟡 | TD floor 0.05 (CPU) vs 1e-3 (GPU). | ✅ fixed |
| B13 | 🔴 | Litho `confirm` came after the main-thread mesh build. | ✅ fixed |

**Suggested order of remaining work:** B3 + B4 (one luma consolidation pass), then B5
(UX/model), B2 only if litho filaments become importable.
