import { defineConfig } from 'vite';

// Enforces "local only": no network (connect-src 'none'), and workers only from our own files.
// Build only: the dev server needs inline styles and its HMR WebSocket.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

// Relative base so the build works under any GitHub Pages sub-path.
export default defineConfig({
  base: './',
  // three.js is split into a lazily loaded chunk for the 3D tab.
  build: { chunkSizeWarningLimit: 700 },
  plugins: [
    {
      name: 'csp',
      apply: 'build',
      transformIndexHtml: () => [
        { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' },
      ],
    },
  ],
});
