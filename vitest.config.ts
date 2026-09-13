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
    /*
     * Threads, not forks. The RPC that was timing out (`onTaskUpdate`,
     * worker -> main, 5 s window) crosses a pipe with structured-clone
     * serialisation under the default fork pool; under the thread pool it is a
     * far cheaper postMessage on shared memory. Combined with the caps below
     * this is what actually stops a loaded runner missing the window.
     */
    pool: 'threads',
    /*
     * ON CI, TEST FILES RUN ONE AT A TIME.
     *
     * This project asserts WALL-CLOCK BUDGETS inside its test suite — the M4
     * climate step must fit 40 ms at n6, the LOD selection must fit its frame
     * slice, and so on. Those assertions are only meaningful if the process is
     * not competing with itself: under file parallelism the n6 step measured
     * 50.5 ms on a runner where it takes ~12 ms alone, and the number said
     * nothing about the code.
     *
     * Running files sequentially makes every budget assertion measure the thing
     * it names. It is STRICTER, not weaker — nothing is skipped, no threshold is
     * relaxed — and it also removes the worker/reporter contention that had been
     * failing the job after 537/537 passed.
     *
     * Locally the suite stays parallel: a developer wants the fast signal, and
     * the budget numbers that matter are the ones CI records.
     */
    fileParallelism: process.env.CI === undefined,
    maxWorkers: process.env.CI === undefined
      ? Math.max(1, (availableParallelism?.() ?? 4) - 1)
      : 1,
    /* Long-running suites need room to tear down under load. */
    teardownTimeout: 30_000,
    /*
     * THE REPORTER IS THE THING THAT TIMES OUT, so on CI it is made quiet.
     *
     * `onTaskUpdate` is a worker->main RPC with a 5 s window. The default
     * reporter prints a line per slow test and re-renders continuously, and on
     * a loaded runner that work on the main thread is what misses the window —
     * capping workers alone was not enough, and the same commit passed one run
     * and failed the next. The dot reporter cuts that traffic to almost
     * nothing.
     *
     * This changes only how results are PRINTED. Every test still runs and
     * every failure still fails the job; a failing run prints the full
     * diagnostics either way.
     */
    reporters: process.env.CI === undefined ? ['default'] : ['dot'],
  },
});
