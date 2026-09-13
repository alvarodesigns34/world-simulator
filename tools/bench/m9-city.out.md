# M9 city layout budget

Intel(R) Xeon(R) Processor @ 2.80GHz, Node v22.22.2.
Each city grown to its population through real growth eras, then laid out
on flat ground and on ground with a 180 m river through the centre.

| population | tech | radius | terrain | LOD | nodes | edges | bridges | buildings | street km | ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 20,000 | 0.2 | 0.7 km | flat | arterials | 113 | 224 | 0 | 0 | 29 | 0.4 |
| 20,000 | 0.2 | 0.7 km | flat | streets | 561 | 656 | 0 | 0 | 82 | 0.7 |
| 20,000 | 0.2 | 0.7 km | flat | plots | 561 | 656 | 0 | 8,163 | 82 | 2.8 |
| 20,000 | 0.2 | 0.7 km | river | arterials | 66 | 124 | 15 | 0 | 14 | 0.2 |
| 20,000 | 0.2 | 0.7 km | river | streets | 288 | 322 | 15 | 0 | 38 | 0.4 |
| 20,000 | 0.2 | 0.7 km | river | plots | 288 | 322 | 15 | 7,638 | 38 | 2.1 |
| 200,000 | 0.5 | 2.8 km | flat | arterials | 169 | 336 | 0 | 0 | 139 | 0.2 |
| 200,000 | 0.5 | 2.8 km | flat | streets | 1,681 | 2,304 | 0 | 0 | 529 | 0.7 |
| 200,000 | 0.5 | 2.8 km | flat | plots | 1,681 | 2,304 | 0 | 88,888 | 529 | 20.6 |
| 200,000 | 0.5 | 2.8 km | river | arterials | 159 | 306 | 25 | 0 | 125 | 0.1 |
| 200,000 | 0.5 | 2.8 km | river | streets | 1,435 | 1,918 | 25 | 0 | 446 | 0.3 |
| 200,000 | 0.5 | 2.8 km | river | plots | 1,435 | 1,918 | 25 | 87,376 | 446 | 20.5 |
| 1,000,000 | 0.75 | 7.6 km | flat | arterials | 169 | 336 | 0 | 0 | 372 | 0.2 |
| 1,000,000 | 0.75 | 7.6 km | flat | streets | 8,401 | 14,304 | 0 | 0 | 2801 | 1.2 |
| 1,000,000 | 0.75 | 7.6 km | flat | plots | 8,401 | 14,304 | 0 | 479,990 | 2801 | 106.0 |
| 1,000,000 | 0.75 | 7.6 km | river | arterials | 169 | 336 | 29 | 0 | 372 | 0.3 |
| 1,000,000 | 0.75 | 7.6 km | river | streets | 8,207 | 13,798 | 29 | 0 | 2726 | 1.9 |
| 1,000,000 | 0.75 | 7.6 km | river | plots | 8,207 | 13,798 | 29 | 477,876 | 2726 | 104.8 |
| 8,000,000 | 0.9 | 24.9 km | flat | arterials | 169 | 336 | 0 | 0 | 1220 | 0.4 |
| 8,000,000 | 0.9 | 24.9 km | flat | streets | 8,401 | 14,304 | 0 | 0 | 9192 | 1.8 |
| 8,000,000 | 0.9 | 24.9 km | flat | plots | 8,401 | 14,304 | 0 | 600,000 (x7) | 9192 | 141.0 |
| 8,000,000 | 0.9 | 24.9 km | river | arterials | 169 | 336 | 25 | 0 | 1220 | 0.7 |
| 8,000,000 | 0.9 | 24.9 km | river | streets | 8,342 | 14,113 | 25 | 0 | 9099 | 1.7 |
| 8,000,000 | 0.9 | 24.9 km | river | plots | 8,342 | 14,113 | 25 | 597,914 (x7) | 9099 | 131.3 |

Budget: **200 ms** per city layout, generated off the main thread.

## Verdict

**The million-person city meets the budget at every level of detail.** Its
worst case is 106.0 ms (plots, flat), 53% of budget, producing
479,990 buildings and 2801 km of street.

The worst case overall is 141.0 ms, inside budget.

Bridges appear only where a river does, and only where the technology can
span it: the `river` rows at low technology show roads blocked instead
(`stats.blockedByWater`), which is the city refusing to cross rather than
crossing for free.
