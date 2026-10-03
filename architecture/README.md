# LumiLayer — Architecture & Engineering Review

A staff-level review of the LumiLayer codebase (a local-only browser app that turns a
photo into a multi-color 3D print and exports a slicer-ready 3MF). This folder is the
output of a full line-by-line read of every source file, the tests, the config, the CI,
and the documentation, with particular attention to the color and light mathematics.

**Baseline state at review time:** TypeScript 7 strict, Vite 8, `three` r186, `fflate`;
**31/31 unit tests passing** (solver, watertight-manifold meshes, 3MF package,
Kubelka–Munk, mosaic, Kd-tree, loadout suggestion).

**Revision 2 (after a second, source-verified pass):** several claims of the first pass were
corrected, and the four top findings were fixed — **32/32 tests passing**:

1. CPU and GPU painting height matching are pinned together: the shader takes `K_TD`,
   `TD_FLOOR` and `MATCH_TIE` from the TS modules, and a differential test compares them.
2. The painting **Backlit** view now uses the lithophane's `absorption()` instead of its own
   gamma-space formula, so every backlit view shares one optical model.
3. Litho export runs in the export worker, with the heavy-model `confirm` *between* mesh build
   and 3MF write.
4. The production build ships a Content Security Policy (`connect-src 'none'`,
   `worker-src 'self'`).

Items that were wrong in the first pass are marked **(corrected)** in place.

## Document index

| File | What it covers |
| --- | --- |
| [`01-architecture-overview.md`](01-architecture-overview.md) | System decomposition, the three print modes, process/thread model, dependency graph, and the notable design decisions. |
| [`02-color-and-light-models.md`](02-color-and-light-models.md) | The mathematics: color spaces, the three optical models (Beer–Lambert backlit / Beer–Lambert front-lit / Kubelka–Munk), TD conventions, and the color-matching objective functions. |
| [`03-data-flow.md`](03-data-flow.md) | End-to-end data flow per mode, the preview/export "same-formula" invariant, memory layout, and where each buffer lives. |
| [`04-module-map.md`](04-module-map.md) | File-by-file responsibility map, public APIs, invariants, and coupling notes. |

## Plans

| File | What it covers |
| --- | --- |
| [`improvement-plan.md`](improvement-plan.md) | Prioritized engineering improvements: performance, architecture, correctness consistency, and developer experience. |
| [`new-features-plan.md`](new-features-plan.md) | A staged roadmap of new features, ordered by value and risk, each grounded in the existing math. |
| [`vulnerability-mitigation-plan.md`](vulnerability-mitigation-plan.md) | Security posture assessment and a concrete mitigation plan (DoS/memory, storage, DOM, supply chain, CSP). |
| [`bug-fixes-plan.md`](bug-fixes-plan.md) | Concrete defects and latent bugs found in the read, each with root cause, reproduction, and a proposed fix. |

## How to read this

- If you only read one file, read **02** — the quality of the whole app hinges on the
  optics being both physically plausible and numerically stable, and the three print modes
  deliberately use *different* optical models (one shared model for every backlit view, a
  hiding model for front-lit painting, Kubelka–Munk for the mosaic).
- The **bug-fixes** and **improvement** documents reference the others; read
  `01` → `02` → `03` first, then the plans.

## Conventions used in these documents

- **Severity** for findings: 🔴 (defect that can produce a wrong print or crash),
  🟠 (consistency/perf issue that degrades results or UX), 🟡 (hygiene/robustness).
- Line references are to the file at review time and are approximate; prefer the symbol
  name over the line number.
- "TD" = transmission distance, the user-facing per-filament thickness parameter.
