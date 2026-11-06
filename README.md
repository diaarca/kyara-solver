# Kyara Solver

Python collects card prices and booster odds; C++20 / OR-Tools CP-SAT ranks
boosters by profit, universe completion, or rebirth progress.

## Setup

```sh
nix develop
# Or use direnv with an .envrc containing: use flake
direnv allow
```

Run commands from the project root. `scrap` and `solve` wrap `nix run .#scrap --`
and `nix run .#solve --`: changed sources rebuild automatically; unchanged builds
are cached. Use `direnv reload` after environment changes. New source files must
be known to Git (`git add` or `git add -N`). Dependencies are pinned in `flake.lock`.
ARM macOS is tested; Intel macOS and ARM/Intel Linux outputs are also defined.

## Collect

On macOS, keep Kyara logged in to Vivaldi and enable **Settings → Privacy →
Apple Events → Allow JavaScript from Apple Events**, with macOS automation access.
Credentials stay in the browser. The default transport uses Vivaldi on macOS;
HTTP elsewhere may require `KYARA_TOKEN` and `KYARA_DEVICE_ID`.

```sh
scrap                                # Refresh prices; full collection on first run
scrap --full-refresh                 # Refresh catalogue, pools, odds, and prices
scrap --rebirth-state data/rebirth.json  # Sync holdings and rebirth targets only
```

Prices are fetched in batches of 200. Refresh metadata after pool/rule changes;
refresh rebirth state after openings, trades, or rebirth. Collection is read-only.

| File | Purpose |
| --- | --- |
| `data/raw.json` | Latest API response bundle, reused for price refreshes |
| `data/verification.json` | Probability models and validation evidence |
| `data/latest.json` | Solver input |
| `data/snapshots/` | Archived solver inputs |
| `data/kyara.sqlite` | Response checkpoints and snapshot history |
| `data/rebirth.json` | Optional rebirth targets and unique holdings |

Data stays local and ignored by Git. Failed collection preserves the last completed
JSON export. Save the dataset, holdings, and lock file to replay a result.

## Solve

```sh
solve                                # Paid boosters, expected profit
solve --purchase-mode free           # Free-token boosters, expected profit
solve universes                      # Available universe names
solve --purchase-mode free --universe "Black Clover" \
  --owned owned.json --profit-weight 0.5
solve --purchase-mode free --rebirth-state data/rebirth.json
solve owned add --owned owned.json --card-id 123
solve owned remove --owned owned.json --card-id 123
solve owned list --owned owned.json
```

`--profit-weight`: **1** profit, **0** progress, **0.5** equal normalized influence.
Repeat `--universe` for several universes. Completion rewards distinct missing
cards; owned cards still have resale value. Rebirth rewards the expected fraction
of each unfinished rarity gap filled, capped at its target. It defaults to weight
0, includes holdings, and cannot be combined with `--owned` or `--universe`.
Only rarity requirements are considered; this does not establish rebirth eligibility.

Other options: `--dataset PATH`, `--median-window 7d|30d`, `--fee FRACTION`,
`--format text|json`. See `solve --help` and `scrap --help` for all options.
Solving uses saved files and works offline.

Paid mode subtracts cost; free mode considers free-token and zero-cost packs.
Missing prices exclude boosters when profit has positive weight. Unverified odds
are excluded. Golden, pity, and god-pack effects are not modeled. Historical
medians do not guarantee sale prices. The tool never opens packs or trades.
Exit codes: 0 success, 2 invalid input/collection failure, 3 no eligible booster.

## Development

```sh
nix flake check
# Optional manual build inside nix develop:
cmake -S . -B build -G Ninja
cmake --build build
ctest --test-dir build --output-on-failure
```

`python/kyara/` collects and validates data; `src/` implements scoring and CP-SAT;
`tests/` uses synthetic fixtures and mocked requests, without contacting Kyara.
Run manual builds with `./build/solve`, or Python directly with
`python -m kyara.collector`. See [the technical reference](docs/model.md) for
formulas, probability assumptions, and data formats.
