# Collection and data reference

## Supported workflows

`scrap` defaults to a price-only refresh of `data/raw.json`, loading
`data/verification.json`. Without a raw snapshot it performs a full collection.
A full refresh downloads the catalogue, booster definitions and pools, public
probability rules, batch prices, and representative character details for each
rarity in each pool. It rebuilds validation and records conflicting boosters as
exclusions. Price refreshes reuse that metadata; refresh it after rules or pools change.

The macOS browser bridge runs read-only requests in an already authorized Kyara
tab. It permits only specific catalogue, pool, probability, and price endpoints,
refuses redirects, and keeps credentials in the browser. HTTP transport optionally
reads `KYARA_TOKEN` and `KYARA_DEVICE_ID` from the environment. Neither transport
exports authentication headers or sends credentials outside Kyara.

These are undocumented website endpoints and can change:

| Endpoint under `/api` | Purpose |
| --- | --- |
| `/characters` | Complete card catalogue |
| `/packs` | Booster definitions, prices, slots, and published rates |
| `/packs/{id}/characters` | Complete candidate pool |
| `/rates`, `/config` | Public rarity and probability rules |
| `/characters/{id}` | Individual card odds and optional price summary |
| `/me/collection/prices?ids=...` | Batch 7-/30-day medians and sales counts |
| `/market/prices/{id}` | Individual price summary |

The batch-price endpoint was validated with 200 IDs per request and returned
all 6,736 catalogue cards, including unowned cards. Spot checks matched individual
market-price responses. Scalar fair-price values are rejected rather than treated
as medians. Missing windows remain null, without falling back to another window.

Requests are sequential and spaced at least one second apart. Transient HTTP
failures use bounded retries and respect Retry-After. Authentication/access
denials and unexpected schemas stop collection. Successful requests are
checkpointed in SQLite; price-only refreshes bypass cached prices to collect new
observations. If a batch omits an ID, its old value is not relabeled as fresh.
Inspect coverage and exclusions before using a ranking.

## Files and replay

| Default path | Content |
| --- | --- |
| `data/kyara.sqlite` | Response checkpoints, raw/normalized snapshots, and verification |
| `data/raw.json` | Latest raw response bundle for subsequent refreshes |
| `data/verification.json` | Probability models and supporting evidence |
| `data/latest.json` | Normalized solver input |
| `data/snapshots/{snapshot_id}.json` | Archived normalized solver input |
| `owned.json` | Optional user-managed ownership file |

The SQLite tables are `responses`, `snapshots`, `cards`, `boosters`, and
`outcomes`. Normalized records are keyed by snapshot ID. JSON schema version is 1.
A snapshot ID hashes canonical raw data plus verification. Identical imports are
idempotent. A failed collection does not replace the latest completed JSON export;
a successful partial import explicitly records incomplete coverage.

Save the exact dataset, ownership file, solver output, and flake lock used for a
result. Unknown dataset schema versions are rejected. Snapshot availability is
computed at capture time, and the solver reports snapshot age.

## Raw response bundle

```json
{
  "collected_at": "2026-11-06T12:00:00Z",
  "catalog": [{"id": 123, "name": "Example", "series": "Example universe", "rarity": "R"}],
  "packs": [{"id": "example", "name": "Example pack", "chakraPrice": 10}],
  "pack_pools": {"example": [123]},
  "rules": {},
  "characters": {"123": {"id": 123, "dropChance": {"example": 1}}},
  "prices": {"123": {"median7d": 12, "median30d": 11}},
  "fetched_at": {"/market/prices/123": "2026-11-06T12:00:00Z"}
}
```

Card mapping keys are string IDs. `fetched_at` is optional for hand-assembled
bundles, which fall back to `collected_at`. `synthetic: true` identifies fictional
test input. Price-only refreshes add source timestamps, batch duration, response
coverage, and metadata age information. Reported sales counts keep their original
window; a 30-day count is never presented as a 7-day sample size.

The normalized solver input contains card identity, universe, rarity and nullable
medians; booster cost, availability, free-token eligibility and issues; per-card
expected copies and occurrence probabilities; verification evidence and capture
metadata. See [the model](model.md) for how those moments are used.

## Probability verification

Full refresh checks complete pools, rarity counts, published slot rates,
per-booster rarity expectations/occurrences, per-card aggregate rates, and at
least one character detail for every active rarity in each pool. Shared samples
are fetched once. Validation records its coverage and precision; it does not
claim exhaustive individual-detail validation when samples were used.

The normal-opening recipe assumes independent replacement draws and uniform
selection within each rarity, consistent with the published rates. Base weights
provide high precision where applicable. Boosters overriding those weights use
normalized published slot percentages with explicit rounding tolerances. Golden,
pity, god-pack, and player-state effects are excluded from this baseline.
Contradictory recipes are not silently reconciled: the daily pack's published
pool/slot rates have disagreed with its individual `dropChance.daily` values.

For a custom or independently reviewed model, use `--verification` with a file
mapping booster IDs to `pack_sha256`, `mechanics_sha256`, `pool_complete`,
`verified_at`, `evidence`, and `model`. Obtain the fingerprints with:

```sh
scrap --import-raw data/raw.json --fingerprints
```

An `independent_slots` model contains `slots`, each with integer `draws` and a
complete `probabilities` mapping from card ID to per-draw probability. A `moments`
model contains `cards`, mapping each card ID to `expected_copies` and
`occurrence_probability`. Every eligible card must be represented. Fingerprints
bind the model to its captured pool/rules/odds evidence; price-only changes preserve
verification. A manual `pool_complete` assertion is not automatic proof of completeness.

## Offline imports

Raw JSON and browser HAR imports remain available for replay and debugging:

```sh
scrap --import-raw /path/to/raw.json --verification /path/to/verification.json
scrap --import-har /path/to/capture.har --raw-output data/imported-raw.json
```

HAR input must contain successful catalogue and booster responses with response
bodies. The importer retains allowlisted catalogue, pool, rule, card and price
responses, drops request headers/cookies and unrelated account routes, and
restricts configuration fields to those used by the model. Keep HAR files local:
the original file may contain credentials even when the imported bundle does not.
Incomplete imports are never assigned guessed probabilities or prices.
