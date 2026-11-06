# Kyara Solver

Rank Kyara boosters by profit, universe completion, or rebirth progress.
Use the browser extension (TypeScript / HiGHS), or the Python/C++ command line.

## Browser extension

The extension runs locally on desktop Chrome and compatible Chromium browsers, on Windows, Linux, and macOS. Users need no terminal or server.

1. Open the browser's Extensions page and enable **Developer mode**.
2. Choose **Load unpacked** and select the built extension folder (see below).
3. Click the extension icon. Keep Kyara open and logged in, then choose **Update
   prices** and optionally **Sync holdings & rebirth**.
4. Choose free/paid boosters, a goal, universes, and a profit weight; click
   **Find best booster**.

Collection runs in the Kyara tab without AppleScript. Prices, holdings, parameters,
and results stay on the device. Solving works offline with cached data. The page
supports importing CLI `data/latest.json`, backups, and exporting results and the
HiGHS MILP model (`.lp`). Keep backups private: they can include owned card IDs.

Build/package for distribution (contributors only):

```sh
nix build .#extension  # Load result/; distributable archive: result/kyara-solver.zip
# Or, with Node.js and Python 3 available:
cd extension
npm ci
npm run build         # Load extension/dist/ from the repository root
npm test
```

An archive recipient can unzip it and load the folder without build tools.
This version is unpacked; it has not been published to the Chrome Web Store.
Successful [CI runs](https://github.com/diaarca/kyara-solver/actions/workflows/ci.yml)
provide a `kyara-solver-extension` artifact for 14 days. Extract the artifact,
then extract its `kyara-solver.zip` and load the folder containing `manifest.json`.

## Command-line setup

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
`extension/src/` contains the form, browser collector, validation, and HiGHS worker.
`extension/test/` checks the browser implementation against CLI fixtures. For the
end-to-end extension test, run `npx playwright install chromium` and
`npm run test:browser` inside `extension/`. Its Kyara requests are mocked.
Run manual builds with `./build/solve`, or Python directly with
`python -m kyara.collector`. See [the technical reference](docs/model.md) for
formulas, probability assumptions, and data formats.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and pull requests, the
[Code of Conduct](CODE_OF_CONDUCT.md) for community guidelines, and
[SECURITY.md](SECURITY.md) for private vulnerability reports. CI checks the
extension on Linux, macOS, and Windows, plus the Nix builds and solver parity on
Linux. Tests use mocked Kyara responses and require no account credentials.

## License

Project code is licensed under [MIT](LICENSE). Dependencies retain their own
licenses; the extension includes its [third-party notices](extension/THIRD_PARTY_LICENSES.txt).
Kyara and third-party card artwork, names, and other game content remain the
property of their respective owners. This is an independent community project.
