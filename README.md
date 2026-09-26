# LumiLayer

Browser app that turns a photo into a multi-color 3D print (up to 4 filaments) and exports a ready-to-slice **3MF**.
Everything runs locally in your browser. Your photos are never uploaded.

It has two families of output:

- **Lithophane (backlit)**: viewed with a light behind it.
- **Color relief / Flat color (front-lit)**: a color picture viewed under normal room light. Translucent filament layers
  stacked on an opaque base plate mix their colors, like HueForge-style prints. *Relief* lets the surface height follow
  the color stacks. *Flat* fills below the stacks so the top is level.

## How it works

### Lithophane

The print has two zones, and you look at it from the side that was on the bed:

1. **Color slab** (front, on the bed): a few thin layers (default 5 × 0.10 mm). Every pixel column stacks some layers of
   filaments 2–4 (e.g. cyan/magenta/yellow) and fills the rest with the base filament. The mix is picked per pixel to match
   the photo's hue, using a Beer–Lambert light transmission model.
2. **Body** (back): a classic base-filament lithophane whose thickness sets the brightness.

The **Backlit** preview simulates light passing through both zones. **Unlit** shows the front face with no backlight,
and **3D** shows the geometry.

### Front-lit (relief / flat)

Slot 1 is an opaque base plate. On top of it, each pixel column stacks some layers of filaments 2–4, **in slot order**,
with slot 4 on top. Each filament's run of layers covers what's below it, linearly with thickness, until it is fully
opaque at its TD (the HueForge convention). Photo lightness is mapped into the range the palette can print. Order
matters: put covering or dark filaments (e.g. charcoal) in later slots.

**Suggest palette for this photo** tries every base + ordered 3-color combination from a built-in list of common PLA
colors and picks the one that best matches the photo's main colors. Afterwards, set each filament's color and TD to
match your actual rolls.

### Controls

- **Mode**: lithophane, color relief or flat color.
- **Framing**: width, aspect, rotate, mirror, zoom/pan (drag and scroll on the preview), frame width and thickness.
- **Image**: brightness, contrast, gamma, saturation.
- **Depth & resolution**: min/max body thickness (lithophane), base plate layers (front-lit), pixel size, simplify
  tolerance (lithophane).
- **Color mixing**: number of color layers, layer height, color vs. tone priority, color cell size (size of each color dot,
  at least 0.3 mm because finer dots can't be printed and slow slicers down), dithering, filament presets, and each
  filament's color and *transmission distance* (TD). For lithophanes, TD is the thickness in mm at which about 10% of light
  gets through. For front-lit prints, it's the thickness that hides what's below.

## Printing

- The 3MF contains one object made of up to 4 parts: `Base` (slot 1) and `Color 1–3` (slots 2–4). Bambu Studio / Orca should
  pick up the slot assignment. In other slicers, assign the filaments per part yourself.
- Print **as exported** and don't rotate it. Use 100% infill.
- **Lithophane** (viewing face on the bed): set both the first layer height and the layer height to the color layer height
  (default 0.10 mm).
- **Front-lit** (viewing face up): set the layer height to the color layer height (default 0.08 mm). The first layer must be a
  whole multiple of it (e.g. 0.24 mm) and no thicker than the base plate. Otherwise every layer is offset from the color
  layers.

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
