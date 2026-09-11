import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@ws/core': r('./packages/core/src/index.ts'),
      '@ws/data': r('./packages/data/src/index.ts'),
      '@ws/sim': r('./packages/sim/src/index.ts'),
      '@ws/render': r('./packages/render/src/index.ts'),
    },
  },
  define: { __WS_DEV__: 'import.meta.env.DEV' },
  server: {
    // SharedArrayBuffer requires cross-origin isolation (DEC-020). Without
    // these headers the FieldStore silently falls back to non-shared buffers,
    // which is a supported configuration but a slower one — so the dev server
    // sets them and the HUD reports which path is live.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  build: { target: 'es2022', outDir: 'dist' },
});
