# M1 descent trace

Host: Linux 6.18.44-fc-v24 x64, 4 x Intel(R) Xeon(R) Processor @ 2.80GHz
Node: v22.22.2
Date: 2026-09-12
Seed: 0x51a51a51   601 samples @ 10 Hz   node pool 3990
Viewport: 2560×1440 discrete  patch 33×33  maxLevel 12

| t s | altitude | speed | patches | visited | tris | select ms | appear | disappear | maxL | H-cull | F-cull |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 4.00e+7 m | 0 m/s | 194 | 314 | 397k | 4.508 | 194 | 0 | 3 | 43 | 0 |
| 12 | 8.00e+6 m | 9863 m/s | 484 | 782 | 991k | 0.335 | 0 | 0 | 4 | 104 | 0 |
| 24 | 1.50e+6 m | 4954 m/s | 198 | 730 | 406k | 0.211 | 0 | 0 | 5 | 96 | 255 |
| 32 | 6.00e+5 m | 4118 m/s | 88 | 378 | 180k | 0.101 | 0 | 0 | 6 | 61 | 136 |
| 40 | 8.00e+4 m | 9281 m/s | 41 | 254 | 84k | 0.070 | 0 | 0 | 8 | 46 | 105 |
| 50 | 6.00e+3 m | 1471 m/s | 19 | 214 | 39k | 0.063 | 0 | 0 | 11 | 29 | 114 |
| 60 | 2.00e+0 m | 0 m/s | 7 | 210 | 14k | 0.070 | 0 | 0 | 12 | 29 | 123 |

max select: 4.508 ms   samples > 1.0 ms: 11/601   max appear/frame: 194   max disappear/frame: 56   budget-exhausted: 0/601
p50 0.169 ms   p95 0.669 ms   max appear after t=0: 48

t=0 appear=194 is the initial visible set, not a pop.
Samples > 1.0 ms on this host do not track visited-node count or pool misses; treat as GC unless a GPU HUD `select` disagrees.
Reproduce: `pnpm run bench:descent` or in the running app press **T** (or `?descent`).
Same seed `0x51a51a51`, same keyframes, same cameras.
