# E1 (partial) — patch size sweep

Host: Linux 6.12.8+ x64, 2 x Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz
Node: v22.23.2
Date: 2026-09-11

NO GPU IN THIS ENVIRONMENT. Rasterisation cost is NOT measured here.
These are the CPU-selection and arithmetic halves of E1.

| res | patch | tier | budget | tris/patch | max tris | px/tri | visible | visited | select ms | maxLvl |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1080p | 17x17 | discrete | 2025 | 512 | 1.04M | 2.00 | 85 | 286 | 0.640 | 12 |
| 1080p | 17x17 | integrated | 1417 | 512 | 0.73M | 2.86 | 85 | 286 | 0.394 | 12 |
| 1080p | 17x17 | floor | 911 | 512 | 0.47M | 4.45 | 85 | 286 | 0.386 | 12 |
| 1080p | 33x33 | discrete | 506 | 2048 | 1.04M | 2.00 | 85 | 286 | 0.389 | 12 |
| 1080p | 33x33 | integrated | 354 | 2048 | 0.72M | 2.86 | 85 | 286 | 0.394 | 12 |
| 1080p | 33x33 | floor | 227 | 2048 | 0.46M | 4.46 | 85 | 286 | 0.381 | 12 |
| 1080p | 65x65 | discrete | 126 | 8192 | 1.03M | 2.01 | 72 | 246 | 0.321 | 12 |
| 1080p | 65x65 | integrated | 88 | 8192 | 0.72M | 2.88 | 53 | 193 | 0.243 | 12 |
| 1080p | 65x65 | floor | 56 | 8192 | 0.46M | 4.52 | 37 | 165 | 0.250 | 12 |
| 1440p | 17x17 | discrete | 2048 | 512 | 1.05M | 3.52 | 105 | 315 | 0.480 | 12 |
| 1440p | 17x17 | integrated | 2048 | 512 | 1.05M | 3.52 | 105 | 315 | 0.427 | 12 |
| 1440p | 17x17 | floor | 1620 | 512 | 0.83M | 4.44 | 105 | 315 | 0.431 | 12 |
| 1440p | 33x33 | discrete | 900 | 2048 | 1.84M | 2.00 | 105 | 315 | 0.429 | 12 |
| 1440p | 33x33 | integrated | 630 | 2048 | 1.29M | 2.86 | 105 | 315 | 0.430 | 12 |
| 1440p | 33x33 | floor | 405 | 2048 | 0.83M | 4.44 | 105 | 315 | 0.428 | 12 |
| 1440p | 65x65 | discrete | 225 | 8192 | 1.84M | 2.00 | 105 | 315 | 0.482 | 12 |
| 1440p | 65x65 | integrated | 157 | 8192 | 1.29M | 2.87 | 87 | 250 | 0.356 | 12 |
| 1440p | 65x65 | floor | 101 | 8192 | 0.83M | 4.46 | 59 | 199 | 0.261 | 12 |
| 2160p | 17x17 | discrete | 2048 | 512 | 1.05M | 7.91 | 243 | 553 | 0.797 | 12 |
| 2160p | 17x17 | integrated | 2048 | 512 | 1.05M | 7.91 | 243 | 553 | 0.775 | 12 |
| 2160p | 17x17 | floor | 2048 | 512 | 1.05M | 7.91 | 243 | 553 | 0.771 | 12 |
| 2160p | 33x33 | discrete | 2025 | 2048 | 4.15M | 2.00 | 243 | 553 | 0.774 | 12 |
| 2160p | 33x33 | integrated | 1417 | 2048 | 2.90M | 2.86 | 243 | 553 | 0.767 | 12 |
| 2160p | 33x33 | floor | 911 | 2048 | 1.87M | 4.45 | 243 | 553 | 0.815 | 12 |
| 2160p | 65x65 | discrete | 506 | 8192 | 4.15M | 2.00 | 208 | 495 | 0.727 | 12 |
| 2160p | 65x65 | integrated | 354 | 8192 | 2.90M | 2.86 | 170 | 432 | 0.631 | 12 |
| 2160p | 65x65 | floor | 227 | 8192 | 1.86M | 4.46 | 123 | 307 | 0.420 | 12 |

## At 1440p, discrete tier

- **17x17**: 2048 patches, 1.05 M triangles at 3.52 px/tri; selection 0.480 ms (315 nodes visited)
- **33x33**: 900 patches, 1.84 M triangles at 2.00 px/tri; selection 0.429 ms (315 nodes visited)
- **65x65**: 225 patches, 1.84 M triangles at 2.00 px/tri; selection 0.482 ms (315 nodes visited)

## Reading

- All three sizes land at the same triangle budget, because DEC-032 derives
  the patch count from the pixel-area floor. A bigger patch buys fewer patches.
- The real difference is CPU: a smaller patch means MORE nodes to traverse and
  more instances to write, for the same triangles. That is the trade E1 must
  settle, and it needs the GPU half to be conclusive.
- The v0 configuration (65x65, 1000 patches) is absent from this table because
  resolvePatchBudget will not produce it: at 1440p it is 0.45 px/triangle.

## Decision — keep 33×33 (CPU half). GPU column still Astra.

Evidence, 1440p discrete, this host, pooled selector:

| size | budget patches | px/tri | select ms | why not the default |
| --- | ---: | ---: | ---: | --- |
| 17×17 | 2048 (capped) | **3.52** | 0.480 | Hits `maxVisiblePatches` before the pixel-area floor. τ=2.0 is not met. |
| 33×33 | 900 | **2.00** | **0.429** | Hits the floor. Fastest CPU of the three. |
| 65×65 | 225 | 2.00 | 0.482 | Same tris as 33, slower CPU. At 1080p discrete the budget is only 126 patches — undershoots orbital silhouette density. |

Default stays `QUALITY.patchVerticesPerSide = 33`. Revisit only if Astra's GPU
timestamps show 17 winning on fill-rate or 65 winning on draw-call overhead by
a margin that beats the 1080p density loss. Do not flip it on preference.

