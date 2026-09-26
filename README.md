# LumiLayer

Browser app that turns a photo into a **multi-color lithophane** (up to 4 filaments) and exports a ready-to-slice **3MF**.
Everything runs locally in your browser. Your photos are never uploaded.

## How it works

The print has two zones, and you look at it from the side that was on the bed:

1. **Color slab** (front, on the bed): a few thin layers (default 5 × 0.10 mm). Every pixel column stacks some layers of
   filaments 2–4 (e.g. cyan/magenta/yellow) and fills the rest with the base filament. The mix is picked per pixel to match
   the photo's hue, using a Beer–Lambert light transmission model.
2. **Body** (back): a classic base-filament lithophane whose thickness sets the brightness.

The **Backlit** preview simulates light passing through both zones. **Unlit** shows the front face with no backlight,
and **3D** shows the geometry.

### Controls

- **Framing**: width, aspect, rotate, mirror, zoom/pan (drag and scroll on the preview), frame width and thickness.
- **Image**: brightness, contrast, gamma, saturation.
- **Depth & resolution**: min/max body thickness, pixel size, simplify tolerance (how much relief error is allowed when
  merging flat areas).
- **Color mixing**: number of color layers, layer height, color vs. tone priority, color cell size (size of each color dot,
  at least 0.3 mm because finer dots can't be printed and slow slicers down), dithering, filament presets, and each
  filament's color and *transmission distance* (TD: the thickness in mm at which about 10% of light gets through).

## Printing

- The 3MF contains one object made of up to 4 parts: `Base` (slot 1) and `Color 1–3` (slots 2–4). Bambu Studio / Orca should
  pick up the slot assignment. In other slicers, assign the filaments per part yourself.
- Print it **as exported (viewing face down)** and don't rotate it.
- Set **both the first layer height and the layer height** to the color layer height (default 0.10 mm), and use 100% infill.

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
