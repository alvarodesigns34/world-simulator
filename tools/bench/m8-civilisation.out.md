# M8 civilisation step budget

Intel(R) Xeon(R) Processor @ 2.80GHz, Node v22.22.2.
500-year steps at paleo detail, 80 samples, measured on a world already
evolved through 300 kyr so the settlements are real rather than seeded.

| civ level | cells | settlements | population | p50 ms | p95 ms | max ms |
| --- | --- | --- | --- | --- | --- | --- |
| L5 | 6144 | 154 | 6,172,535,182 | 0.054 | 0.604 | 0.625 |
| L6 | 24576 | 442 | 6,187,820,410 | 0.186 | 2.559 | 2.572 |
| L7 | 98304 | 593 | 5,922,496,805 | 0.507 | 9.852 | 10.463 |
| L8 | 393216 | 1482 | 5,485,479,819 | 1.854 | 41.007 | 41.048 |

Budget: **20 ms** per civilisation step at T3.

## Reading these numbers

The civilisation grid is the hydrology grid, whose default is
`min(6, genesis level)`. **At the default configuration (L6) the p95 step is
2.56 ms, 13% of budget.** The finer rows are the store's headroom, not the
shipping configuration.

At L8 (393,216 cells) the p95 is 41.0 ms — **over the 20 ms budget** — while
the p50 is 1.85 ms. That 22x spread is the shape of the cost, not noise: the
per-step work is O(settlements) and cheap, and the expensive work is the
O(cells) territory BFS plus capacity accumulation, which at paleo detail
runs on every 8th step. Amortised that is
~6.7 ms, inside budget; as a worst-case tick it is not.

**Stated limit:** M8 meets the 20 ms per-step budget up to L7
(9.9 ms p95). At L8 it meets it only amortised. Closing that would mean
splitting the territory BFS across ticks, which is real work and is not
done here — it is recorded rather than glossed.

Settlement counts are set by how much habitable land the world has, not by
the store: even at L8 this seed's planet supports ~1,700 concurrent
settlements. The 10^4-entity figure the brief names is measured directly in
`tools/bench/entitystore.out.md` (0.095 ms for a full demographic pass), and
the rows above show why that half was never the constraint.
