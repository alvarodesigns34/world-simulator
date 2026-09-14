# EntityStore benchmark — DEC-012 review gate

Node v22.22.2, 10 f64 components per entity.

| case | ms/pass |
| --- | --- |
| SoA  iterate+update 10000 | 0.096 |
| AoS  iterate+update 10000 | 0.093 |
| SoA  churn 10% of 10000 | 0.127 |
| SoA  iterate+update 100000 | 0.335 |
| AoS  iterate+update 100000 | 0.780 |
| SoA  churn 10% of 100000 | 0.428 |
| SoA  structured-clone-equivalent copy of 100k x 10 | 5.4 |
| AoS  deep clone of 100k objects | 122.9 (cloned 100000) |

## Verdict

At the brief's M8 scale — 10^4 settlements, 10^6 total population — one full
demographic pass costs **0.096 ms**, against a 20 ms budget for the whole
civilisation step. At 10^5 entities it is 0.335 ms, so the store is not the
constraint at either scale.

Objects (the alternative DEC-012 rejected) cost 0.093 ms for the same 10^4 pass,
a 0.97x difference on iteration alone. The gap that actually decides it is
transfer: 5.4 ms to copy the SoA columns against 122.9 ms to deep-clone the
equivalent objects, and the SoA number is an upper bound because a
SharedArrayBuffer transfers at zero copy (DEC-020).

**A third-party ECS is still not warranted.** The gate asked about entity
counts and archetype variety. Counts are within budget by two orders of
magnitude. Archetype variety is one: every settlement carries every
component, so there is no archetype churn for an ECS to optimise — the
machinery that justifies a library is machinery this workload never uses.
Re-open the gate if M9/M10 introduce entities with genuinely disjoint
component sets (buildings vs. trade routes vs. agents) in the same store.

