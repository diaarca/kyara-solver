# Kyara Solver

Rank Kyara boosters by profit, universe completion, or rebirth progress.
Use the browser extension (TypeScript / HiGHS), or the Python/C++ command line.

## Browser extension

Use desktop Chrome or a compatible Chromium browser on Windows, Linux, or macOS.
**No terminal, Nix, or Node.js is needed to install a downloaded build.**

### Download and install

1. Download **`kyara-solver.zip`** from the [Releases page](https://github.com/diaarca/kyara-solver/releases).
   If no packaged release is available, [download a CI build](#download-a-ci-build).
   Choose the extension ZIP, not GitHub's **Source code** archives.
2. **Extract the ZIP** into a folder you will keep, such as `Documents/kyara-solver`.
   The folder must contain `manifest.json`, `app.js`, and `vendor/`.
3. Open your browser's Extensions page:
   - Chrome: enter `chrome://extensions` in the address bar.
   - Vivaldi: enter `vivaldi://extensions`.
   - Edge: enter `edge://extensions`.
4. Enable **Developer mode**, click **Load unpacked**, and select the extracted
   folder containing `manifest.json`—not the ZIP or a parent folder.
5. Open [Kyara](https://kyara.games), log in, and click **Kyara Solver** in your
   browser's Extensions menu. You can pin it to the toolbar for easy access.
6. For boosters, click **Update prices** and optionally **Sync holdings & rebirth**,
   then choose your parameters and **Find best booster**. For purchase advice,
   open **Wishlist**, sync its price history, and choose **Find purchase priority**.

Keep the extracted folder in place: the browser loads the extension from it.
Keep the solver page and your logged-in Kyara tab open while collecting data.
The extension does not require AppleScript or the macOS browser-automation setting.
Calculations and data stay on your device; solving works offline with cached data.

### Download a CI build

CI builds are available before a release is published:

1. Sign in to GitHub and open the [CI workflow](https://github.com/diaarca/kyara-solver/actions/workflows/ci.yml?query=branch%3Amain).
2. Select a **successful run on `main`**. Under **Artifacts**, download
   **`kyara-solver-extension`**. Artifacts are retained for 14 days.
3. Extract the downloaded artifact archive, then extract the **`kyara-solver.zip`**
   inside it. Continue at installation step 3 above.

### Update an installed extension

Export a backup from **Import or export data** first; backups can include private
holdings and wishlist information. Download the new ZIP and replace the files in
the same installed folder, then click **Reload** on the Extensions page and reopen
Kyara Solver. Updates are manual; you do not need to remove the extension.

### Build from source (contributors)

```sh
nix build .#extension  # Load result/; distributable ZIP: result/kyara-solver.zip
# Or, with Node.js and Python 3 available:
cd extension
npm ci
npm run build         # Load extension/dist/ from the repository root
npm test
```

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

To compare the next 100 openings of each booster type, set **Number of boosters**
in the extension or run:

```sh
solve --purchase-mode free --horizon 100 --rebirth-state data/rebirth.json
```

The horizon defaults to 1. Totals account for duplicates across all openings and
remaining rebirth targets. Prices, pools and availability are held constant;
opening resources are assumed sufficient. This chooses one type, not a mix.
