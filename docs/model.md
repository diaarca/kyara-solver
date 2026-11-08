# Model and data reference

## Objectives

For booster b and card c, N_bc is the number of copies obtained. The dataset
stores both expected copies E[N_bc] and occurrence probability Pr(N_bc >= 1).
For H independent openings of one booster type, with historical median m_c,
sale fee f, and per-opening cost C_b:

    profit P_b(H) = H * (sum_c E[N_bc] * m_c * (1-f) - C_b)
    completion U_b(H) = sum_{c in missing selected cards} (1-(1-Pr(N_bc >= 1))^H)

Completion counts distinct new cards, including duplicates at most once. It is
an expectation, not the probability of completing a universe. Owned cards remain
included in profit. Free mode sets opening cost to zero. The horizon is 1–10000
(default 1); prices, availability, and probability models stay fixed, and opening
resources are assumed sufficient. This selects one booster type, not a mix.
Result objectives are horizon totals; `cost` remains per-opening and `total_cost`
is H times that cost. The result also records `horizon`.

For rebirth, D_r = max(target_r - current_r, 0), K_br is the number of distinct
unowned cards of rarity r obtained across H openings, and A contains unfinished
rarities:

    rebirth R_b(H) = sum_{r in A} E[min(K_br(H), D_r)] / D_r / |A|

Each unfinished rarity has equal weight. The cap is inside the expectation:
with one Mythic missing, credit is the probability of any new Mythic. If no target
remains, pure rebirth returns REBIRTH_RARITY_TARGETS_MET without a recommendation.
This scores progress across the horizon; it does not optimize time to rebirth or
other criteria.

When caps cannot bind, card occurrence probabilities suffice. Otherwise a dynamic
program tracks capped distinct counts. With m missing cards and a draw hitting
them with probability q, state k advances with probability q*(m-k)/m; the cap is
absorbing. This requires uniform per-slot probabilities among missing cards for
caps above one. Each slot group's draws are repeated H times. These uniform
transition kernels commute, so grouped identical draws preserve the result.
Binding caps have a 10-million-cell work limit. Incompatible or insufficient
models are excluded.

## Selection

Normalize each objective to [0,1] using its minimum and maximum over eligible
boosters; constant objectives contribute zero. With alpha = --profit-weight:

    score_b = alpha * normalized(P_b(H)) + (1-alpha) * normalized(U_b(H) or R_b(H))
    sum_b x_b = 1
    maximize sum_b x_b * round(1,000,000 * score_b), x_b Boolean

The CLI uses CP-SAT; the extension uses HiGHS compiled to WebAssembly, running in
a dedicated worker. Both solve the same binary choice model. Integer coefficients
are `round(1,000,000 * score_b) * (n+1) + n-i`, where n is the candidate count and
i is its index in ascending booster-ID order. This makes the ID tie-break strictly
subordinate to the primary score. Both require an optimal result and check agreement
with the ranking. Direct enumeration would also suffice for the current single choice.
Weights compare observed ranges, so changing eligible boosters can change tradeoffs.
Inactive objectives do not require their data. Pure profit recommends no paid
purchase when all evaluated paid boosters have negative expected profit.

## Wishlist purchase priority

The separate wishlist model compares observed daily median increases. Let the
last completed UTC day before capture be e. A lookback L (1, 7, or 30 days;
default 7) includes dates from e-L through e, inclusive. For each card, select the
earliest and latest medians with positive sales counts in this window. At least
two dated observations are required. With first median a and last median z:

    absolute signal = z-a
    percent signal = 100*(z-a)/a, requiring a > 0

The default metric is percent. Only positive signals are eligible. Each is
scaled to `round(1,000,000 * signal / maximum_signal)` and passed to the same
exactly-one choice model and ID tie-break above. Zero or negative signals are
reported without a purchase recommendation; absent history is excluded.
The result records actual observation dates, elapsed days, medians, and sales
counts. Sparse history is not interpolated or annualized. This is a ranking of
past changes, not a forecast or a guarantee of current purchase prices.

## Probability models

For independent replacement slot groups s with k_s draws and card probability p_sc:

    E[N_bc] = sum_s k_s * p_sc
    Pr(N_bc >= 1) = 1 - product_s (1-p_sc)^k_s

The baseline assumes independent draws and uniform selection within each rarity.
Validation checks complete pools, rarity counts, published slot and aggregate odds,
and representative card details for each active rarity. Shared samples are fetched
once. Sample validation is distinguished from exhaustive detail validation.
Published percentages can replace base weights for special boosters, with rounding
tolerances recorded. Contradictory recipes, including the observed daily-pack
inconsistency, are excluded. Golden, pity, god-pack, and player-state effects are
outside this baseline; liquidity, sale timing, and market impact are also omitted.

Custom verification maps booster IDs to `pack_sha256`, `mechanics_sha256`,
`pool_complete`, `verified_at`, `evidence`, and `model`. Use
`scrap --import-raw data/raw.json --fingerprints` to obtain fingerprints.
An `independent_slots` model has `slots` with integer `draws` and complete card-ID
`probabilities`. A `moments` model has `cards` mapping IDs to `expected_copies` and
`occurrence_probability`; it can describe dependent mechanics but may lack the
joint information required for capped rebirth scoring. Fingerprints bind models
to captured mechanics; price changes preserve verification.

## Collection and storage

Undocumented Kyara GET endpoints under `/api`:

| Endpoint | Data |
| --- | --- |
| `/characters`, `/characters/{id}` | Catalogue and individual odds |
| `/packs`, `/packs/{id}/characters` | Booster definitions and card pools |
| `/rates`, `/config` | Probability rules |
| `/me/collection/prices?ids=...` | Batch 7-/30-day medians and sales counts |
| `/market/prices/{id}` | Individual price summary and daily history |
| `/me/renaissance?fresh=1`, `/me/collection?lean=1` | Rebirth requirements and holdings |
| `/me/wishlist` | Wishlisted card IDs |

Requests are sequential, at least one second apart, with bounded retries and
Retry-After handling. Access denials stop collection. Browser requests use an
allowlist, refuse redirects, and retain credentials inside Vivaldi. Batch prices
include unowned cards; absent medians stay null and scalar fair prices are rejected.
Price refreshes bypass cached prices and retain metadata freshness information.

Raw bundles contain `catalog`, `packs`, `pack_pools`, `rules`, `characters`,
`prices`, `collected_at`, and optional per-route `fetched_at`. Card mapping keys
are string IDs. Normalized schema version 1 records card identity/medians,
booster eligibility/cost, outcome moments, verification, and capture metadata.
CLI snapshot IDs hash canonical raw data plus verification; extension snapshots
hash their raw JSON bundle. IDs identify captures within each implementation;
cross-implementation IDs need not match. SQLite tables in the CLI are
`responses`, `snapshots`, `cards`, `boosters`, and `outcomes`. Imports are idempotent.

Rebirth sync makes only the two account GETs above, using `data/raw.json` for the
catalogue. Its schema is version 1 with `counting: "unique"`, `collected_at`,
`next_rebirth`, `owned`, and `requirements`: C/U/R/E/L/M each have `current` and
`target`. Unique inventory counts must match reported counters; unknown cards or
mismatches stop sync. Other account criteria are discarded. The solver checks
counts again against its dataset. Targets vary with captured state, not hard-coded
levels. Keep holdings local and refresh them when they change.

Wishlist sync fetches the catalogue, wishlist IDs, and each wishlisted card's
daily market history. It does not require a booster dataset. Schema version 1
contains `collected_at`, optional `synthetic`, and `cards`; each card has `id`,
`name`, `universe`, `collected_at`, and `days` entries with `day`, nullable
`median`, and sale count `n`. Duplicate IDs/dates, invalid dates or prices, and
card captures after the snapshot are rejected. Wishlist exports are private
account data and should stay local.

For offline imports, use `scrap --import-raw PATH --verification PATH` or
`scrap --import-har PATH`. HARs must include successful catalogue and booster
response bodies. Import keeps allowlisted responses and discards request credentials;
original HARs can still contain secrets and should remain local. Incomplete inputs
receive no guessed odds or prices. Snapshot age is reported when solving.

The extension uses Manifest V3 with packaged HiGHS JavaScript/WASM (MIT licensed),
no remote executable code, and permissions limited to Kyara, script injection,
and local storage. `unlimitedStorage` accommodates the complete catalogue and
probability models. Collection runs sequentially from its full-page UI, which must
stay open. Cancellation takes effect after an in-flight request. Complete datasets
replace local storage only on success; metadata/price checkpoints allow a failed
first collection to retry using collected metadata. Account sync uses exactly the
two account GETs above and stores only normalized holdings and rarity criteria.
Imported datasets are validated but require a full metadata refresh before further
collection. Validation establishes consistency with published odds, not a guarantee
about undocumented server mechanics.
