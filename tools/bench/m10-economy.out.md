# M10 economy budget and stability

Intel(R) Xeon(R) Processor @ 2.80GHz, Node v22.22.2. 500-year steps, 60 samples.

## Step budget

| civ level | cells | polities | graph nodes | graph edges | p50 ms | p95 ms | max ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| L5 | 6,144 | 154 | 154 | 268 | 0.85 | 1.06 | 1.50 |
| L6 | 24,576 | 442 | 442 | 966 | 2.20 | 3.47 | 6.41 |
| L7 | 98,304 | 593 | 593 | 1,408 | 4.27 | 5.28 | 8.80 |

Budget: **20 ms** per economy step at T3.

At the default configuration (L6) the p95 step is **3.47 ms**, 17% of budget.
Worst measured is 5.28 ms at L7.

The graph is sparse — edges grow linearly with polities, not
quadratically — which is what makes per-edge arbitrage affordable and
why no global route is ever computed.

## Stability over 1,000 simulated years

| year | production | trade | food price lo–hi | ore price lo–hi | goods price lo–hi | pollution | road km | rail km |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 100 | 62,443,523,120 | 146,281,264 | 0.54–0.54 | 1.67–9.04 | 3.80–12.00 | 272,458,438,456 | 0 | 84,957 |
| 200 | 62,443,523,118 | 147,255,193 | 0.54–0.54 | 1.67–9.04 | 3.80–12.00 | 286,007,757,469 | 0 | 84,272 |
| 300 | 62,443,523,114 | 146,848,084 | 0.54–0.54 | 1.67–9.04 | 3.80–12.00 | 286,682,338,290 | 0 | 84,015 |
| 400 | 62,443,318,334 | 150,381,957 | 0.54–0.54 | 1.67–9.04 | 3.80–12.00 | 286,711,977,743 | 0 | 83,919 |
| 500 | 62,443,323,712 | 151,531,390 | 0.54–0.54 | 1.67–9.04 | 3.80–12.00 | 286,713,204,565 | 0 | 83,883 |
| 600 | 62,443,325,917 | 150,917,610 | 0.54–0.54 | 1.67–9.04 | 3.80–12.00 | 286,713,322,476 | 0 | 83,869 |
| 700 | 62,443,326,749 | 152,746,599 | 0.54–0.54 | 1.67–9.04 | 3.80–12.00 | 286,713,349,946 | 0 | 83,864 |
| 800 | 62,443,327,063 | 153,480,512 | 0.54–0.54 | 1.67–9.04 | 3.80–12.00 | 286,713,359,468 | 0 | 83,862 |
| 900 | 62,443,327,182 | 153,066,433 | 0.54–0.54 | 1.67–9.04 | 3.80–12.00 | 286,713,363,023 | 0 | 83,862 |
| 1000 | 62,443,327,227 | 153,423,264 | 0.54–0.54 | 1.67–9.04 | 3.80–12.00 | 286,713,364,364 | 0 | 83,861 |

### Reading the stability table

Production settles at 62,443,327,227 and moves -0.00% over the millennium.
Trade runs at 153,423,264 units per step and is steady. Pollution reaches a
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
