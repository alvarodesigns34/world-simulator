# M1 descent trace

Host: Linux 6.12.8+ x64, 2 x Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz
Node: v22.23.2
Date: 2026-09-11
Seed: 0x51a51a51   601 samples @ 10 Hz   node pool 3994
Viewport: 2560×1440 discrete  patch 33×33  maxLevel 12

Pooled selector (same NodePool + SelectWorkspace the renderer owns).

| t s | altitude | speed | patches | visited | tris | select ms | appear | disappear | maxL | H-cull | F-cull |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 4.00e+7 m | 0 m/s | 194 | 314 | 397k | 5.223 | 194 | 0 | 3 | 43 | 0 |
| 12 | 8.00e+6 m | 9863 m/s | 484 | 782 | 991k | 0.275 | 0 | 0 | 4 | 104 | 0 |
| 24 | 1.50e+6 m | 4954 m/s | 198 | 730 | 406k | 0.501 | 0 | 0 | 5 | 96 | 255 |
| 32 | 6.00e+5 m | 4118 m/s | 88 | 378 | 180k | 0.093 | 0 | 0 | 6 | 61 | 136 |
| 40 | 8.00e+4 m | 9281 m/s | 41 | 254 | 84k | 0.080 | 0 | 0 | 8 | 46 | 105 |
| 50 | 6.00e+3 m | 1471 m/s | 19 | 214 | 39k | 0.051 | 0 | 0 | 11 | 29 | 114 |
| 60 | 2.00e+0 m | 0 m/s | 7 | 210 | 14k | 0.053 | 0 | 0 | 12 | 29 | 123 |

max select: 5.223 ms (t=0, empty pool, 308 misses)
samples > 1.0 ms: 16/601 (2.7%)
p50 0.155 ms   p95 0.821 ms   mean after t=2 s: 0.252 ms
max appear/frame: 194 (t=0 initial set, not a pop; after t=0: 48)
max disappear/frame: 57
budget-exhausted: 0/601

The 16 samples over 1 ms do **not** track visited-node count or pool misses.
t=42.1 is 230 visited / 0 misses / 4.2 ms; the same camera in the warmed
profile is 0.196 ms. They are GC / shared-runner noise on this 2-vCPU host.
Steady-state on a persistent pool (the live renderer) is the profile table,
not the cold first sample.

t=0 appear=194 is the initial visible set, not a pop.
Reproduce: `pnpm run bench:descent` or in the running app press **T** (or `?descent`).
Same seed `0x51a51a51`, same keyframes, same cameras.
