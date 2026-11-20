# GTA VI trophy rarity forecast

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/iksan-ai-dev/gta6-trophy-rarity-forecast-01/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/iksan-ai-dev/gta6-trophy-rarity-forecast-01/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

An entry for [make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/bounty/gta6-trophy-rarity-forecast-01).

Forecasts every Grand Theft Auto VI PlayStation 5 trophy's earn rate on Exophase
at a week after launch, as five quantiles per trophy, from the reads the house
recorded before the case's checkpoint. Runs offline: `node main.ts`, Node 22.

## Why the rate is not forecast directly

A printed rate is `earners / players-tracked`, and the two sides move for
different reasons. Exophase does not drift: the page sits frozen for hours and
then jumps at a refresh. On launch night every read from 23:48Z to 04:00Z was the
same page — 638 tracked, 943 earned — then one refresh put 3,868 tracked and
4,276 earned on it and every rate but the 100% one fell. By 27.3 h the page held
14,028 tracked and 14,882 earned.

Fitting the rate alone reads those steps as noise around a trend. Splitting the
rate reads them as what they are: the denominator moved, and the numerator moved
far less.

## The model

```
pool(t)      = players Exophase tracks for the game
earners_i(t) = rate_i(t)/100 * pool(t)      the players holding trophy i

log earners_i(t) = log earners_i(last) + gamma_i * log(pool(t)/pool(last))
```

`gamma_i` is the trophy's own dilution exponent. `gamma = 0` means its holders are
already fixed and its rate is pure dilution; `gamma = 1` means it grows with the
pool and its rate never moves. Measured across the one real interval available —
638 to 14,028 tracked, a 22x pool — the field runs from -0.02 to 1.00 with a
median of 0.05, so most trophies are near pure dilution and the field's mean is
0.156.

The pool is fitted on `log(1 + hours since release)`, weighted to the recent reads
and pivoted at the last one so a bad slope cannot move today's level.

### Three structural facts the page gives for free

- **Earners never fall.** A player who holds a trophy keeps it, so every trophy's
  numerator is non-decreasing even as its rate drops.
- **A trophy at 100% stays there.** Every tracked player started the game, so its
  holders *are* the pool: `gamma = 1` exactly, and its rate stays at the ceiling.
- **Growth is concave in log time.** A player base is finite, so the pool's
  log-log slope is capped well below the launch spike's.

### Shrinkage

`gamma` is estimated per trophy from the case's own transitions whenever the
history holds more than one distinct page, shrunk toward the pooled value by how
many transitions support it:

```
w = n / (n + 2)
gamma_i = w * own_fit + (1 - w) * pooled
```

With two points a single trophy's exponent is mostly noise, and the pooled value
is the better bet. This is what the practice cases cannot test — their histories
are one flat page — and what the final case can, because by the deadline the
recorder will have written ~2.5 days of reads with several real refreshes in them.

## Validation

The practice cases' answers are not in the kit, so the checks below use the one
real out-of-sample interval available: the 638-tracked launch-night page against
the 14,028-tracked page read a day later.

| model | pinball loss |
|---|---|
| persistence (rate never moves) | 2.615 |
| flat gamma, no shrinkage | 0.511 |
| **this entry** | **0.490** |

Fitted against a simulated final — 630 reads at the recorder's 10-minute cadence
across 22 distinct refreshes, pool 638 → 79,396, gammas taken from the measured
transition — the entry scores **0.139** with **55/55** trophies inside the 90%
interval.

Run time is ~70 ms for both practice cases against the house's 8 s cap, and the
output is byte-identical across runs.

## Output

`/output/<id>.out`, one file per case:

```json
{"trophies": [{"id": 1, "q": [0.344, 0.4276, 0.4973, 0.5783, 0.7184]}]}
```

Five quantiles at the levels 0.05, 0.25, 0.5, 0.75 and 0.95, ascending, each in
`[0, 100]`, one row for each of the case's trophies.

## Run

```bash
mkdir -p out
MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## License

MIT — see [LICENSE](LICENSE).
