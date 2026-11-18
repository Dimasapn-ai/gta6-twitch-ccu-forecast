[![make.fun · gta6-twitch-ccu-forecast-01](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![rank](https://make.fun/badge/gta6-twitch-ccu-forecast-01/Dimasapn-ai/gta6-twitch-ccu-forecast/rank.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![reward](https://make.fun/badge/gta6-twitch-ccu-forecast-01/Dimasapn-ai/gta6-twitch-ccu-forecast/reward.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)

# GTA VI launch-day Twitch forecast — gta6-twitch-ccu-forecast-01

`main.ts` (Node 22, standard library only, offline) reads every `*.in` case in
the input directory and writes one forecast per case: for hours 2–24 of the
release day, the 0.05 / 0.25 / 0.5 / 0.75 / 0.95 quantiles of the Twitch
category's concurrent viewers. The model lives in `forecast.ts`; `main.ts` is a
defensive runner around it (per-file try/catch, a flat-at-hour-1 fallback for
anything malformed) because an invalid case scores worse than any honest
forecast. Runs are deterministic — sorted file order, no randomness — and take
well under a second per case.

## Method

**Anchor.** Everything is anchored on the case's hour-1 print `p1`, the only
hour of the day already observed at the checkpoint. The model predicts the
log-ratio `log(viewers_h / p1)` for each hour `h = 2..24`.

**Curve pool.** Each of the case's `comparables` (38 past launches in a
practice case, 42 in the final) contributes its own release-day log-ratio
curve, taken from its hourly points in the UTC frame of its `day_start`. A
comparable is used only if its release day has a positive hour-1 print and at
least 12 known hours; this drops the one non-launch entry (the GTA VI
category's own pre-release history, whose `day_start` is a trailer premiere).

**Weighting.** Pool launches are kernel-weighted by similarity to the case on
three things observable at the checkpoint:

- `featA = log(p1 / pre-day peak)` — was there already a large audience in the
  24 h before the UTC day (a rolling regional unlock, New Zealand first), or
  was the category quiet until a single global unlock?
- `featG = log(p1 / previous hour)` — the last step into hour 1: still
  ramping up, or already dipping after a regional-unlock spike?
- unlock regime — the case's `notes` and each comparable's `unlock` text are
  classified as rolling-midnight vs single-global vs unknown; same-regime
  launches keep full weight, unknown ones 0.6, mismatched ones 0.25.

The case's features come from its `history_hourly` (or its `history` bucketed
to whole hours), the pool's from their own hourly series.

**Quantiles.** Per hour, the location is a blend of the weighted median and
the weighted mean (0.65 / 0.35) of the pool's log-ratios — the mean share is
insurance against launches whose day explodes after a quiet hour 1, which a
pure median cannot follow. The scale is a robust weighted MAD per hour,
smoothed over a 3-hour window, floored at 0.15 log units and multiplied by a
calibration factor of 1.15. Quantiles are
`q_tau = p1 * exp(location + z_tau * scale)` with normal `z_tau`, clamped to
(0, 1e9] and made non-decreasing.

## Backtest

`tools/backtest.ts` (dev-only, not imported by the entry) turns each of the 37
usable comparables into a pseudo-case — its release-day hour 1 as the known
print, hours 2–24 as the truth, its own hourly history as the case history —
and forecasts it leave-one-out against the other 36. Mean pinball loss on the
log scale, exactly as the contest scores it:

| method | mean loss | median case | worst case |
| --- | --- | --- | --- |
| (a) flat — all quantiles at hour 1 | 1.1421 | 0.5026 | 4.2699 |
| (b) flat median, fixed spread sigma 0.35 | 0.9731 | 0.3276 | 4.0467 |
| this model | **0.7134** | 0.3204 | 3.0576 |

On the 12 pseudo-cases whose unlock regime matches the contest's real cases
(rolling midnight; the four practice launches and GTA VI itself are all
rolling-midnight console launches), the model averages **0.2947** against
0.5408 for (a) and 0.3885 for (b). The worst pseudo-cases for every method are
launches whose day exploded 100–2000× after a near-empty hour 1 (a single
global unlock late in the UTC day, or a slow word-of-mouth burn); from hour-1
data alone those are barely distinguishable from ordinary launches, and the
model's mean-blend and spread are sized to lose less there without giving up
the typical case.

For reference, the house baseline (flat at hour 1 with a widening fixed
spread) scores about 0.387 on the practice cases per the contest rules; the
pseudo-case numbers above are a different, larger evaluation set and are not
directly comparable to it.

## Files

- `main.ts` — entrypoint: input/output plumbing and the defensive fallbacks.
- `forecast.ts` — the model: curve extraction, features, weighting, quantiles.
- `tools/backtest.ts` — the leave-one-out backtest described above.
