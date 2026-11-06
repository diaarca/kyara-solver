# Complete collection on 2026-11-06

| Data | Result |
| --- | --- |
| Catalogue | 6,736 cards |
| Booster definitions and complete candidate pools | 17 |
| Explicit 7-day medians | 6,736 / 6,736 |
| Explicit 30-day medians | 6,736 / 6,736 |
| Price requests | 34 batches of at most 200 IDs |
| Measured price refresh | 33.561 seconds |
| Metadata collection | 20.68 seconds |
| Odds validation samples | 47 distinct cards, 46.61 seconds |
| Accepted normal-opening models | 16, including all 15 paid boosters |

Data is stored under ignored `data/`: `kyara.sqlite`, `raw.json`, `latest.json`,
`verification.json`, and immutable snapshots. Price observation timestamps and
coverage are preserved. The 47 samples validate the published probability
recipe; market prices were collected for **every** catalogue card, not sampled.

## Validated batch-price feed

The batch route is `/api/me/collection/prices?ids=...`. Despite its name it
returns prices for requested cards outside the logged-in collection. Every
catalogue ID was returned. The payload explicitly distinguishes median windows
and includes sales counts. The collector does not use fair-price estimates.
Three individual market-price calls matched the batch values in both windows.

Regular refresh:

```sh
nix run path:.#scrap
nix run path:.#solve
```

The first command reuses metadata and verification and updates only prices.
Keep an authorized, logged-in Kyara tab open in Vivaldi on macOS. Rebuild static
metadata and validation when booster pools or probability rules change:

```sh
nix run path:.#scrap -- --full-refresh --transport browser \
  --raw-output data/raw.json --verification-output data/verification.json
```

## Probability scope

Pool membership, rarity counts, published slot percentages, per-booster rarity
expectations, and per-card rarity rates are checked. At least one individual
card-detail probability is checked for each active rarity in each pool. Many
samples overlap between boosters, giving 47 distinct requests overall.

The model assumes independent replacement draws and uniform selection within
each rarity as represented by the published rates. It excludes golden, pity,
and god-pack effects. Normal-weight boosters use high-precision base weights;
Prestige uses normalized published slot percentages, with their rounding
precision explicitly recorded and propagated through validation tolerances.
This sampled validation is identified separately from the earlier exhaustive
180-card Automne 2026 check.

Premium/reward candidate pools can contain cards below every slot minimum.
Such cards remain in the captured pool but have zero probability and are omitted
from positive-probability outcomes. Reward-only packs are excluded from purchases.

## Daily-pack contradiction

The captured daily theme is Mecha, with 215 cards. Its published slot/pool rates
do not match the per-card `dropChance.daily` values. For example, sampled mythical
card 417 has a pool-based occurrence probability about `0.00135390`, while its
detail response reports `0.0000933891`. The conflict is preserved as an exclusion;
the collector does not select one source silently or mark that model verified.

## Snapshot interpretation

All 15 evaluated paid boosters have negative normal-opening estimated profit
before fees at this capture. Deep Cuts has the smallest absolute expected loss
(about 63 chakra per opening). This does not make it profitable. Free-pack choices
are ranked separately. Historical medians do not guarantee a future sale price;
bonus-opening effects and player-specific counters remain outside the baseline.
