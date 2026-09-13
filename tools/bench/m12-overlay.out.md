# M12 scientific overlay budget

AMD EPYC 9V74 80-Core Processor, Node v24.19.0. 320x160 equirectangular.

| geodesic n | cells | first lookup BEFORE (ms) | first lookup NOW (ms) | cached refresh (ms) | continuous draw (ms) |
| --- | --- | --- | --- | --- | --- |
| n=2 | 162 | 17.9 | 6.617 | 0.043 | 0.195 |
| n=3 | 642 | 70.4 | 9.747 | 0.043 | 0.196 |
| n=4 | 2,562 | 258.4 | 15.526 | 0.044 | 0.195 |
| n=5 | 10,242 | 1,004.4 | 28.175 | 0.044 | 0.196 |
| n=6 | 40,962 | 4,009.7 | 64.387 | 0.338 | 0.198 |

Budget: **0.5 ms main thread** per frame.

## Reading these numbers

The three phases are measured separately because they cost completely
different amounts, and quoting one number for all three is how "the overlay
is fast" was asserted while its first build took a third of a second.

**Per-frame cost is what the 0.5 ms budget governs.** At the application default
(`climateN: 4`) a cached refresh is 0.044 ms and a full draw is 0.195 ms —
39% of budget. Both are inside it at every resolution measured.

**The first lookup is a one-off per grid**, not a per-frame cost, but it was
a visible main-thread stall: 258 ms at the default and 4.7 s at n=6.
It is now 15.526 ms, a 17x improvement, and the acceleration is exact —
`overlay-lookup.test.ts` requires it to return the identical table to the
exhaustive scan, pixel for pixel, across four raster shapes.

No GPU numbers appear here. The overlay is a 2D canvas on the main thread;
the GPU half of the M12 budget needs real timestamps on real hardware and is
Astra's to measure.
