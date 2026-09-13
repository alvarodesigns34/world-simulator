# M13 city render preparation

AMD EPYC 9V74 80-Core Processor, Node v24.19.0.
Real M9 layouts; the measured work is `buildCityScene` alone — LOD choice,
camera-relative transform, instancing and the nearest-first building cap.
Buffer reused across frames, so a steady state allocates nothing.

| population | radius | tier | layout buildings | instances | drawn buildings | capped | upload | ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 200,000 | 2.8 km | aggregate | 0 | 1 | 0 | 0 | 0.00 MB | 0.01 |
| 200,000 | 2.8 km | arterial | 0 | 321 | 0 | 0 | 0.03 MB | 0.26 |
| 200,000 | 2.8 km | street | 0 | 2,045 | 0 | 0 | 0.16 MB | 0.39 |
| 200,000 | 2.8 km | building | 87,369 | 42,045 | 40,000 | 47,369 | 3.36 MB | 4.27 |
| 1,000,000 | 7.6 km | aggregate | 0 | 1 | 0 | 0 | 0.00 MB | 0.00 |
| 1,000,000 | 7.6 km | arterial | 0 | 336 | 0 | 0 | 0.03 MB | 0.03 |
| 1,000,000 | 7.6 km | street | 0 | 13,890 | 0 | 0 | 1.11 MB | 1.42 |
| 1,000,000 | 7.6 km | building | 477,625 | 53,890 | 40,000 | 437,625 | 4.31 MB | 5.51 |
| 8,000,000 | 24.9 km | aggregate | 0 | 1 | 0 | 0 | 0.00 MB | 0.00 |
| 8,000,000 | 24.9 km | arterial | 0 | 336 | 0 | 0 | 0.03 MB | 0.02 |
| 8,000,000 | 24.9 km | street | 0 | 14,144 | 0 | 0 | 1.13 MB | 0.82 |
| 8,000,000 | 24.9 km | building | 598,146 | 54,144 | 40,000 | 558,146 | 4.33 MB | 5.62 |

## Verdict

Worst case 5.62 ms (building tier, 8,000,000 people),
54,144 instances and 4.33 MB uploaded.

Inside a 16.7 ms frame with room for the terrain pass.

The `capped` column is the honesty column: those buildings exist in the
city and are not drawn. The city is unchanged; the frame is a sample of it.
