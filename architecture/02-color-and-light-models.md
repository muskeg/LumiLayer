# 02 — Color & Light Models (the mathematics)

This is the document to read if you want to understand *why* LumiLayer works, and where the
subtle numerical risk lives. There are **three distinct optical models** in the codebase —
Beer–Lambert transmission for every backlit view, Beer–Lambert hiding for front-lit painting,
Kubelka–Munk for the mosaic — and a different TD reading tied to each. Getting these straight is
the whole game.

> **(corrected)** The first pass missed that the painting mode's **Backlit** tab used a
> fourth, ad-hoc model (`exp(−K_TD/TD·(1−sRGB)·d)`: gamma-space absorption, white filament
> fully transparent). Revision 2 replaced it with the litho `absorption()`.

## 1. Color spaces and shared primitives (`color.ts`)

All color math is done in **linear-light sRGB** unless stated otherwise; sRGB gamma is
applied only at the boundary (display, or the input image).

| Function | Definition | Notes |
| --- | --- | --- |
| `srgbToLinear` / `linearToSrgb` | The standard sRGB piecewise EOTF, thresholds 0.04045 / 0.0031308 | Correct per spec; the piecewise linear foot handles the 1/12.92 ramp. |
| `luminance` | `0.2126 r + 0.7152 g + 0.0722 b` (Rec. 709 / BT.709 on **linear** values) | Used in the litho solver and for "relative luminance → CIE L*". |
| `lightness` | CIE L\* normalized to 0..1 (the `116·cbrt(y) − 16` piece, linear below `216/24389`) | Correct L\* formula. |
| `linearToOklab` | Oklab from linear RGB, with cube-root of the LMS cone response | The perceptual space used for all color matching. |
| `absorption` | Beer–Lambert extinction coefficient of a filament (see §3) | Litho solver and the painting Backlit view. |
| `TD_FLOOR` | `0.05` mm | Smallest TD any model uses; shared by `absorption`, `optics.ts` and the shader. |

**Perceptual matching metric.** All three modes minimize a distance in **Oklab** where the
chroma axes are scaled by `sqrt(W)`. The weight differs by path:

- Litho: `wC = colorPriority` (user-set 0..4), so error = `dL² + wC·(da² + db²)`.
- Painting & mosaic: fixed `CHROMA_WEIGHT = 2`, applied as `·sqrt(2)` on the a,b axes
  (equivalently weight 2 on the squared chroma terms). This over-weights hue accuracy over
  lightness — a reasonable default for "does it look like the photo."

> The choice of Oklab (rather than Lab or HSV) is well-made: it is a modern perceptual space,
> is well-behaved near white/black, and its a/b axes are roughly aligned with hue, which is
> exactly what "match the color of a pixel" needs.

## 2. TD — different meanings of the *same slider*

This is the single most confusing aspect of the app and the most likely source of
user-facing surprises. The user sets one "TD (mm)" per filament, but each model interprets it
differently:

| Where | Model | Meaning of 1 TD | Residual after 1 TD |
| --- | --- | --- | --- |
| **Lithophane** and **painting Backlit view** | Beer–Lambert extinction (`absorption`) | `SCATTER = ln(10)` of achromatic extinction → **10%** of *that channel's* light left | **10%** transmission |
| **Painting (front-lit)** | Beer–Lambert hiding | `K_TD = −ln(0.05)` of layer-hiding → **5%** of what's *below* still shows | **5%** of the background |
| **Mosaic** | Kubelka–Munk | scattering S solved so background *contrast* after 1 TD = `TD_CONTRAST` | **5%** of the background *contrast* |

**Where it actually bites (corrected):** litho filaments are in-memory presets edited with
their own inputs and are *not* shared with the paint/mosaic profiles, so "tune in litho, reuse
in paint" requires the user to retype the value. The real overlap is **painting vs mosaic**:
both read the *same stored profile TD*, through different models (hiding vs KM contrast), so
one number predicts two slightly different looks. Since revision 2 a profile TD is also read by
the painting Backlit view with the 10% convention.

The right long-term fix is *not* a `tdConvention` field on the filament type (the first pass
proposed that): TD is a measured property of the filament, the convention belongs to each
model. Each model should derive its constants from one physical TD.

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

### 3.2 Filament painting — Beer–Lambert layer-hiding (front-lit)

Front-lit, each layer *hides* what's below. Walking up the stack, the visible color at layer
top is:

```
c_visible = mix( layerColor, colorBelow, exp( −k · d ) ),   k = K_TD / TD,  K_TD = −ln(0.05)
```

i.e. after 1 TD of the filament, only 5% of the background color remains; the rest is the
layer's own color. This is a *two-state* (reflect + hide) model — simpler than KM, and adequate
for a stack where each band is a single color.

- **Preview (`paint/preview.ts`):** the fragment shader implements exactly this, both in
  "display" mode and in "read back layer counts" mode (`matchLayers`). Its `K_TD`, `TD_FLOOR`
  and `MATCH_TIE` constants are **interpolated into the GLSL source from `optics.ts` /
  `color.ts`** (revision 2; before, `K_TD` was hard-coded and the TD floor was `1e-3` in GLSL vs
  `0.05` on the CPU).
- **CPU mirror (`optics.ts`):** `pathLabs` walks the same recurrence to build the
  height→Oklab path used by `bestLayer`, by the no-WebGL fallback in
  `PaintController.heights()`, and by `suggest`. The two implementations are pinned by a
  **differential test** (`CPU height matching picks the same layer as the preview shader`)
  that ports `matchLayers` statement-for-statement and compares 480 random pixel/stack cases.
- **Ties:** that test found real divergences. When a saturated band repeats the same color
  over several heights, the errors are equal up to float noise (float32 storage on the CPU,
  float32 math on the GPU), so the two paths picked different heights. Both now treat errors
  within `MATCH_TIE = 1e-6` (≈ ΔE 0.001) as ties that go to the lower height.
- **Backlit view:** `u_mode == 0` multiplies by `exp(−absorption·d)` per band, with
  `absorption()` computed on the CPU and uploaded as `u_filamentAbs`. Same model as the litho
  solver.

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
- **TD meaning differs by model** for the same stored value; the painting-vs-mosaic overlap is
  the one users meet (see §2).
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
