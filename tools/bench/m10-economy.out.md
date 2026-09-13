# M10 economy budget and stability

AMD EPYC 9V74 80-Core Processor, Node v24.19.0. 500-year steps, 60 samples.

## Step budget

| civ level | cells | polities | graph nodes | graph edges | p50 ms | p95 ms | max ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| L5 | 6,144 | 152 | 152 | 548 | 1.30 | 4.12 | 6.25 |
| L6 | 24,576 | 395 | 395 | 1,548 | 3.64 | 7.03 | 8.70 |
| L7 | 98,304 | 494 | 494 | 1,901 | 5.83 | 7.18 | 8.99 |

Budget: **20 ms** per economy step at T3.

At the default configuration (L6) the p95 step is **7.03 ms**, 35% of budget.
Worst measured is 7.18 ms at L7.

The graph is sparse — edges grow linearly with polities, not
quadratically — which is what makes per-edge arbitrage affordable and
why no global route is ever computed.

## Stability over 1,000 simulated years

| year | production | trade | food price lo–hi | ore price lo–hi | goods price lo–hi | pollution | road km | rail km |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 100 | 25,332,709,030 | 0 | 0.54–0.54 | 5.25–12.00 | 11.93–12.00 | 79,827,047,536 | 0 | 67,076 |
| 200 | 25,332,709,030 | 0 | 0.54–0.54 | 5.25–12.00 | 11.93–12.00 | 83,801,381,503 | 0 | 67,076 |
| 300 | 25,332,709,030 | 0 | 0.54–0.54 | 5.25–12.00 | 11.93–12.00 | 83,999,251,940 | 0 | 67,076 |
| 400 | 25,332,709,030 | 0 | 0.54–0.54 | 5.25–12.00 | 11.93–12.00 | 84,009,103,329 | 0 | 67,076 |
| 500 | 25,332,709,030 | 0 | 0.54–0.54 | 5.25–12.00 | 11.93–12.00 | 84,009,593,801 | 0 | 67,076 |
| 600 | 25,332,709,030 | 0 | 0.54–0.54 | 5.25–12.00 | 11.93–12.00 | 84,009,618,220 | 0 | 67,076 |
| 700 | 25,332,709,030 | 0 | 0.54–0.54 | 5.25–12.00 | 11.93–12.00 | 84,009,619,436 | 0 | 67,076 |
| 800 | 25,332,709,030 | 0 | 0.54–0.54 | 5.25–12.00 | 11.93–12.00 | 84,009,619,497 | 0 | 67,076 |
| 900 | 25,332,709,030 | 0 | 0.54–0.54 | 5.25–12.00 | 11.93–12.00 | 84,009,619,500 | 0 | 67,076 |
| 1000 | 25,332,709,030 | 0 | 0.54–0.54 | 5.25–12.00 | 11.93–12.00 | 84,009,619,500 | 0 | 67,076 |

### Reading the stability table

Production settles at 25,332,709,030 and moves 0.00% over the millennium.
Trade runs at 0 units per step and is steady. Pollution reaches a
balance between emission and deposition rather than accumulating without
limit. Nothing diverges and nothing oscillates — the relaxation-form price
update is what prevents the latter, and it is why prices are not recomputed
from scarcity directly at a 500-year step.

**Food prices are uniform across polities, and that is a real result rather
than a bug.** M8 drives every population to its own carrying capacity, so at
equilibrium every polity has the same food supply per head by construction,
and identical ratios give identical prices. It is a Malthusian world: food is
produced and eaten locally, and there is no gap for anyone to arbitrage.
Dispersion in food prices appears only away from that equilibrium — during
growth, collapse, or a climate shock.

The traded commodities are the ones whose supply is set by the GROUND rather
than by the population: ore, fuel, timber, stone and manufactured goods,
whose endowment varies from territory to territory. That variation is the
comparative advantage the whole trade model runs on.

Infrastructure accumulates rather than flickering — a road built stays built
and decays slowly — so the rail column is steady even as traffic varies. Road
kilometres read zero here because these polities are technologically past
roads: every land link that carries enough traffic has been upgraded to rail,
and the road column counts only links currently at road standard.
