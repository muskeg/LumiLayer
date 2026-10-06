# New Features Plan

A staged roadmap for user-facing capabilities. Every feature is **grounded in
infrastructure that already exists** in this codebase — the point is to extend what the
current math and modules already do, not to bolt on something orthogonal. I've grouped by
stage, not by size: within a stage, items are roughly independent and each names the existing
building blocks it reuses.

Existing building blocks referenced below:
- **Three optical models** (Beer–Lambert transmission for every backlit view, Beer–Lambert hiding, Kubelka–Munk) — `color.ts` / `lithophane.ts`, `paint/optics.ts`, `paint/km.ts`.
- **Shared manifold mesher** + 3MF writer — `mesh.ts`, `threemf.ts`.
- **Worker export for all three modes** with transferred buffers — `paint/threeMfWorker.ts`.
- **Combo set + k-d tree + dithering + island merge** — `paint/mosaic.ts`.
- **Swatch plate + reachable-gamut map + auto-pick loadout** — `paint/swatches.ts`, `paint/mosaicController.ts`, `paint/suggest.ts`, `paint/loadout.ts`.
- **Persisted filament profiles + bands** — `paint/model.ts` (localStorage).
- **Oklab perceptual matching** — `color.ts`.

---

## Stage 1 — small, high-value, reuses existing math

### F1 — Measure TD from a printed swatch plate (close the loop the UI already opens)
The mosaic UI already renders a **swatch plate** ("Swatches render each slot color,
then combinations up to 2 extra layers, so you can calibrate each filament's TD against the
swatches") and a **"Reachable with this loadout"** gamut map. What's missing is the *return*
leg: photograph the printed plate, and let the app *measure* the real per-slot TD from it.

**What to do:**
1. Reuse `imaging.loadImage` + `adjust` to load a photo of the printed plate.
2. Reuse the known swatch layout (`swatchRows` / `swatchPlate`) to locate each swatch.
3. For each swatch, solve for the filament TD that best reproduces the observed reflectance,
   using the *same* `kmLayer` / `stackOn` model that produced the prediction — this is a 1-D
   search per swatch (the model is monotone in TD, so a bisection like `scatteringFor` works).
4. Write the measured TDs back into the `FilamentProfile` set (and offer to `suggestStack`
   again with the corrected values).

**Why it's cheap:** the forward model already exists and is closed-form; this is just inverting
it per swatch. It turns the swatch plate from a "print and eyeball it" tool into a measuring
instrument — the highest-leverage feature for print accuracy.

**The hard part (added in rev. 2):** a phone photo has unknown white balance, exposure and
tone curve. Without a known white and black reference printed on the plate (e.g. bare ground
and thick lightest filament), the per-swatch inversion fits the lighting rather than TD. Also
fit color, not only TD: KM's K/S ratio comes from the color.

**Effort:** M–L. **Depends on:** none (uses existing `km` + `imaging`).

---

### F2 — Export/import a filament profile set (portability)
`paint/model.ts` already persists profiles to localStorage and `sanitizeProfile` validates
them. There's no way to **share** a tuned profile set (a user's calibrated filament library)
between machines or between users.

**What to do:** add "Export profiles (JSON)" / "Import profiles (JSON)" that round-trips the
`FilamentProfile[]` through `sanitizeProfile` (reuse, don't re-validate), and offer it as a
download via the existing `download.ts`. A URL-safe base64 variant enables a share link with no
server (the app stays local-only).

**Effort:** S. **Depends on:** none.

---

### F3 — Save/load a full project (image + settings)
Today a session (image + all `Settings` + selected profiles/bands) is lost on refresh. Add a
"Save project" that serializes the *settings + profile ids + bands* (the image can be
re-attached on load) to a JSON file, and a "Load project". This reuses the existing
`Settings` type and `paint/model.ts` persistence primitives.

**Effort:** S–M. **Depends on:** F2 (profile round-trip).

---

### F4 — Eyedropper for filament profiles
(corrected) The profile editor already uses a native `<input type="color">`, which in Chromium
includes a screen eyedropper. What's missing is sampling from the *loaded image* (or the
swatch plate) at its true pixel values: reuse the already-decoded `srgb` array — no new decode
path.

**Effort:** S. **Depends on:** none.

---

## Stage 2 — medium, extend one of the three models

### F5 — Backlit *color* lithophane (combine litho body + a thin color-slab front)
Litho already computes a per-cell **color slab** (`colorSlabThickness`, `slabMaterials`) on
top of a neutral body. Today the color slab is limited by the small CMY/white preset set. A
"backlit color" mode that lets the user bring in **more** filaments (beyond 4) for the color
slab — reusing the existing combo enumeration (`buildSolver`) but with a larger filament set and the
same `bestCombo` search — would dramatically widen the reachable colors for backlit prints.
The math is already there; this is mainly UI (a larger preset set) and letting the solver run
with more candidates (with the existing 32³ LUT / combo caps to keep it bounded).

**Effort:** M. **Depends on:** none (I2 is now a small optional tidy-up).

---

### F6 — Multi-AMS / >4-slot painting & mosaic (the UI already half-suggests it)
The mosaic UI already shows a **slot 4 "over"** badge and text "needs more than one 4-slot
AMS", and painting bands already support up to `MAX_BANDS = 16`. Generalizing the *loadout*
beyond `AMS_SLOTS = 4` (painting already can, mosaic is capped) is a small, natural extension:
raise the cap, keep the dedupe/combo machinery, and surface the "spans multiple AMS prints"
warning that's already in the copy.

**Effort:** M. **Depends on:** none.

---

### F7 — Material-use / print-time estimator
The mosaic UI already reports **"nozzle moves"** and tile counts. Generalize a stats line to
all three modes: estimated filament mass (from per-material volume × density), layer count, and
a rough print-time bound. Reuse the existing mesh triangle/vertex counts and the per-band
thicknesses; it's an aggregation over data already computed at export.

**Effort:** S–M. **Depends on:** none (reads existing export data).

---

### F8 — More dithering options
Both litho and mosaic already use Floyd–Steinberg in Oklab with a ±0.06 clamp. Expose the
dither choice (FS on/off — already there — plus a **Bayer ordered** option and a
**no-dither / posterized** option) as a setting. The clamp logic already isolates the dither
pass, so adding an alternative error-diffusion kernel is local to `lithophane.ts` /
`mosaic.ts`.

**Effort:** S–M. **Depends on:** none.

---

## Stage 3 — large / ambitious

### F9 — A fourth optical mode: "translucent" (KM without a ground)
`paint/km.ts` already models scattering + absorption. A "translucent" mode where the filament
itself is the colorant over a *clear* substrate (no ground layer) would sit between litho
(backlit) and mosaic (frontlit + ground). The `stackOn` / `kmLayer` machinery is reusable;
this is a new *combination* of existing models plus a small new solver. This is the natural
home for "glow" prints that are neither a lithophane nor an opaque mosaic.

**Effort:** L. **Depends on:** F5 (larger filament sets).

---

### F10 — Comparison / A-B preview
Show two solves of the *same* image side by side (e.g. litho vs mosaic, or two loadouts) using
the existing isolated `Preview3D` (which is already decoupled from export and lazily imported).
This is a UI composition over existing preview infrastructure, and is very high-value for
deciding which mode a given photo suits.

**Effort:** M–L. **Depends on:** F7 (stats) for a useful comparison readout.

---

### F11 — Batch / queue export
Export a folder of images to multiple 3MFs, reusing the worker path (I1) so the main thread
stays live. The worker already isolates the heavy step; a queue around it is straightforward.
Keeps the app local-only (no upload).

**Effort:** M–L. **Depends on:** nothing left — I1 (litho in worker) and I9 (typed worker protocol) are done.

---

### F12 — i18n + accessibility pass
The UI strings are hardcoded English; accessibility (keyboard nav for the drag-reorder, ARIA
labels on sliders) is minimal. A localized, keyboard-complete UI would broaden the audience.
This is a cross-cutting effort, not a single module change.

**Effort:** L. **Depends on:** I4 (split `main.ts`) so strings live in one place.

---

## Roadmap map

| Stage | Features | Shared prerequisite |
| --- | --- | --- |
| 1 | F1 measure-TD-from-swatches · F2 profile portability · F3 save/load project · F4 eyedropper | — |
| 2 | F5 backlit-color · F6 multi-AMS · F7 stats estimator · F8 dither options | — |
| 3 | F9 translucent mode · F10 A-B preview · F11 batch export · F12 i18n/a11y | — (I1, I4, I9 done) |

**Suggested order:** F1 is the standout — it closes a loop the UI *already opens* with the
swatch plate, and it directly improves print accuracy, which is the whole reason the app
exists. F2/F3/F4 are cheap wins that make the app a tool people keep. Stage 2 items are the
"one more mode / one more slot" extensions the existing math was designed to absorb. Stage 3
is where the app grows into a studio.
