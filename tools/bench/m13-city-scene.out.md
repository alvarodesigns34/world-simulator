# M13 city render preparation

Intel(R) Xeon(R) Processor @ 2.80GHz, Node v22.22.2.
Real M9 layouts; the measured work is `buildCityScene` alone — LOD choice,
camera-relative transform, instancing and the nearest-first building cap.
Buffer reused across frames, so a steady state allocates nothing.

| population | radius | tier | layout buildings | instances | drawn buildings | capped | upload | ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 200,000 | 2.8 km | aggregate | 0 | 1 | 0 | 0 | 0.00 MB | 0.01 |
| 200,000 | 2.8 km | arterial | 0 | 321 | 0 | 0 | 0.03 MB | 0.32 |
| 200,000 | 2.8 km | street | 0 | 2,045 | 0 | 0 | 0.16 MB | 2.03 |
| 200,000 | 2.8 km | building | 87,369 | 42,045 | 40,000 | 47,369 | 3.36 MB | 4.79 |
| 1,000,000 | 7.6 km | aggregate | 0 | 1 | 0 | 0 | 0.00 MB | 0.00 |
| 1,000,000 | 7.6 km | arterial | 0 | 336 | 0 | 0 | 0.03 MB | 0.22 |
| 1,000,000 | 7.6 km | street | 0 | 13,890 | 0 | 0 | 1.11 MB | 1.09 |
| 1,000,000 | 7.6 km | building | 477,625 | 53,890 | 40,000 | 437,625 | 4.31 MB | 7.93 |
| 8,000,000 | 24.9 km | aggregate | 0 | 1 | 0 | 0 | 0.00 MB | 0.00 |
| 8,000,000 | 24.9 km | arterial | 0 | 336 | 0 | 0 | 0.03 MB | 0.02 |
| 8,000,000 | 24.9 km | street | 0 | 14,144 | 0 | 0 | 1.13 MB | 1.01 |
| 8,000,000 | 24.9 km | building | 598,146 | 54,144 | 40,000 | 558,146 | 4.33 MB | 7.97 |

## Verdict

Worst case 7.97 ms (building tier, 8,000,000 people),
54,144 instances and 4.33 MB uploaded.

Inside a 16.7 ms frame with room for the terrain pass.

The `capped` column is the honesty column: those buildings exist in the
city and are not drawn. The city is unchanged; the frame is a sample of it.
