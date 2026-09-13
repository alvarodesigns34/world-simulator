# M8 civilisation step budget

AMD EPYC 9V74 80-Core Processor, Node v24.19.0.
500-year steps at paleo detail, measured after 48 kyr of direct M8 warm-up
so settlements are real while M9/M10 setup cost is excluded from the M8 timing.

| civ level | cells | settlements | population | p50 ms | p95 ms | max ms |
| --- | --- | --- | --- | --- | --- | --- |
| L5 | 6144 | 481 | 6,135,750,746 | 0.115 | 0.252 | 0.807 |
| L6 | 24576 | 240 | 7,414,076,670 | 0.137 | 0.291 | 0.315 |
| L7 | 98304 | 745 | 7,237,569,388 | 0.583 | 1.258 | 1.292 |
| L8 | 393216 | 1452 | 4,371,536,261 | 1.644 | 3.773 | 4.552 |

Budget: **20 ms** per civilisation step at T3.

## Reading these numbers

The civilisation grid is the hydrology grid, whose default is
`min(6, genesis level)`. **At the default configuration (L6) the p95 step is
0.29 ms, 1% of budget.** The finer rows are the store's headroom, not the
shipping configuration.

At L8 (393,216 cells) the p95 is 3.8 ms — **inside the 20 ms budget** — while
the p50 is 1.64 ms. That 2x spread is the shape of the cost, not noise: the
per-step work is O(settlements) and cheap, and the expensive work is the
O(cells) territory BFS plus capacity accumulation, which at paleo detail
runs on every 8th step. Amortised that is
~1.9 ms, inside budget; as a worst-case tick it is not.

**Stated limit:** M8 meets the 20 ms per-step budget through L8
(3.8 ms p95). The cached typed neighbour table is derived work memory;
it changes no authoritative state or deterministic publication order.

Settlement counts are set by how much habitable land the world has, not by
the store: even at L8 this seed's planet supports ~1,700 concurrent
settlements. The 10^4-entity figure the brief names is measured directly in
`tools/bench/entitystore.out.md` (0.095 ms for a full demographic pass), and
the rows above show why that half was never the constraint.
