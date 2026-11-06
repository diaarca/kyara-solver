# Fast price refresh investigation

## Resolved on 2026-11-06

The own-client route `/api/me/collection/prices?ids=...` is confirmed working.
It returns arrays of rows containing `id`, explicit `median7d`/`median30d`, and
sales counts. A 12-card probe covered all six rarities and returned every card;
three fresh individual-route checks agreed in both windows. A 200-card probe
also returned every requested card. The complete run returned all 6,736 cards
with both windows populated, in 34 batches and **33.561 seconds**. It is not
restricted to owned cards. No fair-price substitution was used.

The authorized Vivaldi/macOS bridge is now operational. Plain `nix run path:.#scrap`
uses this batch path with the saved raw metadata and verification. For a full
metadata rebuild, use `--full-refresh --transport browser --raw-output data/raw.json`.
See [current results](current-data.md) for model coverage and limitations.

The following sections record the earlier investigation during the DDoS outage;
their pending-validation notes describe that historical stage.

## Findings established from client source and our captures

- The current two-hour duration comes from our exporter making one request per
  character with 1.1-second spacing. This is our conservative default, not a
  verified Kyara requirement.
- The community extension calls
  `GET /api/fair-play/prices?ids=id1,id2,...` in batches of up to 200 IDs and
  expects an object mapping each ID to a numeric chakra value. For 6,736 cards,
  that is 34 requests, before setup/latency. At our spacing this is roughly 37
  seconds of request-start spacing, not a measured full-refresh duration.
- That source calls the values **fair prices used by the trade composer**.
  It does not establish that they are 7-day medians. We must not overwrite
  `median7d` or `median30d` with them based on an endpoint name or sample match.
- Better Kyara's price service still reads character detail/individual price
  endpoints for explicit 7-/30-day medians. This is evidence about that client's
  implementation, not proof that no exact bulk endpoint exists.
- Our HAR's market listings contain explicit 7-/30-day median summaries, but
  the same card can occur many times. The captured unfiltered market contained
  106,989 listings. Pagination is not automatically a complete/efficient card
  price feed, and an asking price is not a completed-sale median.

Sources inspected:

- [Bulk fair-price call](https://github.com/A-Finch13/Kyara-Games-Extension/blob/main/src/background.js)
- [Per-card median service](https://github.com/PsickOSSH/Better-Kyara/blob/main/price-service.js)

## Next validation

**A better candidate was found in Kyara's own cached client:**
`/_app/immutable/chunks/BMwhV0gU.js` defines
`collectionPrices: ids => GET /api/me/collection/prices?ids=...`.
This was recovered using browser `cache: "only-if-cached"`, without contacting
the server. Its response shape, maximum batch size, and behavior for unowned
cards remain unverified. A server DDoS was reported during the investigation;
live requests were stopped. Timeouts must not be interpreted as nonexistent APIs.

Direct requests to Kyara's JavaScript assets returned HTTP 403. A direct fair-price
request timed out. macOS can locate the user's existing Kyara tab, but Vivaldi
requires its separate “Allow JavaScript from Apple Events” switch before scripts
can be run through automation. Browser settings are not changed automatically.

`scripts/browser-price-investigation.js` is a small, read-only probe which:

1. Fetches a 200-card fair-price batch.
2. Checks one candidate bulk form of the known market-price route.
3. Compares fair prices to fresh explicit medians for two cards of each rarity.
4. Captures a bounded selection of public client JavaScript for endpoint analysis.

The probe now includes the own-client collection-price route and accepts an
existing local catalogue to avoid re-downloading static data. Fetching JavaScript
sources is optional and disabled by default. It records no credentials, pauses on access/rate-limit
errors, and downloads `kyara-price-investigation.json`. It can also be executed
through the authorized browser automation and saved directly to the workspace.
Matching samples are evidence of correlation, not proof of identical semantics.

## Implementation prepared offline

The collector now accepts the following **experimental** price-only workflow:

```sh
# Do not run while the service is under attack. Validate a small batch first.
nix run path:.#scrap -- --refresh-prices-from data/raw.json \
  --transport browser --batch-size 200 \
  --verification data/verification.json --raw-output data/raw.json
```

It reuses static card/booster/odds data, requests only the batch-price route,
requires explicit `median7d` and `median30d` fields, and refuses scalar fair
prices. Missing returned IDs remain missing rather than retaining old values
with a new timestamp. It reports response coverage and individual observation
timestamps. Actual latency and full unowned-card coverage are **not yet verified**.
The configurable batch size defaults to 200 as a starting point, not a confirmed
limit for the collection-price endpoint. At that size there would be 34 requests.

The macOS browser bridge uses the already authorized Kyara tab; credentials
remain in its localStorage and are sent only to Kyara. It permits only GET
requests to the specific batch-price route, rejects redirects, and exposes no
generic account-API access. HTTP transport is also available if Kyara supports
direct requests. A browser request failure stops publication of a new snapshot.

## Decision criteria

Prefer an exact bulk median feed if one can be verified. Otherwise, the fast
fair-price route is a possible explicit alternative valuation basis, requiring
clear provenance and separate fields. It must not silently change the objective's
meaning. Partial or incremental market data can supplement a cached snapshot,
but cannot be represented as a fully fresh global snapshot.

Do not ask the user to perform another two-hour scrape until this investigation
establishes the available refresh strategy and its limitations.
