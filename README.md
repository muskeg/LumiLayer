# LumiLayer

A free, open-source browser app that turns a photo into a multi-color 3D print and exports a ready-to-slice **3MF**.
Everything runs locally in your browser. Your photos are never uploaded.

Two modes:

- **Lithophane (backlit)**: viewed with a light behind it, with an optional thin CMY-style color slab.
- **Filament painting (front-lit)**: a HueForge-style relief. Height comes from image brightness, and each height band
  is printed in one filament, so the colors come from how the translucent layers stack.

## How it works

### Lithophane

The print has two zones, and you look at it from the side that was on the bed:

1. **Color slab** (front, on the bed): a few thin layers (default 5 × 0.10 mm). Every pixel column stacks some layers of
   filaments 2–4 (e.g. cyan/magenta/yellow) and fills the rest with the base filament. The mix is picked per pixel to match
   the photo's hue, using a Beer–Lambert light transmission model.
2. **Body** (back): a classic base-filament lithophane whose thickness sets the brightness.

### Filament painting

- **Heights**:
  - **Best color match** (default): each pixel gets the height whose printed color (per the stack) is closest to the
    pixel's color. The GPU computes this per pixel, and the export reads the exact heights back from the shader.
  - **From brightness** (classic HueForge): `minHeight + luminance × (stackTop − minHeight)`, rounded to whole layers,
    optionally inverted.
- **Layer stack**: bands from the bed up (e.g. Black 0–0.64 mm, Red 0.64–0.96 mm, …, White). Sliders move a band's top;
  drag ⠿ (or focus it and use ↑/↓) to reorder filaments. The same filament may appear in several bands. Each band shows
  its AMS slot (a red outline means the stack needs more than 4 slots).
- **Suggest stack for this image**: searches your filament profiles for the best ordered set of up to **4** filaments (one
  AMS). It then optimizes the band heights and the total height, scoring each candidate against the image's main colors
  with the same optics and height assignment as the preview. It picks the simpler stack (fewer filaments, lower) when
  it's nearly as good, never uses two near-identical colors, and cuts heights no pixel uses.
- **Filament profiles**: name, color and TD (0.1–20 mm), saved in your browser's localStorage.
- **Optics** (WebGL2 fragment shader, updates at display refresh rate while you drag):
  - **Front-lit**: each layer hides what's below it following Beer–Lambert. After one TD of thickness, 5% of what's below
    still shows through (`T = exp(−(−ln 0.05)/TD · d)`), and the layer shows its own color.
  - **Backlit**: per-channel Beer–Lambert extinction, `I = I₀ · Π exp(−αᵢ·dᵢ)` with `αᵢ = −ln(0.05)/TDᵢ · (1 − colorᵢ)`.
- **Export**: a Web Worker builds one closed, manifold part per filament, clipped to that filament's Z bands. It packs them
  into a 3MF with `basematerials`, one component per part, and Bambu/Orca slot assignments. Each printed layer contains
  exactly one filament, so the slicer only swaps at band boundaries.

### Controls

- **Mode**: lithophane or filament painting.
- **Framing**: width, aspect, rotate, mirror, zoom/pan (drag and scroll on the preview), frame width and height.
- **Image**: brightness, contrast, gamma (and saturation for lithophanes).
- **Depth & resolution**: min/max body thickness (lithophane); minimum height and invert (painting); layer height; pixel
  size; simplify tolerance (lithophane).
- **Color mixing** (lithophane): color layers, color vs. tone priority, color cell size (0.3 mm minimum), dithering,
  filament presets. Here TD is the thickness at which ~10% of light gets through.
- **Layer stack** and **Filaments** (painting): see above.

## Printing

- The 3MF contains one object made of one part per filament. Bambu Studio / Orca pick up the slot assignment (part *n* →
  filament *n*). In other slicers, assign the filaments per part yourself.
- Print **as exported** and don't rotate it. Use 100% infill.
- **Lithophane** (viewing face on the bed): set both the first layer height and the layer height to the color layer height
  (default 0.10 mm).
- **Filament painting** (viewing face up): set the layer height to the painting's layer height (default 0.08 mm). The
  first layer must be a whole multiple of it (e.g. 0.24 mm). Otherwise every layer is offset from the bands.

## Development

```bash
npm install
npm run dev     # local dev server
npm test        # unit tests (solver, watertight meshes, 3MF package)
npm run build   # production build in dist/
```

## Deployment

`.github/workflows/deploy.yml` builds, tests and publishes to GitHub Pages on every push to `main`.
To turn it on once, go to **Settings → Pages → Build and deployment → Source: GitHub Actions**.
