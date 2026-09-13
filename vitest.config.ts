import { defineConfig } from 'vitest/config';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@ws/core': r('./packages/core/src/index.ts'),
      '@ws/data': r('./packages/data/src/index.ts'),
      '@ws/sim': r('./packages/sim/src/index.ts'),
      '@ws/render': r('./packages/render/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    /*
     * WORKER COUNT IS CAPPED BECAUSE THE REPORTER SHARES THE CPU.
     *
     * M8-M10 added several multi-second CPU-bound suites (the M1-M10
     * integration run alone is ~42 s of solid arithmetic). With one fork per
     * core on a 2-core CI runner, every worker saturates its core and the main
     * thread cannot service the reporter RPC inside its 5 s window. The run
     * then fails with `[vitest-worker]: Timeout calling "onTaskUpdate"` AFTER
     * reporting 537/537 passed — an infrastructure failure that looks like a
     * test failure and is not one.
     *
     * Leaving a core free for the reporter fixes it without weakening a single
     * assertion. Locally, where there are more cores, this is not binding.
     */
    maxWorkers: Math.max(1, (availableParallelism?.() ?? 4) - 1),
    /* Long-running suites need room to tear down under load. */
    teardownTimeout: 30_000,
  },
});
