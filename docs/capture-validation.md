# First browser capture: 2026-11-05

| Data | Captured coverage |
| --- | --- |
| Card catalogue | 6,736 cards |
| Booster definitions | 17 boosters |
| Explicit booster membership | Shōnen Mix (`all`), all 6,736 IDs |
| Character details and market medians | Levi, ID `45627`, only |
| Public probability rules | `/rates`, `/config`, per-booster `rates` |

Imported artifacts are in the ignored `data/` directory: `raw.json`, `latest.json`,
`kyara.sqlite`, and an immutable snapshot. Request headers, account endpoints,
and unrelated responses are excluded. Config retains only model-relevant fields.
No private HAR or live response fixture is committed.

Levi's captured medians are 5,700 chakra over 7 days and 5,500 over 30 days,
with 302 and 741 reported sales respectively. These are captured historical values.

## Probability check

Shōnen Mix costs 150 chakra, publishes minimum-rarity slots `C,C,C,U,R`, and
contains 203 mythical cards. Public base weights are
`C:62, U:25, R:11.4, E:1.4, L:0.15, M:0.025`.

For a normal independent-slot baseline, normalize allowed rarity weights for
each slot and divide mythical probability by 203. For Levi this gives:

- Expected copies: `0.000016430037772205635`.
- Occurrence probability: `0.000016429955378760575`.
- Published `dropChance.all`: `0.000016429955378760575`, exactly matching
  the occurrence formula at captured precision (about 0.001643%).

This supports the interpretation for this card/booster; it does not establish
every mechanic or uniformity across every rarity. The same calculation matches
Levi for `top`, `mini`, `chest`, `husbando`, and `seal-mythic`. It does not match
`premium`, whose slot rates use different weights, or the captured `daily`
detail probability. Those cases require separate investigation.

Rules additionally expose golden openings every 10, a pity threshold of 250,
and god-pack chance `0.0005` (0.05%). Their interaction with player state and
published baseline rates remains unresolved. The importer therefore does not
automatically mark any entire booster fully verified from this one-card check.
That first capture alone cannot support a profit ranking: only one card has prices.

## Complete Automne 2026 export

The subsequent `data/browser-export.json`, captured at
`2026-11-05T22:26:04.320Z`, contains all 180 pool cards, all 180 character details,
and both 7-day and 30-day medians for every card. Rarity counts match the published
pool: C=92, U=33, R=20, E=12, L=14, M=9. Every card's captured probability agrees
with the ordinary independent-slot formula, with maximum absolute error below
`2e-16` after grouping identical slots (floating-point rounding).
Slot percentages and per-rarity aggregate rates also agree within their display
rounding. This supports a conditional **normal-opening baseline**.

| Median window | Expected resale proceeds | Cost | Expected profit before fees |
| --- | ---: | ---: | ---: |
| 7 days | 40.41395 chakra | 175 | -134.58605 chakra |
| 30 days | 40.63752 chakra | 175 | -134.36248 chakra |

The normal-opening model therefore estimates a substantial loss on this booster
at the captured prices. Golden, pity, and god-pack effects are excluded, and
historical medians are not guaranteed sale prices. Other boosters still lack
complete captured price/pool coverage, so this is not a global booster ranking.

Reproduce the validation and import:

```sh
nix run path:.#scrap -- --import-raw data/browser-export.json \
  --verify-baseline season-2026-fall \
  --verification-output data/verification.json --raw-output data/raw.json
nix run path:.#solve -- --format json
```

`--verify-baseline` is an explicit, conservative verifier: it requires complete
pool/detail coverage and compares every published card probability, every slot
percentage, and aggregate rarity rates. It refuses unsupported boosted recipes
or mismatches. It records the excluded special mechanics in verification metadata
and the solver's output. An unrelated booster is never automatically verified.

## Collect a complete booster without manual card-by-card browsing

The [browser helper](../scripts/browser-export.js) collects public data using
sequential GET requests, at least 1.1 seconds apart. It opens no packs and places
no orders. It uses your page's session locally and never exports credentials.
It stops on HTTP errors and refuses redirects.

1. Open Kyara, then Developer Tools → Sources → Snippets.
2. Create a snippet, paste the helper file, and run it to define `kyaraExport`.
3. Run this in the Console:

   ```js
   await kyaraExport({ packIds: ["season-2026-fall"] })
   ```

   This booster has 180 cards in the capture, a smaller validation target than
   Shōnen Mix. Allow at least 3–4 minutes and keep the tab active. Another current
   booster ID can be selected instead.

4. Move the downloaded JSON into `data/browser-export.json` and tell me it is
   ready. It can also be imported with:

   ```sh
   nix run path:.#scrap -- --import-raw data/browser-export.json \
     --raw-output data/raw.json
   ```

Stop early using `kyaraExportAbort = true`. Failure/cancellation downloads a
partial bundle. If downloads are blocked, recover the in-memory data with
DevTools' `copy(JSON.stringify(kyaraExportData))` and save it as JSON.

For every booster pool and all card prices, use `packIds: ["*"]`; the first
run needs roughly two hours. Respect the site's access rules before bulk runs.
The helper reads the embedded `prices` summary from each character detail to
avoid an extra request where possible. A requested card can still have no median.
