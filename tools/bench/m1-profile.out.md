# M1 CPU profile

Host: Linux 6.18.44-fc-v24 x64, 4 x Intel(R) Xeon(R) Processor @ 2.80GHz
Node: v22.22.2
Date: 2026-09-12
Viewport: 2560×1440   patch 33×33   tier discrete   maxLevel 12
Resolved budget: 900 patches, 1.84 M tris, 2.00 px/tri (pixel-area)
RSS 101 MB   heap 20 MB   node pool 2966 entries
GPU: not present in this environment — Astra fills the GPU column.

| situation | altitude | select ms | patches | visited | H-cull | F-cull | tris | maxL | vs 1.0 ms budget |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| high orbit | 4.0e+7 m | 0.368 | 195 | 318 | 45 | 0 | 399k | 3 | ok |
| low orbit | 4.0e+5 m | 0.200 | 56 | 294 | 47 | 119 | 115k | 7 | ok |
| approach | 8.0e+4 m | 0.160 | 33 | 242 | 48 | 102 | 68k | 8 | ok |
| near surface | 2.0e+3 m | 0.127 | 17 | 230 | 24 | 133 | 35k | 12 | ok |
| surface | 5.0e+0 m | 0.082 | 7 | 230 | 24 | 143 | 14k | 12 | ok |
| north pole | 2.0e+5 m | 0.054 | 44 | 234 | 37 | 96 | 90k | 7 | ok |
| south pole | 2.0e+5 m | 0.051 | 44 | 234 | 37 | 96 | 90k | 7 | ok |
| fast motion | 3.0e+5 m | 0.309 | 66 | 282 | 45 | 102 | 135k | 7 | ok |

Stationary vs the same camera on a subsequent call is the pool-warm number
(included in each row: the situation loop warms the pool as it goes).
