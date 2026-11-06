# Kyara Solver

Collect Kyara card prices with Python and rank boosters with a C++20 OR-Tools
CP-SAT model. Optimize expected resale profit, completion of selected universes,
or a weighted combination. See [the mathematical model](docs/model.md) and
[the collection/data reference](docs/data.md).

## Environment

Nix with flakes enabled manages Python, the C++ compiler, CMake, OR-Tools, and
all project dependencies through `flake.lock`.

```sh
nix develop
# Optional: automatically enter the environment using direnv.
# .envrc contains: use flake
direnv allow
```

Git-backed flakes include files known to Git. Register new source files with
`git add` or `git add -N` before loading the flake. The tested platform is ARM
macOS; Intel macOS and ARM/Intel Linux outputs are also defined.

## Collect and update

For the macOS browser transport, keep Kyara open and logged in to Vivaldi.
Allow macOS automation access and enable Vivaldi's **Privacy → Apple Events →
Allow JavaScript from Apple Events** setting. Credentials stay inside the browser.

```sh
# Refresh prices; bootstrap a complete dataset if no raw snapshot exists.
nix run .#scrap

# Rebuild catalogue, pools, rates, and validation after metadata changes.
nix run .#scrap -- --full-refresh --transport browser \
  --raw-output data/raw.json --verification-output data/verification.json
```

A price-only refresh reuses metadata and retrieves explicit 7-/30-day medians
in batches of 200. The full 6,736-card catalogue was refreshed in about 34 seconds
in a measured run. Rebuild metadata after the daily rotation or changes to packs
and probability rules. `--transport auto` uses the macOS browser for batch
workflows and HTTP elsewhere. Direct HTTP access depends on Kyara's access rules.

Outputs are `data/kyara.sqlite`, `data/raw.json`, `data/verification.json`,
`data/latest.json`, and archived snapshots under `data/snapshots/`. Keep these
local files to replay a result. Failed collection leaves the latest completed
JSON export intact. Use `--help` for imports, custom paths, and request spacing.

## Solve

```sh
# Rank purchases by estimated profit, or rank free-token openings.
nix run .#solve
nix run .#solve -- --purchase-mode free

# List canonical universe names.
nix run .#solve -- universes

# Balance profit and completion; repeat --universe to select several.
nix run .#solve -- --purchase-mode free \
  --universe "Black Clover" --universe "The Apothecary Diaries" \
  --owned owned.json --profit-weight 0.5

# Add, remove, or inspect owned card IDs.
nix run .#solve -- owned add --owned owned.json --card-id 123
nix run .#solve -- owned remove --owned owned.json --card-id 123
nix run .#solve -- owned list --owned owned.json

# Replay a saved dataset, choose the median window, and account for selling fees.
nix run .#solve -- --dataset data/snapshots/SNAPSHOT_ID.json \
  --median-window 30d --fee 0.05 --format json
```

`--profit-weight 1` is profit-only, `0` is completion-only, and `0.5` gives equal
influence after normalization. Completion requires a universe selection and
maximizes expected **distinct missing cards per opening**. Omit `--owned` to
start with no cards marked owned. Owned cards still contribute resale value.

Paid mode subtracts chakra cost. Free mode considers packs accepting free tokens
and zero-cost packs, with opening cost zero; it does not inspect your token
balance. Missing prices exclude a pack whenever profit has positive weight.
Incomplete probability models are reported as exclusions. If all evaluated paid
packs have negative expected profit in profit-only mode, no purchase is recommended.

The baseline excludes golden, pity, and god-pack effects. Historical medians
are estimates of resale value, not guaranteed sale prices. Contradictory source
rates, as observed for the rotating daily pack, remain excluded.

Exit codes: `0` success, `2` invalid input or collection failure, `3` no eligible
booster (with an exclusion report). `--format json` provides structured results.

## Develop and test

```sh
nix flake check

# Build and test local edits in the development environment.
nix develop
cmake -S . -B build -G Ninja
cmake --build build
ctest --test-dir build --output-on-failure
```

Inside the shell, `scrap` and `solve` use the packaged project. Use
`python -m kyara.collector` and `./build/solve` to exercise local edits.
Tests use synthetic fixtures and mocked requests; they do not contact Kyara.

For an offline demonstration, import the synthetic fixture into a separate directory:

```sh
nix run .#scrap -- --import-raw tests/fixtures/raw.json \
  --verification tests/fixtures/verification.json \
  --database data/demo/kyara.sqlite --output data/demo/latest.json
nix run .#solve -- --dataset data/demo/latest.json
```

Replaying pinned software with the same dataset, ownership file, and arguments
reproduces scores and tie-breaking. Informational snapshot age changes with time.
The pinned OR-Tools package includes other backend libraries; Nix supplies them,
while this application uses CP-SAT exclusively.
