# E3 — SAB vs Transfer vs structuredClone (tile sizes)

Host: Linux 6.12.8+ x64, 2 x Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz
Node: v22.23.2
Date: 2026-09-11
Method: worker_threads round-trip, median of 12 (after 2 warm).

| size | clone RT ms | transfer RT ms | SAB read RT ms | local structuredClone ms |
| --- | ---: | ---: | ---: | ---: |
| 8 KB | 0.073 | 0.053 | 0.052 | 0.013 |
| 64 KB | 0.151 | 0.050 | 0.058 | 0.062 |
| 256 KB | 0.394 | 0.070 | 0.090 | 0.238 |
| 1 MB | 1.014 | 0.075 | 0.158 | 0.181 |
| 4 MB | 2.024 | 0.099 | 0.156 | 2.389 |
| 50 MB | 133.435 | 1.014 | 1.802 | 63.033 |

## Decision (where SAB is REQUIRED / PREFERRED / UNNECESSARY)

Measured against the 2.0 ms `simCommit` budget and the 16.6 ms frame.

| Payload | Mechanism | Verdict | Why |
| --- | --- | --- | --- |
| Persistent L11 fields (≈50 MB, in-place updates) | SAB + generation-publish | **REQUIRED** | Clone is ~5× a frame. Transfer *detaches* the field from the main thread, which turns every read into a lifetime problem (DEC-020). |
| Regional tiles 256 KB–1 MB (authoritative bake results) | Transferable ArrayBuffer | **PREFERRED** | One-shot ownership handoff. Tile is immutable after bake; main thread does not need the producer copy. Clone of 1 MB is already a millisecond-scale tax if it happens per tile. |
| Dirty-block uploads 8–64 KB | Transferable, or just `queue.writeBuffer` from SAB | **UNNECESSARY to invent SAB** | Both clone and transfer are well under 0.3 ms. Use whichever the buffer already is. |
| Control messages, descriptors, job headers (< 4 KB) | structuredClone | **UNNECESSARY** | Noise. SAB would add COOP/COEP and Atomics ceremony for nothing. |
| Double-buffered field with concurrent readers across a commit | SAB + phase separation | **REQUIRED**, plus the seqlock | `consistentRead` detects a torn generation. Holding `raw()` across `commit()` aliases the back buffer — tested, documented, forbidden. |

SAB is not a dogma. It is the only mechanism that lets two threads read a 50 MB
field without copying it and without detaching it. Everything smaller is a
cost/complexity trade, and the numbers above are the trade.
