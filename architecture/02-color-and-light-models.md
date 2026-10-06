# 02 — Color & Light Models (the mathematics)

This is the document to read if you want to understand *why* LumiLayer works, and where the
subtle numerical risk lives. Since revision 3 there are **two optical models**, one per kind of
filament data:

- **Lithophane presets** (in-memory, 10% TD convention): Beer–Lambert transmission.
- **Filament profiles** (painting + mosaic, persisted, 5% contrast TD convention):
  Kubelka–Munk two-flux, for every view — painting Front-lit, painting Backlit, mosaic.

> **History.** The first pass described three models and missed a fourth: painting front-lit
> used Beer–Lambert *hiding*, and its Backlit tab an ad-hoc `exp(−K_TD/TD·(1−sRGB)·d)` (white
> fully transparent). Revision 2 replaced the latter with the litho `absorption()`; revision 3
> (B5) moved all painting views onto the mosaic's KM model, so one profile TD now means one
> thing everywhere it is used.

## 1. Color spaces and shared primitives (`color.ts`)

All color math is done in **linear-light sRGB** unless stated otherwise; sRGB gamma is
applied only at the boundary (display, or the input image).

| Function | Definition | Notes |
| --- | --- | --- |
| `srgbToLinear` / `linearToSrgb` | The standard sRGB piecewise EOTF, thresholds 0.04045 / 0.0031308 | Correct per spec; the piecewise linear foot handles the 1/12.92 ramp. |
| `luminance` | `0.2126 r + 0.7152 g + 0.0722 b` (Rec. 709 / BT.709 on **linear** values) | Used in the litho solver and for "relative luminance → CIE L*". |
| `lightness` | CIE L\* normalized to 0..1 (the `116·cbrt(y) − 16` piece, linear below `216/24389`) | Correct L\* formula. |
| `linearToOklab` | Oklab from linear RGB, with cube-root of the LMS cone response | The perceptual space used for all color matching. |
| `absorption` | Beer–Lambert extinction coefficient of a filament (see §3) | Litho solver only (since rev. 3). |
| `TD_FLOOR` | `0.05` mm | Smallest TD any model uses; shared by `absorption` and the KM scattering solve. |

**Perceptual matching metric.** All three modes minimize a distance in **Oklab** where the
chroma axes are scaled by `sqrt(W)`. The weight differs by path:

- Litho: `wC = colorPriority` (user-set 0..4), so error = `dL² + wC·(da² + db²)`.
- Painting & mosaic: fixed `CHROMA_WEIGHT = 2`, applied as `·sqrt(2)` on the a,b axes
  (equivalently weight 2 on the squared chroma terms). This over-weights hue accuracy over
  lightness — a reasonable default for "does it look like the photo."

> The choice of Oklab (rather than Lab or HSV) is well-made: it is a modern perceptual space,
> is well-behaved near white/black, and its a/b axes are roughly aligned with hue, which is
> exactly what "match the color of a pixel" needs.

## 2. TD — two conventions, one per kind of filament data

| Where | Model | Meaning of 1 TD |
| --- | --- | --- |
| **Lithophane** presets | Beer–Lambert extinction (`absorption`) | `SCATTER = ln(10)` of achromatic extinction → **10%** of *that channel's* light left |
| **Filament profiles**: painting Front-lit, painting Backlit, mosaic | Kubelka–Munk (`paint/km.ts`) | scattering S solved so the white-vs-black background contrast after 1 TD is `TD_CONTRAST = 5%` (most transparent channel) |

**B5 (fixed in rev. 3).** Painting and mosaic share the stored profiles, but used to read the
same TD through different models (Beer–Lambert hiding vs KM), and the painting Backlit view
through a third (litho `absorption`, 10%). Now each profile's TD is turned into KM constants
once (`filamentOptics` → per-layer `r`, `t`), and every profile-based view uses them. Tested:
a painting band stack prints the same color as the same mosaic combo, and one TD of a painting
band leaves exactly `TD_CONTRAST` of the background.

Lithophane presets keep their own Beer–Lambert model and 10% reading: they are separate data
(in memory, never shared with profiles), and the litho solver's closed-form body-thickness
inversion depends on Beer–Lambert. Moving litho to KM would be a separate, larger change.

## 3. The three optical models, in math

### 3.1 Lithophane — Beer–Lambert transmission (backlit)

A backlit print transmits light through a stack of layers. Per channel, transmittance of a
stack is `T = Πᵢ exp(−αᵢ dᵢ)` where `αᵢ` is the per-mm extinction of filament *i* and
`dᵢ` its thickness.

**Absorption coefficient** (`absorption`, `color.ts`):

```
α(c) = ( SCATTER + CHROMA_GAIN · ( −ln( max(linear(c), 0.005) ) ) ) / TD
SCATTER = ln(10)  ≈ 2.3026   → an achromatic extinction of ln(10)/TD, i.e. 10% left at d = TD
CHROMA_GAIN = 4             → extra extinction in channels the filament color lacks
```

Interpretation: every filament has a *baseline* scattering extinction (`ln(10)/TD`, giving the
10%-at-TD convention) plus an *extra* extinction proportional to how little of that channel the
filament contains (a red filament has large `−ln(linear g)`, so green is strongly extinguished).
The `max(…, 0.005)` floor prevents `−ln(0) = ∞` for a pure channel.

**Target luminance** (`targetFor`): for a pixel of linear RGB, take its luminance `y`, map to a
target *relative* transmission via CIE L\*:

```
y_t = exp( (1 − L*(y)) · ln(Smin) )
```

where `Smin = exp(−(maxThickness − minThickness)·a0Y)` is the minimum transmission the body can
produce and `a0Y` is the base filament's luminance-weighted extinction. This makes *perceived*
tone (L\*) map linearly onto body thickness — a genuinely correct choice for a lithophane, since
the eye's brightness perception is logarithmic.

**Combo selection** (`bestCombo`): a neutral base body scales linear RGB by a constant `s`,
and Oklab of a scaled linear color is the original Oklab scaled by `cbrt(s)`. So for a
candidate combo of transmission luminance `lum_c`, once the body is set to hit `y_t`, the
combo's Oklab becomes `f · lab_c` with `f = clamp(cbrt(y_t) / cbrt(lum_c), fmin, 1)`. The solver
picks the combo minimizing `dL² + wC·(da²+db²)` of `f·lab_c` against the target Oklab. This is
cheap (a scalar scale) and *exactly* the right reduction — the key mathematical move that makes
litho solving fast.

**Body thickness** (pass 2, per pixel): given the cell's combo transmittance `lum_combo`, the
body thickness `t` is solved so total transmission hits `y_t`:

```
s = clamp( y_t / lum_combo, Smin, 1 )
t = min( maxThickness,  minThickness − ln(s) / a0Y )
```

This is the closed-form inversion of Beer–Lambert — no search, no iteration. Clean.

### 3.2 Filament painting — Kubelka–Munk, one layer at a time (since rev. 3)

Each band's filament is reduced to the KM reflectance `r` and transmittance `t` of **one
layer** (`oneLayer` in `optics.ts`, from `filamentOptics` in `km.ts`; cached per color/TD/layer
height). Walking up the stack one layer at a time over black:

```
R ← r + t²·R / (1 − r·R)        reflectance seen from the top (front-lit color)
T ← T·t / (1 − r·R_old)          transmittance (Backlit view), using R before the update
```

This is the standard KM composition (exact for stacked identical sub-layers), so n layers of a
band give the same result as the mosaic's n-layer tables. A translucent band *filters* what is
below (translucent red over white prints a clean red) instead of fading toward its own color,
which changes what Suggest picks: on a black/red/white test image it now prefers
black → white → red over black → red → white.

(Before rev. 3: Beer–Lambert *hiding*, `mix(layerColor, below, exp(−K_TD/TD·d))` with
`K_TD = −ln 0.05`. Same 5% reading at exactly 1 TD, but no filtering, a different curve, and
a different model from the mosaic and from its own Backlit view.)

- **Preview (`paint/preview.ts`):** the fragment shader implements exactly this in display
  mode (front-lit `R`, backlit `T`) and in read-back mode (`matchLayers`). It receives
  `u_layerR` / `u_layerT` per band from the same `oneLayer` the CPU uses; `MATCH_TIE` is
  interpolated into the GLSL source.
- **CPU mirror (`optics.ts`):** `pathLabs` walks the same recurrence to build the
  height→Oklab path used by `bestLayer`, by the no-WebGL fallback in
  `PaintController.heights()`, and by `suggest`. The two implementations are pinned by a
  **differential test** (`CPU height matching picks the same layer as the preview shader`)
  that ports `matchLayers` statement-for-statement and compares 480 random pixel/stack cases.
- **Ties:** when a saturated band repeats the same color over several heights, the errors are
  equal up to float noise, so the two paths could pick different heights. Both treat errors
  within `MATCH_TIE = 1e-6` (≈ ΔE 0.001) as ties that go to the lower height.

### 3.3 Mosaic — Kubelka–Munk two-flux (front-lit)

KM is the more physically honest model: light is both *absorbed* and *scattered* by the
material, and scattering is what makes a thin translucent layer *filter* the background rather
than merely hide it.

Per channel, define `a` and `b` from the filament's reflectance-at-infinite-thickness `R∞`:

```
a = 1 + ((1 − R∞)²) / (2 R∞)
b = sqrt(a² − 1)
```

The reflectance `R` and transmittance `T` of a slab of optical thickness `S·d` are the exact
two-flux solutions (`kmLayer`):

```
u   = exp(−2 x),  x = b·S·d
den = a(1 − u) + b(1 + u)
R   = (1 − u) / den
T   = (2 b exp(−x)) / den
```

This form is **stable for any S·d ≥ 0** (unlike the infinite geometric series, which
diverges or oscillates for large slabs) — a deliberate and correct choice, and there is a
unit test asserting a thick slab converges to the filament color.

**Stacking** (`stackOn`): put `t` layers of filament on a background of reflectance `below`:

```
below' = R + (T² · below) / (1 − R · below)
```

This is the standard KM composition (a reflectance plus the background seen through a slab).
Note the `(1 − R·below)` denominator — this is why a translucent red over white looks red, and
over yellow looks orange-red (it *filters*), which the test `makes translucent filaments act
as filters` explicitly checks.

**TD → scattering** (`scatteringFor`): KM's K/S ratio is fixed by color; the scattering `S` is
free and is set so that the background *contrast* (the white-vs-black difference) after 1 TD
equals `TD_CONTRAST = 0.05`. Since contrast falls monotonically with S·d, it's solved by a
**60-step bisection in log space** over `S·d ∈ [1e−4, 1e4]`, then `S = (S·d at TD)/TD`. This is
the only place a numerical solver appears, and it's done sensibly (bounded, monotone, log
space, 60 iterations → far below float precision).

## 4. Color-matching objective functions

All three modes boil down to "pick the option that minimizes a chroma-weighted Oklab distance":

- **Litho** — per color cell, pick combo (search over enumerated combos) at the brightness the
  body will provide; then per pixel, set body thickness in closed form. Dithering =
  Floyd–Steinberg in Oklab, clamped to ±0.06 per channel so out-of-gamut targets don't smear.
- **Painting** — per pixel, pick the *height* (layer index) whose `pathLabs` entry is closest
  to the pixel's Oklab. Computed on the GPU for preview/export; mirrored on the CPU for
  suggestion.
- **Mosaic** — per tile, pick the *combo* from a k-d tree of the deduplicated combo Oklabs;
  dithering = Floyd–Steinberg in Oklab (same clamp); then small-island merging rewrites tiny
  regions to their nearest neighbor combo to avoid sub-nozzle artifacts.

The k-d tree (`KdTree` in `mosaic.ts`) is a hand-rolled, implicit quickselect-based structure
over an index permutation — no dynamic allocation during query, and there is a test that it
finds the true nearest neighbor against brute force for random points. Good.

## 5. Numerical-robustness checklist (what's done right)

- sRGB EOTF piecewise-linear foot and 0.0031308 threshold — correct.
- `Math.max(linear, 0.005)` floor before `−ln` in `absorption` — prevents `∞`.
- KM closed-form `kmLayer` valid for all S·d ≥ 0 — no series divergence.
- TD→S via log-space bisection — bounded and monotone.
- All per-pixel loops use `Float32Array` / typed views — no GC churn in hot paths.
- Dithering error is clamped in both litho and mosaic — prevents runaway error diffusion.
- LUT and combo caches are quantized to small grids (32³, 64³) — bounded memory.

## 6. Numerical-robustness risks (see bug-fixes-plan)

- ~~**Two implementations of the painting recurrence** (GPU shader + `optics.ts`) with no test.~~
  **Fixed (rev. 2):** shared constants + differential test + `MATCH_TIE` (see §3.2). The GLSL
  and TS are still two implementations; the test is what keeps them together.
- ~~**TD meaning differs by model** for the same stored value.~~ Fixed in rev. 3 (B5): all
  profile-based views use one KM model; only litho presets keep their own convention (§2).
- **`hexToRgb` falls back to white on parse failure** (`color.ts`). (corrected) This path is
  not reachable from the UI today: litho colors come from valid presets or
  `<input type="color">` (always `#rrggbb`), and stored profiles are validated by
  `sanitizeProfile`. The duplicate parser in `preview.ts` that fell back to *black* was removed
  in revision 2.
- **Brightness helpers (fixed in rev. 3):** `color.ts` now has exactly two — `luminance()`
  (Rec. 709 on *linear* values; the litho solver) and `luma()` / `hexLuma()` (Rec. 709 on
  *gamma-encoded* sRGB, clamped; the painting/mosaic heightmap, `imaging.adjust` saturation,
  `defaultLoadout`, `swatchRows`, `isLight`). The inlined copies and `lumaOf` are gone. The one
  behavior change: desaturation used BT.601 (`0.299/0.587/0.114`) and now uses Rec. 709, so
  `saturation = 0` lands on the same gray the heightmap reads.
- **Chroma weight mismatch:** painting/mosaic use `CHROMA_WEIGHT = 2` (a²+b² scaled by 2),
  litho uses `colorPriority` (default 1). Not a bug, but the "color match" feel differs
  between modes for the same photo — worth documenting.
