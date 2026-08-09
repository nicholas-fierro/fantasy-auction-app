# Workstream 1 Results — Prior-Season Usage Does Not Predict Cheap-Tier Hits

> **Follow-up (snap counts + age):** the touch-based result below stands, but the
> escalation it recommended was run and did find something. See
> [Follow-up: snap counts and age](#follow-up-snap-counts-and-age) at the end.

Run of `scripts/backtest-usage-signal.ts` against the full 2018–2025 league history,
now that every year has its snake rounds recorded. Method and decision rule were
fixed in advance in `docs/auction-research-plan.md`.

**Verdict: no signal. Mean held-out AUC 0.514, below the 0.55 floor.** The
pre-registered response applies — publish the negative and stop modelling this
with the data on hand.

## Setup

- **Cohort:** 225 rows. Every $1–20 buy at RB/WR/TE in an official auction, 2019–2025.
- **Dropped:** 23 with no season Y−1 game logs (rookies — the irreducible part of the
  lottery), 41 QBs (the plan's features describe rushing and receiving usage; passing
  volume is a different feature set the plan does not specify).
- **Baseline:** season total of the median weekly score among that year's $0 snake
  picks, per position. The truthful baseline, available for all years post-backfill —
  the rank-band approximation from Workstream 0 is gone, not calibrated.
- **Hit rate:** 90/225 (40%), stable at 9–14 per year across all seven seasons.

## Held-out AUC

| Year | n | hits | usage | rank null | price null |
|---|---|---|---|---|---|
| 2019 | 30 | 14 | 0.571 | 0.654 | 0.703 |
| 2020 | 32 | 14 | 0.599 | 0.585 | 0.681 |
| 2021 | 33 | 14 | 0.583 | 0.624 | 0.641 |
| 2022 | 35 | 13 | 0.594 | 0.696 | 0.535 |
| 2023 | 36 | 13 | 0.428 | 0.503 | 0.467 |
| 2024 | 27 | 9 | 0.407 | 0.568 | 0.586 |
| 2025 | 32 | 13 | 0.413 | 0.623 | 0.704 |
| **mean** | | | **0.514** | **0.608** | **0.617** |

Usage beat both nulls in **0 of 7** seasons. It is also visibly anti-predictive from
2023 on (0.41–0.43), which is what a model fitting noise looks like when the noise
it fit stops recurring.

## Robustness

The null result is not an artifact of the regularization constant or the feature count:

| Configuration | Mean AUC |
|---|---|
| All 10 features, L2 = 1 | 0.514 |
| All 10 features, L2 = 10 | 0.535 |
| All 10 features, L2 = 50 | 0.532 |
| `carry_share` alone | 0.499 |
| `last8_carry_share` alone | 0.500 |
| `carry_share` + `last8_carry_share` | 0.521 |
| `target_share` alone | 0.532 |
| **price alone** | **0.617** |
| rank alone | 0.608 |
| price + rank | 0.610 |
| price + rank + `carry_share` | 0.614 |
| price + rank + all usage | 0.594 |

No usage configuration reaches 0.55. Adding the usage block on top of price + rank
makes out-of-sample performance *worse* (0.610 → 0.594) — the features are consuming
degrees of freedom and returning nothing.

Per-feature Spearman against surplus over replacement is uniformly weak. The three
positives are all the same underlying thing (`carry_share` +0.23, `last8_carry_share`
+0.23, `carries_pg` +0.22 — RB workload), and none survives as an out-of-sample
predictor. `td_rate`, included as a deliberate negative control, lands at −0.13 and
gets a near-zero coefficient, which is the model behaving as it should.

## What this means for 2026

**1. The cheap tier is genuinely a lottery on the data available.** The strategy the
optimizer already implements is correct: buy the most tickets you can. There is no
identification edge to be had from prior-season targets and carries.

**2. Price within the cheap tier carries more information than any usage feature**
(0.617 vs 0.535 best case). This refines, and does not contradict, the earlier finding
that ρ(price, points) ≈ 0 *within a preseason rank band* — that measured whether
paying up inside a tier buys anything, which it does not. This measures whether a $18
buy beats a $3 buy across the whole cheap tier, which it does. Both are true: pay
attention to where a player sits in the cheap tier, ignore small price differences
among similarly-ranked players.

**3. The market is efficient at this price point.** Price and rank each hitting ~0.61
while usage adds nothing means the league's own bidding already absorbs the usage
information. That is a real result about this league, not a failed experiment.

## Where the remaining edge could be

The negative result is informative about what to try next: usage as measured by
*touches* is already priced. What is not in this data:

- **Snap counts** (separate nflverse dataset) — true opportunity share rather than the
  touch proxy. Best signal-per-unit-effort of the remaining options.
- **Play-by-play** for red-zone touches and air yards — large import (millions of rows).
  Given that touch-based usage returned nothing rather than something weak, the
  expected payoff here is lower than it looked when the plan was written.
- **Age / birth dates** — needs an nflverse roster import.

The plan's guidance was to escalate to new data if the result landed in the weak band
(0.55–0.65). It landed below that, which is a weaker case for escalating, not a
stronger one.

## Reproducing

```bash
PB_SUPERUSER_EMAIL=... PB_SUPERUSER_PASSWORD=... npx tsx scripts/backtest-usage-signal.ts
```

`--data <dump.json>` runs offline against a JSON dump; `--shortlist` prints ranked
2026 candidates, but refuses whenever the model is below the weak-signal bar or
fails to improve on price + rank, rather than dressing noise up as a shortlist.

Pure logic lives in `src/lib/usage-signal.ts`, covered by `src/lib/usage-signal.test.ts`.

---

# Follow-up: snap counts and age

The section above recommended snap counts as the best remaining option, while
noting that a below-floor result was a *weaker* case for escalating, not a
stronger one. It was escalated anyway. Snap counts (2018–2025) and birth dates
are now imported; the same cohort and the same leave-one-season-out harness were
rerun with five extra features and an age curve.

**Verdict: weak signal, and it survives the only comparison that matters.**
Opportunity share is not fully priced the way touches are.

## What changed in the data

- `player_game_logs.stats` gained `offense_snaps`, `offense_pct`, `st_snaps`,
  `st_pct` — 51k rows updated, imported by `scripts/import-nflverse-snap-counts.ts`.
- **5,565 game-log rows were created**, not just updated: skill players who took
  offensive snaps and recorded no stat line at all. They now carry zeroed scoring
  stats. This is the whole point — a blocking tight end or a decoy receiver was
  previously invisible, and "on the field, produced nothing" is exactly what the
  touch features could not express.
- `players.birth_date` filled for 1,320 of 1,322 players with a `gsis_id`. Age
  needed no imputation anywhere in the cohort.

## Held-out AUC

Same 225 rows, same hit definition, same folds.

| Year | n | hits | rank | price | touches | price+rank | snap+age | all | price+rank+snap+age |
|---|---|---|---|---|---|---|---|---|---|
| 2019 | 30 | 14 | 0.654 | 0.703 | 0.567 | 0.683 | 0.661 | 0.670 | 0.679 |
| 2020 | 32 | 14 | 0.585 | 0.681 | 0.607 | 0.619 | 0.603 | 0.571 | 0.595 |
| 2021 | 33 | 14 | 0.624 | 0.641 | 0.586 | 0.650 | 0.688 | 0.729 | 0.729 |
| 2022 | 35 | 13 | 0.696 | 0.535 | 0.601 | 0.552 | 0.640 | 0.664 | 0.650 |
| 2023 | 36 | 13 | 0.503 | 0.467 | 0.441 | 0.505 | 0.452 | 0.498 | 0.538 |
| 2024 | 27 | 9 | 0.568 | 0.586 | 0.432 | 0.599 | 0.599 | 0.438 | 0.636 |
| 2025 | 32 | 13 | 0.623 | 0.704 | 0.441 | 0.660 | 0.530 | 0.453 | 0.676 |
| **mean** | | | **0.608** | **0.617** | **0.525** | **0.610** | **0.596** | **0.575** | **0.643** |

Three readings, in order of how much weight they deserve:

1. **The stacked arm is the only one that could change a draft board, and it
   improved: 0.610 → 0.643.** `price+rank` was re-measured on the *current* data
   rather than compared across runs, and landed on 0.610 — identical to PR #89,
   so the new rows did not move the control. The +0.033 is the honest size of the
   effect.
2. **Snap features on their own reach 0.596**, inside the pre-registered weak band
   [0.55, 0.65) that touches never reached (0.514). But they beat both nulls in
   only **2 of 7** seasons, well short of the 5 the strong verdict requires.
3. **The touch arm moved 0.514 → 0.525.** Not a re-run discrepancy: the created
   zero-production rows change `games_played` and the per-game team share
   denominators. Immaterial to the conclusion, worth knowing before anyone tries
   to reproduce the earlier number exactly.

## What the features say

Spearman against surplus over replacement: `opportunity_per_snap` +0.20 and
`snap_pct_trend` +0.15 are the useful new ones, and note that raw `snap_pct` is
−0.05 — snap volume alone is priced, it is *what a player does per snap* and
*whether his role was still growing in December* that carry information. `age` is
−0.17, the strongest single new feature by magnitude and in the expected
direction.

In-sample coefficients on the stacked arm put `opportunity_per_snap` (+0.375) and
`snap_pct` (+0.340) above price (+0.282) and rank (+0.282) — a sign the snap block
is doing real work rather than riding along, though in-sample weights are
interpretation only.

## What this does and does not justify

**Does:** keeping snap counts imported and rerunning the shortlist before the 2026
draft. `--shortlist` now clears its gate and prints ranked candidates.

**Does not:** shipping anything to the draft board. +0.033 mean AUC across seven
folds of ~32 rows each is well inside the noise this sample can produce, and the
snap arm failing the beat-both-nulls test in 5 of 7 seasons says the same thing.
Treat the shortlist as a draft-room tiebreaker between two similarly-priced cheap
buys, not as a ranking to trust over the board.

**Still not worth it:** play-by-play. The case for a millions-of-rows import rests
on red-zone touches and air yards adding something beyond opportunity share, and
opportunity share itself only bought 0.033.

## Reproducing the follow-up

```bash
npx tsx scripts/import-nflverse-player-game-logs.ts --year 2018,2019,2020,2021,2022,2023,2024,2025
npx tsx scripts/import-nflverse-snap-counts.ts --year 2018,2019,2020,2021,2022,2023,2024,2025
npx tsx scripts/backtest-usage-signal.ts --shortlist
```

Run the snap import second; it merges into `stats` rather than replacing it, and
so does the weekly-stats importer, so rerunning either one preserves the other's
keys. `pb_migrations/1784360000_player_birth_date.js` must be applied first.
