# FieldStore hot path (T-0078 / T-0081)

Host: Linux 6.12.8+ x64, 2 x Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz
Node: v22.23.2
Date: 2026-09-12

NO GPU IN THIS ENVIRONMENT. These are CPU copies and scans, not buffer uploads.

## copyRange (i16, L8 = 393 216 cells, double-buffered)

| path | median ms | notes |
| --- | --- | --- |
| 1 dirty block raw (8 KB) | 5.33e-4 | the renderer dirty-block case |
| 1 dirty block decoded | 0.119 | offset + stored * quantum |
| 8 dirty blocks raw (64 KB) | 1.61e-3 | |
| whole L8 raw (768 KB) | 0.020 | TypedArray.set |
| whole L8 decoded | 0.670 | JS loop |

## changedBlocksSince (i16, L11 = 25 165 824 cells, 6144 blocks)

| path | median ms | blocks reported |
| --- | --- | --- |
| 1 consumer, 1 dirty, scan from 0 | 0.011 | 1 |
| 1 consumer, 64 dirty, scan from 0 | 0.012 | 64 |
| 8 consumers, 1 dirty each, scan from 0 | 0.091 | (8 scans) |

## write barrier / invariant

| path | median ms |
| --- | --- |
| f32 set() × 1000 | 0.127 |
| f32 set() × 1000 during beginStep | 0.522 |
| i16 set() × 1000 | 0.114 |
| Number.isFinite × 100 000 | 0.197 |
| Set.has × 100 000 | 0.427 |

## Verdict

copyRange of one dirty block is microseconds. A renderer that walks
`changedBlocksSince` and uploads dirty blocks does **not** need
`unsafeRawAccess` every frame. Whole-field L11 is still a 50 MB memcpy
and remains the thing DEC-032 forbids — that path, if it ever exists,
is the named `unsafeRawAccess` door (zero-copy into a GPU writeBuffer).

`requireFinite` is one `Number.isFinite` per `set()`. It is lost in the
noise of quantise + dirty-mark. The write barrier is a `Set.has` per
`set()`, also lost in that noise on this host.
