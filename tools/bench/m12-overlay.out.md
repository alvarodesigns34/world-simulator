# M12 scientific overlay budget

Intel(R) Xeon(R) Processor @ 2.80GHz, Node v22.22.2. 320x160 equirectangular.

| geodesic n | cells | first lookup BEFORE (ms) | first lookup NOW (ms) | cached refresh (ms) | continuous draw (ms) |
| --- | --- | --- | --- | --- | --- |
| n=2 | 162 | 23.9 | 9.451 | 0.06 | 0.332 |
| n=3 | 642 | 90.2 | 13.27 | 0.053 | 0.335 |
| n=4 | 2,562 | 344.9 | 23.547 | 0.053 | 0.336 |
| n=5 | 10,242 | 1,354.1 | 38.76 | 0.053 | 0.33 |
| n=6 | 40,962 | 5,423.1 | 70.335 | 0.056 | 0.292 |

Budget: **0.5 ms main thread** per frame.

## Reading these numbers

The three phases are measured separately because they cost completely
different amounts, and quoting one number for all three is how "the overlay
is fast" was asserted while its first build took a third of a second.

**Per-frame cost is what the 0.5 ms budget governs.** At the application default
(`climateN: 4`) a cached refresh is 0.053 ms and a full draw is 0.336 ms —
67% of budget. Both are inside it at every resolution measured.

**The first lookup is a one-off per grid**, not a per-frame cost, but it was
a visible main-thread stall: 345 ms at the default and 4.7 s at n=6.
It is now 23.547 ms, a 15x improvement, and the acceleration is exact —
`overlay-lookup.test.ts` requires it to return the identical table to the
exhaustive scan, pixel for pixel, across four raster shapes.

No GPU numbers appear here. The overlay is a 2D canvas on the main thread;
the GPU half of the M12 budget needs real timestamps on real hardware and is
Astra's to measure.
