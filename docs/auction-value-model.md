# League Value Model v1.1 — projected auction values from league history

How `player_seasons.projected_auction_value` is calculated for an upcoming
draft, why each parameter is what it is, and how to refine the model as more
drafts are collected. Implementation: `src/lib/value-model.ts` (pure model) +
`src/server/lib/value-data.ts` (shared data loading/history builders) +
`scripts/calc-projected-values.ts` (runner). First applied to the 2026 draft
on 2026-07-13; v1.1 (2026-07-15) fixed the model inventing value for ranked
players the league never pays for — see "The $0-row augmentation" below.

## Data

- **Prices**: every priced pick (`price > 0`) from `auctions` with
  `type = "official"` — the real league drafts 2018–2025, imported from the
  league's draft workbook via a private one-time importer and normalized
  per-pick CSV. Mock auctions
  and $0 snake picks are excluded.
- **Undrafted rows (v1.1)**: history is no longer priced picks alone. For
  every year with a completed official auction, each ranked
  (`position_rank > 0`) QB/RB/WR/TE season row whose player has no priced
  pick that year is synthesized as a `price = 0` observation — most ranked
  players, especially deep QBs and TEs, simply never get bid on, and the
  model needs that as data rather than silence. K/DST are never
  synthesized (still no comps → no estimate). See "The $0-row
  augmentation" below for why this was needed.
- **Rankings**: each row (priced or synthesized) is joined to its draft
  year's `player_seasons` row for that player (`rank` = FantasyPros overall
  rank, `position_rank`). Rows without a positive `position_rank` are
  unusable for comps — today that's all 84 of 2018's picks (no 2018
  rankings imported yet) plus a handful of stray misses, leaving **672
  priced + ~3,094 synthesized $0 rows (2019–2025)** when predicting 2026.
- **League constants**: 12 teams × $200 = **$2,400** budget, 12 × 7 = **84**
  auctioned players. K/DST are never auctioned (snake tail) and get $0.

## Algorithm

For a target player in draft year `T` with position `P`, position rank `pr`,
overall rank `rk`:

1. **Comp neighborhood.** Collect historical picks that are either
   - same position with `|position_rank − pr| ≤ w`, or
   - a *different* auctioned position (QB/RB/WR/TE) with `|rank − rk| ≤ w`.

   Try `w = 2`, widening to `4` then `8` until at least 3 comps are found;
   no comps at `w = 8` → estimate $0 (players the league has never paid for).

   The cross-position criterion works because positional discounts are
   already baked into consensus overall rank (the backtest confirmed
   all-position cross comps beat both RB/WR-only and same-position-only).

2. **Recency weight.** Each comp from year `Y` gets weight `0.85^(T − Y)` —
   the most recent draft counts ~1.9× a 4-year-old one and ~3.4× a
   7-year-old one. This is what carries the league's trends (WR inflation,
   RB decline, QB price creep) into the estimate without extrapolating.

3. **Robust center.** The estimate is the **weighted median** of comp
   prices. Median, not mean, is the outlier guard: single wild picks (the
   $63 Justin Herbert in 2022, a $1 steal next to $40 neighbors) barely move
   it. No explicit outlier removal is needed or performed.

4. **Budget normalization.** Every draft spends the full $2,400, but comp
   medians recall *past* prices, so the raw board under-allocates by a few
   percent. All estimates are scaled by one global factor so the **top 84
   estimates sum to $2,400**, then rounded to whole dollars.

Parameters live in `DEFAULT_VALUE_MODEL_CONFIG` (`src/lib/value-model.ts`):
`decay 0.85 · budget 2400 · draftedPoolSize 84 · windows [2,4,8] · minComps 3`.

## Why these choices — the backtest

*(This backtest predates the v1.1 $0-row augmentation below and validates
`decay`/windows/normalization on priced-only history; the augmentation is
scored separately, on top of these choices, in its own section.)*

Walk-forward backtest: for each draft 2022–2025, train only on earlier years
and predict the 84 players actually drafted; score mean absolute error per
pick, averaged over the four years.

| Model | MAE | Notes |
|---|---|---|
| Old linear equation (`max(80 − (rank−1), 1)`) | **$11.54** | +$9.71/pick bias in 2025; allocates $3,216 of a $2,400 budget; blind to the QB/TE discount |
| Unweighted comps (the app's `estimateValue` logic) | $5.50 | |
| Recency-weighted comps, decay 0.85 | **$5.47** | best raw accuracy |
| + budget normalization (**shipped**) | $5.67 | bias +$0.02 (vs −$1.00 unnormalized); board sums to budget |

Tested and **rejected**:

- **Explicit position-trend multiplier** (extrapolating each position's
  budget share into `T`, clamped, applied on top): MAE worsened at every
  shrink level tried. It overcorrects — RB share fell 2019→2023 but has been
  flat ~43% since, and a linear extrapolation keeps pushing it down. Recency
  weighting captures trend without extrapolating. Revisit only if a position
  starts moving faster than decay can follow.
- **Distance-weighted comps** (triangular kernel over rank distance inside
  the window): identical MAE to flat weighting; not worth the complexity.
- **Restricting cross-position comps to RB/WR** (motivated by the QB/TE
  discount at equal overall rank): worse ($5.84) — see step 1.
- Decay grid `1.0 / 0.85 / 0.75 / 0.6`: 0.85 won; accuracy is not very
  sensitive in the 0.75–1.0 range, very low decay (0.6) starts losing.

## The $0-row augmentation (v1.1)

**Problem found (2026-07-15):** history contained only priced picks, so the
model never learned that most ranked QBs/TEs go undrafted — it only ever
saw the rare year one got bid on, and (combined with cross-position
overall-rank comps and windows that widen until 3 comps turn up) that was
enough to invent a price out of a handful of unrelated data points. For
2026 this put 23 QBs and 20 TEs at positive value — 148 players positive
overall, against a league that only prices ~84 skill players a year.
Example trace: Sam Darnold (QB23, overall rank 149) priced at $5 from
exactly 3 comps — Philip Rivers $2 (2019), Trey Lance $6 (2021), Mike
Gesicki $5 (2022) — three thin, unrelated picks standing in for "the
league has never paid $5 for a QB this deep."

**Fix:** for each year with a completed official auction, every ranked
(`position_rank > 0`) QB/RB/WR/TE season row whose player has no priced
pick that year is synthesized into history as a `price = 0` observation.
K/DST are still never synthesized (no comps → no estimate, unchanged).
Weighted medians now collapse to $0 for players the league doesn't pay
for — no position-specific hacks. Implemented once in
`src/server/lib/value-data.ts` (`buildHistory`), shared by the runner and the
backtest and also supporting an offline JSON dump via `--data` (for
cred-less dry-run/backtest runs), and mirrored in the app's
`src/lib/history-client.ts` (`computeHistoricalValues`) so the live "Est.
Value" and comps modal see the same $0 comps — synthesized rows carry
`source: 'undrafted'` there and are filtered out of display-only history
views. `value-model.ts` renamed `PricedHistoryRow` → `HistoryRow` and its
`price` field now accepts `>= 0` instead of `> 0`.

**Backtest** (`scripts/backtest-value-model.ts`, now a permanent repo
script rather than a throwaway prototype — same walk-forward 2022–2025
protocol as above):

Drafted-pick accuracy (over each year's ~84 priced picks):

| variant | MAE | bias | per-year MAE (2022 / 2023 / 2024 / 2025) |
|---|---|---|---|
| old (priced-only) | $5.55 | −$0.47 | $5.49 / $5.90 / $5.14 / $5.67 |
| new ($0-augmented) | $5.94 | −$0.18 | $6.02 / $6.44 / $5.36 / $5.93 |

MAE change: **+$0.39/pick**, accepted as a trade-off. Drafted-only MAE is
one-sided scoring — it never penalizes phantom positives on undrafted
players, which is exactly what this fix removes. Marginal drafted players
the new model now predicts $0 for pay full price in this metric, so some
of the "regression" is really the honest cost of no longer inventing value
for players the league doesn't buy.

Phantom positives — ranked players predicted >$0, averaged per year, vs.
actually priced:

| position | old avg >$0 | new avg >$0 | actual priced |
|---|---|---|---|
| QB | 20.5 | 8.3 | 8.0 |
| RB | 49.5 | 30.3 | 31.8 |
| WR | 53.5 | 34.0 | 36.8 |
| TE | 19.8 | 7.0 | 7.5 |

**2026 result (dry-run):** 82 players priced >$0 (was 148) — WR 35, RB 31,
QB 9, TE 7 (QB was 23, TE was 20). Top-84 estimates still sum to $2,400 by
construction; the top of the board is stable, shifting up $1–3 as the
normalization scale changes slightly with the smaller positive pool.

## Running it

Both runners require `--league`, including offline runs. The selected league
supplies the scoring format, team count, budget, and paid slots. Live runs need
configured PocketBase credentials; offline runs do not.

```bash
# Preview the selected league's board without writing.
npx tsx scripts/calc-projected-values.ts --league <league-id> --year 2026 --dry-run --top 40

# Write projected prices for that league's year.
npx tsx scripts/calc-projected-values.ts --league <league-id> --year 2026

# Preview or backtest an offline dump.
npx tsx scripts/calc-projected-values.ts --league <league-id> --year 2026 --dry-run --data <dump.json>
npx tsx scripts/backtest-value-model.ts --league <league-id> --data <dump.json>

# Backtest from PocketBase.
npx tsx scripts/backtest-value-model.ts --league <league-id>
```

Rankings for the target year must already be imported. The optional
`--scoring-format` on the price runner is an assertion against the league's
settings, not an override. Snake leagues have no projected auction prices.

Offline dumps contain `leagues`, `fantasy_teams`, `auctions`, `picks`, `seasons`,
and `players` arrays. Include the selected league's `id` and `settings`, team
`league` relations, and each auction's `league`, `created`, `type`, `status`, and
`external` fields. The loader rejects missing league metadata and filters picks
by the selected boards; a multi-league dump is safe. Old dumps without league
provenance must be regenerated. Writes remain unavailable with `--data`, and
live reruns update only changed values.

Official history is scoped before choosing one draft per season. Compatible
external boards remain separate observations: only auction/hybrid leagues with
12 teams, $200 budgets, and seven paid slots admit them. Neither external boards
nor other leagues supply manager-profile picks. Shared projected-price storage
still supports only one auction league's results per player/year; see AD-29.

The in-app **Recalculate Projected Prices** button (import view, commissioner
only) runs this same model over the same `src/server/lib/value-data.ts`
builders, so it and the CLI produce identical numbers — use whichever is
convenient. It used to apply the old linear equation and clobber these values;
that is no longer the case.

## Annual refresh & future refinement

After each real draft (its auction is official + completed and the new
year's rankings are imported), rerun the script for the next draft year —
the new draft joins the history pool automatically at full weight.

Ideas, roughly in value order:

1. **Import 2018 FantasyPros rankings** (`scripts/import-wayback-rankings.mjs`
   + `run-historical-import.ts`) to unlock the 84 rank-less 2018 picks.
2. **Re-run the backtest yearly** to re-validate `decay` (and the $0
   augmentation) as the sample grows — with more years, a lower decay
   (heavier recency tilt) may start winning. The grid-search prototype is
   now `scripts/backtest-value-model.ts`, a permanent repo script (not a
   one-off) that runs offline against a `--data` dump or live PocketBase.
3. ~~**Upgrade the in-app live estimator** (`src/lib/estimated-value.ts`) to
   the same recency weighting.~~ Done 2026-07-14: "Est. Value" now uses the
   model's `weightedMedian` and decay, but stays un-normalized by design —
   it's the raw market read next to the budget-scaled Projected Value.
   Finished 2026-07-29: the two now share one `collectComps` in
   `value-model.ts`, so windows, `minComps`, and the cross-position gate
   cannot drift. They had: the live side stopped widening at ±4 instead of
   ±8, and lacked the auction-position gate, so a K/DST carrying an overall
   rank could be priced off a skill player. Budget normalization is now the
   only difference between the two numbers.
4. **In-draft inflation tracking**: during a live auction, re-scale
   remaining estimates by (remaining league budget) / (sum of remaining
   estimates) — the normalization step generalizes to this.
5. **Manager tendencies**: nomination order and per-manager overpay profiles
   are in the data (`draft_picks.fantasy_team_id`) but unused.
6. **Rookie handling**: rookies currently price off rank comps only, which
   backtests fine, but a rookie flag interaction is untested.
