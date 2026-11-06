# Kyara Solver

Collect Kyara market snapshots with Python and choose the next booster using a
C++20 OR-Tools CP-SAT model. Optimize resale profit, expected distinct missing
cards from selected universes, or a weighted combination.

**Full live data is available.** On 2026-11-06, all 6,736 cards' 7-day and
30-day medians were retrieved in **34 requests / 33.56 seconds** through Kyara's
own batch-price endpoint in an authorized Vivaldi tab. All 17 booster pools were
collected. Published rates and representative rarity samples validate 16 normal
opening models, including all 15 paid boosters. The daily pack is excluded
because its card-detail odds contradict its themed pool and published rates.
See [current collection results](docs/current-data.md) and
[the model assumptions](docs/model.md).

## Run with Nix

Nix with flakes enabled is the only prerequisite. `flake.lock` pins the Python
interpreter, compiler, CMake, OR-Tools, JSON library, and their dependencies.

```sh
nix run path:.#scrap -- --help
nix run path:.#solve -- --help
nix flake check path:.
```

The explicit `path:.` form also works before newly created files are added to
Git. After committing the project, the usual `nix run .#solve` syntax works too.
Nix targets Intel/ARM macOS and Linux. The tested platform is ARM macOS;
the other targets are exposed but not yet built here.

## Try the complete workflow offline

The four-card fixture is synthetic and demonstrates the calculations. It is
not a Kyara market recommendation. Use a separate output directory so it cannot
replace your live database.

```sh
nix run path:.#scrap -- \
  --import-raw tests/fixtures/raw.json \
  --verification tests/fixtures/verification.json \
  --database data/demo/kyara.sqlite \
  --output data/demo/latest.json

nix run path:.#solve -- --dataset data/demo/latest.json

nix run path:.#solve -- --dataset data/demo/latest.json \
  --universe "Black Clover" --universe "MaoMao" --profit-weight 0.5
```

The profit-only result is `Profit pack`: expected proceeds 110, cost 20, profit
90. Completion-only for Black Clover selects `Clover pack`: 1.5 expected distinct
new cards. [The model](docs/model.md) derives these results by hand.

## Update live data

Keep Kyara open and logged in to Vivaldi. On macOS, allow automation access to
Vivaldi and enable its Privacy → Apple Events → Allow JavaScript from Apple
Events setting. Credentials stay inside the browser. Then:

```sh
# Regular update: reuse saved metadata and refresh all prices in batches.
nix run path:.#scrap

# Bootstrap or rebuild pools, rates, and validation samples after metadata changes.
nix run path:.#scrap -- --full-refresh --transport browser \
  --raw-output data/raw.json --verification-output data/verification.json

# Rank the current snapshot.
nix run path:.#solve
```

Default output is `data/kyara.sqlite`, `data/latest.json`, and immutable JSON
snapshots under `data/snapshots/`. Each successful request is checkpointed.
Price refreshes deliberately bypass
the price cache so the new snapshot contains new observations. An interrupted
price refresh leaves the last completed JSON snapshot intact. `--interval 2`
slows requests further; minimum spacing is one second. Different response
timestamps remain visible in the dataset.

With no saved raw metadata, plain `scrap` bootstraps a full collection. With an
existing `data/raw.json`, it performs only the fast price refresh and loads
`data/verification.json`. Use a full refresh when pools/rates change, particularly
after the daily rotation. On other platforms `--transport auto` uses HTTP;
the browser bridge currently supports macOS. `--transport http` is available
explicitly when direct API access is supported. Access denials stop collection.

If the API requires browser verification, import a locally saved HAR instead:

```sh
nix run path:.#scrap -- --import-har /path/to/kyara.har \
  --verification data/verification.json --raw-output data/raw.json
```

The importer retains only allowlisted response bodies and timestamps. It does
not retain HAR request headers, cookies, or unrelated account responses.
Unverified boosters are listed as incomplete and never recommended.

## Choose an objective and manage ownership

```sh
# Find exact universe names; ASCII case differences are accepted.
nix run path:.#solve -- universes

# Create/update a local ownership file. Card IDs come from the dataset.
nix run path:.#solve -- owned add --owned owned.json --card-id 123
nix run path:.#solve -- owned list --owned owned.json
nix run path:.#solve -- owned remove --owned owned.json --card-id 123

# Completion only, pooling missing cards from both universes.
nix run path:.#solve -- --universe "Black Clover" --universe "MaoMao" \
  --owned owned.json --profit-weight 0

# Equal normalized profit/completion influence, assuming a 5% selling fee.
nix run path:.#solve -- --universe "Black Clover" --owned owned.json \
  --profit-weight 0.5 --fee 0.05 --format json

# Rank the boosters you can open using a free-pack token.
nix run path:.#solve -- --purchase-mode free

# Replay a specific archived dataset with 30-day medians.
nix run path:.#solve -- --dataset data/snapshots/SNAPSHOT_ID.json \
  --median-window 30d --format json
```

`--profit-weight 1` is the default. Lower values require universe selection.
No ownership file means no cards are marked owned. Owned cards are ignored for
completion but keep their resale value in the profit objective.

Paid mode considers positive-cost boosters; free mode considers zero-cost
boosters and those marked as accepting free packs, with opening cost zero.
These modes have separate candidate sets and normalized scores. The program
does not inspect your actual balance or free-pack token inventory.

Missing prices exclude a booster whenever profit has positive weight. Pure
completion can rank it while reporting unknown profit. Medians never silently
fall back to another window. If every paid booster loses money in profit-only
mode, the output recommends no paid purchase and still identifies the best pack.

Exit codes: `0` successful result, `2` invalid input/access/collection failure,
`3` no eligible booster (`solve` still emits its exclusion report).

## Fast price refresh

`/api/me/collection/prices?ids=...` returns explicit median windows for all
requested catalogue cards, including unowned cards. Batches of 200 have been
verified. No two-hour per-card price scrape is needed. The collector rejects
scalar fair-price estimates and never substitutes them for market medians.
See [the endpoint validation](docs/price-refresh-investigation.md).

## Develop and test

```sh
nix develop path:.
cmake -S . -B build -G Ninja
cmake --build build
ctest --test-dir build --output-on-failure

# Commands in the shell use the packaged project:
scrap --help
solve --help
# Test local edits using python -m kyara.collector and ./build/solve.
```

`nix flake check path:.` builds both packages and runs the collector/C++ integration
tests with saved responses and no live HTTP requests. Tests cover reference
calculations, guarantees, ownership, multi-objective scores, rate limits,
checkpointing, incomplete inputs, and CP-SAT versus exhaustive scoring.

Replaying a pinned executable, saved dataset, ownership file, and arguments
reproduces scores and deterministic ID tie-breaking. Snapshot age is informational
wall-clock metadata and changes on replay. Refreshing the database intentionally
changes the input. Keep the exported snapshot and ownership file used for a result.

The pinned nixpkgs OR-Tools binary includes other solver backends and their
transitive libraries. Nix supplies them automatically for its exported CMake
configuration; this application uses CP-SAT exclusively and needs no separate
solver installation or service. A smaller CP-SAT-only OR-Tools build could be
added later if download size matters.
