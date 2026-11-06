# Collection, validation, and data formats

## Current live access status

On 2026-11-06, the authorized Vivaldi bridge successfully collected all 6,736
cards' explicit medians through the 200-card batch endpoint, plus all 17 pools.
See [current data](current-data.md). Plain `scrap` now uses that fast price-only
workflow; `--full-refresh` rebuilds metadata and published-rate validation.
The initial direct-access failure below is retained as historical context.

On 2026-11-05, a read-only request to `https://kyara.games/api/packs` returned:

```text
HTTP/2 403
content-type: application/json
{"error":"verification_required"}
```

Direct access remains blocked. A subsequent browser HAR established the actual
catalogue and response shapes; see [capture findings](capture-validation.md) for
coverage, the initial probability check, and subsequent complete Automne 2026
baseline validation. Special opening mechanics and global booster comparison
remain pending. Before scheduled collection, inspect
the site's current terms, robots guidance, and any API instructions or contact
the operator for a supported feed. The collector pauses on 401/403 or non-JSON
responses instead of attempting to defeat verification.

The candidate routes were discovered in community client source code:

- [Catalogue client](https://github.com/A-Finch13/Kyara-Games-Extension/blob/main/src/lib/kyara.js)
- [Prices and booster probabilities](https://github.com/A-Finch13/Kyara-Games-Extension/blob/main/src/content/content.js)

These are undocumented website endpoints, not an established official API contract.
The adapter expects array responses from `/api/characters` and `/api/packs`,
character details from `/api/characters/{id}`, and price objects from
`/api/market/prices/{id}` containing `median7d`/`median30d`. Changed response shapes
produce a validation failure or incomplete booster rather than guessed values.

## Validate one booster using the browser

1. Open Kyara normally and inspect Developer Tools → Network → Fetch/XHR.
2. Visit the catalogue, booster list, one purchasable booster, and its card price
   pages. Record the complete pool, price, slots, guarantees, availability,
   and the definition of each displayed probability.
3. Export the Network log as a HAR **with response content**. Prefer the browser's
   sanitized export. Keep this file local: HAR files can contain account secrets.
4. Import it with `scrap --import-har kyara.har --raw-output data/raw.json`.
   Only catalogue, booster, character-detail, and price response bodies are retained.
   Headers/cookies and unrelated routes are ignored. Missing card-price responses
   remain missing; browsing a few cards does not establish full price coverage.
5. Obtain exact expected copies and occurrence probabilities, or verify independent
   replacement-slot mechanics and their full distributions. Create the verification
   JSON below. If the site publishes only ambiguous odds, keep the booster unverified.
6. Reimport with `--verification data/verification.json`. Check the result against
   several visible card prices and independently calculate one booster's objectives.
7. Extend verification and price coverage to all desired boosters before relying
   on a global ranking. Each discovered unverified booster remains in the exclusion
   report. Do not assume that the best verified booster is best across unknown packs.

If supported authenticated access is available, the collector optionally reads
`KYARA_TOKEN` and `KYARA_DEVICE_ID` from the environment. It never stores these
request headers, prints their values, or sends them outside Kyara. Authentication
does not promise to resolve browser verification. Do not commit tokens or HAR files.

## Raw response bundle

HAR import produces this same format; it can also be assembled from copied
response bodies. Keys in card mappings are stable card IDs as strings.

```json
{
  "collected_at": "2026-11-05T12:00:00Z",
  "catalog": [{"id": 123, "name": "Example", "series": "Example universe", "rarity": "R"}],
  "packs": [{"id": "pack-id", "name": "Example pack", "chakraPrice": 10}],
  "characters": {"123": {"dropChance": {"pack-id": 1}}},
  "prices": {"123": {"median7d": 12, "median30d": 11}},
  "fetched_at": {"/market/prices/123": "2026-11-05T12:00:00Z"}
}
```

`fetched_at` is optional for hand-assembled bundles, which use `collected_at` as
the fallback timestamp. `synthetic: true` marks fictional test data throughout
the workflow. Sales/count fields from price objects are retained with their
original names; a 30-day count is never relabeled as the 7-day median's sample size.
Neither variant pricing nor undocumented pagination formats are inferred.

## Verification file

First print fingerprints of the imported evidence:

```sh
nix run path:.#scrap -- --import-raw data/raw.json --fingerprints
```

Copy the corresponding hashes into a manually reviewed model:

```json
{
  "boosters": {
    "pack-id": {
      "pack_sha256": "COPY_PRINTED_HASH",
      "mechanics_sha256": "COPY_PRINTED_HASH",
      "pool_complete": true,
      "verified_at": "2026-11-05T12:00:00Z",
      "evidence": "Describe the published rules/source and independent check here",
      "model": {
        "type": "independent_slots",
        "slots": [{"draws": 1, "probabilities": {"123": 1}}]
      }
    }
  }
}
```

For mechanics represented by verified moments, replace `model` with:

```json
{
  "type": "moments",
  "cards": {
    "123": {"expected_copies": 1, "occurrence_probability": 1}
  }
}
```

Every eligible card must be represented. `pool_complete` is a review assertion,
not proof generated by the tool. The collector checks finite nonnegative values,
probability bounds, consistent moments, slot sums, and card references. It binds
verification to the exact pack definition, catalogue identities/rarities/universes,
and captured published drop chances. Price-only changes preserve verification;
changed mechanics evidence makes the booster incomplete until reviewed again.
Different detail coverage also changes the fingerprint. For a single-booster run,
create verification using the same captured detail set as the intended run;
full-catalogue collection should be verified against full detail coverage.

This manual verification gate is deliberate until a live response contract and
odds semantics can be established. Do not fill unknown probabilities uniformly
or copy fixture mechanics into a live verification file.

## Persistence and replay

SQLite stores checkpointed response bodies, immutable snapshot bundles and
verification evidence, and normalized `cards`, `boosters`, and `outcomes` tables
keyed by snapshot ID. JSON exports use schema version 1. Snapshot IDs are SHA-256
hashes of canonical raw data plus verification, so identical imports have identical
IDs. Existing snapshots are idempotent; failed collection does not replace the
latest JSON export. Successful partial imports publish explicit incomplete data.

The normalized C++ interface contains:

- Snapshot identity, collection timestamp/epoch, response timestamps, and synthetic marker.
- Cards with ID, name, universe, rarity, nullable median fields, and price metadata.
- Boosters with cost, snapshot availability, free-pack compatibility, issues,
  verified evidence, and per-card expected copies/occurrence probabilities.

Save JSON solver output alongside the exact snapshot and ownership file to
reproduce a decision. Keep those files when upgrading the software; unknown
schema versions are rejected. Database schema migrations are not needed for v1.

Live collection is sequential with at least one second between requests. It
honors Retry-After, retries transient failures at most three total attempts,
and checkpoints each successful response. HTTP 404 details/prices remain absent;
unexpected errors stop the run. A catalogue with N cards can require roughly
2N+2 requests on the first full run, so review the access policy and prefer
bulk feeds if the operator provides them.

Scheduling is intentionally manual until live validation and access rules are
settled. Afterwards, invoke the documented `scrap` command from your scheduler
with an absolute checkout path and explicit database/output/verification paths.
Retain snapshots and inspect coverage and failures before acting on a ranking.
