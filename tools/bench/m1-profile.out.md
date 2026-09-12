# M1 CPU profile

Host: Linux 6.12.8+ x64, 2 x Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz
Node: v22.23.2
Date: 2026-09-11
Viewport: 2560×1440   patch 33×33   tier discrete   maxLevel 12
Resolved budget: 900 patches, 1.84 M tris, 2.00 px/tri (pixel-area)
RSS 100 MB   heap 20 MB   node pool 2966 entries
GPU: not present in this environment — Astra fills the GPU column.

| situation | altitude | select ms | patches | visited | H-cull | F-cull | tris | maxL | vs 1.0 ms budget |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| high orbit | 4.0e+7 m | 0.366 | 195 | 318 | 45 | 0 | 399k | 3 | ok |
| low orbit | 4.0e+5 m | 0.220 | 56 | 294 | 47 | 119 | 115k | 7 | ok |
| approach | 8.0e+4 m | 0.196 | 33 | 242 | 48 | 102 | 68k | 8 | ok |
| near surface | 2.0e+3 m | 0.107 | 17 | 230 | 24 | 133 | 35k | 12 | ok |
| surface | 5.0e+0 m | 0.112 | 7 | 230 | 24 | 143 | 14k | 12 | ok |
| north pole | 2.0e+5 m | 0.049 | 44 | 234 | 37 | 96 | 90k | 7 | ok |
| south pole | 2.0e+5 m | 0.045 | 44 | 234 | 37 | 96 | 90k | 7 | ok |
| fast motion | 3.0e+5 m | 0.295 | 66 | 282 | 45 | 102 | 135k | 7 | ok |

Stationary vs the same camera on a subsequent call is the pool-warm number
(included in each row: the situation loop warms the pool as it goes).
