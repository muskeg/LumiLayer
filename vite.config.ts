import { defineConfig } from 'vite';

// Relative base so the build works under any GitHub Pages sub-path.
export default defineConfig({
  base: './',
  // three.js is split into a lazily loaded chunk for the 3D tab.
  build: { chunkSizeWarningLimit: 700 },
});
