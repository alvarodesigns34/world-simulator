# M10 economy budget and stability

Intel(R) Xeon(R) Processor @ 2.80GHz, Node v22.22.2. 500-year steps, 60 samples.

## Step budget

| civ level | cells | polities | graph nodes | graph edges | p50 ms | p95 ms | max ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| L5 | 6,144 | 160 | 160 | 291 | 0.87 | 2.21 | 3.37 |
| L6 | 24,576 | 395 | 395 | 884 | 1.97 | 2.08 | 4.38 |
| L7 | 98,304 | 620 | 620 | 1,495 | 4.22 | 5.63 | 8.51 |

Budget: **20 ms** per economy step at T3.

At the default configuration (L6) the p95 step is **2.08 ms**, 10% of budget.
Worst measured is 5.63 ms at L7.

The graph is sparse — edges grow linearly with polities, not
quadratically — which is what makes per-edge arbitrage affordable and
why no global route is ever computed.

## Stability over 1,000 simulated years

| year | production | trade | food price lo–hi | ore price lo–hi | goods price lo–hi | pollution | road km | rail km |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 100 | 103,199,534,524 | 175,684,174 | 0.54–0.54 | 1.68–9.01 | 3.81–12.00 | 259,048,019,537 | 0 | 101,159 |
| 200 | 103,199,534,495 | 179,612,475 | 0.54–0.54 | 1.68–9.01 | 3.81–12.00 | 271,913,779,008 | 0 | 100,904 |
| 300 | 103,199,534,490 | 179,200,149 | 0.54–0.54 | 1.68–9.01 | 3.81–12.00 | 272,554,327,103 | 0 | 100,810 |
| 400 | 103,199,534,490 | 181,972,882 | 0.54–0.54 | 1.68–9.01 | 3.81–12.00 | 272,586,218,097 | 0 | 100,775 |
| 500 | 103,199,534,490 | 180,930,913 | 0.54–0.54 | 1.68–9.01 | 3.81–12.00 | 272,587,805,857 | 0 | 100,761 |
| 600 | 103,199,534,490 | 180,939,035 | 0.54–0.54 | 1.68–9.01 | 3.81–12.00 | 272,587,884,906 | 0 | 100,757 |
| 700 | 103,199,534,490 | 181,393,634 | 0.54–0.54 | 1.68–9.01 | 3.81–12.00 | 272,587,888,842 | 0 | 100,755 |
| 800 | 103,199,534,490 | 181,412,360 | 0.54–0.54 | 1.68–9.01 | 3.81–12.00 | 272,587,889,038 | 0 | 100,754 |
| 900 | 103,199,534,490 | 181,423,619 | 0.54–0.54 | 1.68–9.01 | 3.81–12.00 | 272,587,889,048 | 0 | 100,754 |
| 1000 | 103,199,534,490 | 181,424,612 | 0.54–0.54 | 1.68–9.01 | 3.81–12.00 | 272,587,889,048 | 0 | 100,754 |

### Reading the stability table

Production settles at 103,199,534,490 and moves -0.00% over the millennium.
Trade runs at 181,424,612 units per step and is steady. Pollution reaches a
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
