# E1 (partial) — patch size sweep

Host: Linux 6.18.44-fc-v24 x64, 4 x Intel(R) Xeon(R) Processor @ 2.10GHz
Node: v22.22.2
Date: 2026-09-11

NO GPU IN THIS ENVIRONMENT. Rasterisation cost is NOT measured here.
These are the CPU-selection and arithmetic halves of E1.

| res | patch | tier | budget | tris/patch | max tris | px/tri | visible | visited | select ms | maxLvl |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1080p | 17x17 | discrete | 2025 | 512 | 1.04M | 2.00 | 85 | 286 | 0.918 | 12 |
| 1080p | 17x17 | integrated | 1417 | 512 | 0.73M | 2.86 | 85 | 286 | 0.660 | 12 |
| 1080p | 17x17 | floor | 911 | 512 | 0.47M | 4.45 | 85 | 286 | 0.656 | 12 |
| 1080p | 33x33 | discrete | 506 | 2048 | 1.04M | 2.00 | 85 | 286 | 0.665 | 12 |
| 1080p | 33x33 | integrated | 354 | 2048 | 0.72M | 2.86 | 85 | 286 | 0.652 | 12 |
| 1080p | 33x33 | floor | 227 | 2048 | 0.46M | 4.46 | 85 | 286 | 0.649 | 12 |
| 1080p | 65x65 | discrete | 126 | 8192 | 1.03M | 2.01 | 73 | 252 | 0.688 | 12 |
| 1080p | 65x65 | integrated | 88 | 8192 | 0.72M | 2.88 | 54 | 195 | 0.479 | 12 |
| 1080p | 65x65 | floor | 56 | 8192 | 0.46M | 4.52 | 38 | 167 | 0.388 | 12 |
| 1440p | 17x17 | discrete | 2048 | 512 | 1.05M | 3.52 | 105 | 315 | 0.764 | 12 |
| 1440p | 17x17 | integrated | 2048 | 512 | 1.05M | 3.52 | 105 | 315 | 0.793 | 12 |
| 1440p | 17x17 | floor | 1620 | 512 | 0.83M | 4.44 | 105 | 315 | 0.760 | 12 |
| 1440p | 33x33 | discrete | 900 | 2048 | 1.84M | 2.00 | 105 | 315 | 0.776 | 12 |
| 1440p | 33x33 | integrated | 630 | 2048 | 1.29M | 2.86 | 105 | 315 | 0.784 | 12 |
| 1440p | 33x33 | floor | 405 | 2048 | 0.83M | 4.44 | 105 | 315 | 0.873 | 12 |
| 1440p | 65x65 | discrete | 225 | 8192 | 1.84M | 2.00 | 105 | 315 | 1.040 | 12 |
| 1440p | 65x65 | integrated | 157 | 8192 | 1.29M | 2.87 | 88 | 252 | 0.721 | 12 |
| 1440p | 65x65 | floor | 101 | 8192 | 0.83M | 4.46 | 60 | 201 | 0.505 | 12 |
| 2160p | 17x17 | discrete | 2048 | 512 | 1.05M | 7.91 | 243 | 553 | 1.539 | 12 |
| 2160p | 17x17 | integrated | 2048 | 512 | 1.05M | 7.91 | 243 | 553 | 1.483 | 12 |
| 2160p | 17x17 | floor | 2048 | 512 | 1.05M | 7.91 | 243 | 553 | 1.396 | 12 |
| 2160p | 33x33 | discrete | 2025 | 2048 | 4.15M | 2.00 | 243 | 553 | 1.403 | 12 |
| 2160p | 33x33 | integrated | 1417 | 2048 | 2.90M | 2.86 | 243 | 553 | 1.522 | 12 |
| 2160p | 33x33 | floor | 911 | 2048 | 1.87M | 4.45 | 243 | 553 | 1.389 | 12 |
| 2160p | 65x65 | discrete | 506 | 8192 | 4.15M | 2.00 | 208 | 496 | 1.212 | 12 |
| 2160p | 65x65 | integrated | 354 | 8192 | 2.90M | 2.86 | 170 | 433 | 1.028 | 12 |
| 2160p | 65x65 | floor | 227 | 8192 | 1.86M | 4.46 | 124 | 309 | 0.714 | 12 |

## At 1440p, discrete tier

- **17x17**: 2048 patches, 1.05 M triangles at 3.52 px/tri; selection 0.764 ms (315 nodes visited)
- **33x33**: 900 patches, 1.84 M triangles at 2.00 px/tri; selection 0.776 ms (315 nodes visited)
- **65x65**: 225 patches, 1.84 M triangles at 2.00 px/tri; selection 1.040 ms (315 nodes visited)

## Reading

- All three sizes land at the same triangle budget, because DEC-032 derives
  the patch count from the pixel-area floor. A bigger patch buys fewer patches.
- The real difference is CPU: a smaller patch means MORE nodes to traverse and
  more instances to write, for the same triangles. That is the trade E1 must
  settle, and it needs the GPU half to be conclusive.
- The v0 configuration (65x65, 1000 patches) is absent from this table because
  resolvePatchBudget will not produce it: at 1440p it is 0.45 px/triangle.
