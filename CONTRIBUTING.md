# Contributing

Check existing issues before reporting a bug or suggesting a feature. Use the issue
templates and include a small reproducible example. For larger changes, discuss
the approach in an issue first.

## Development

Fork the repository and create a branch from `main`.

```sh
nix develop
# Or use direnv with an .envrc containing: use flake
direnv allow
nix flake check
```

Run commands from the repository root. Register new files with `git add` or
`git add -N` so Git-backed Nix builds include them. See the [README](README.md)
for CLI commands and manual CMake builds.

For the extension, enter the development shell, then:

```sh
cd extension
npm ci
npm run build
npm test
npx playwright install --with-deps chromium
npm run test:browser
```

Load `extension/dist/` using your browser's **Load unpacked** option. Reload the
extension after rebuilding. Without Nix, install Node.js 22 and Python 3.13 first;
Windows users can use this extension workflow directly. Set `PYTHON` to your Python
executable if needed. Nix on Windows requires WSL2 for the CLI workflow.

## Changes and pull requests

- Follow nearby code: Python uses `snake_case`, TypeScript uses `camelCase`, and
  types/classes use `PascalCase`. Keep C++ compatible with C++20 and existing style.
- Keep changes focused. Document probability assumptions and user-visible changes.
- Add regression tests for changed calculations or behavior. Prefer synthetic
  fixtures and mocked requests; tests must not need a Kyara account or live API.
- Preserve deterministic scoring and parity between the C++ and browser solvers.
  `nix flake check` includes the cross-solver parity tests.
  CI runs these once through Nix, and builds and tests the extension UI on all
  three supported desktop platforms.
- Open a PR describing the change, related issue, and checks run. Include a
  screenshot for interface changes when useful.

Never commit credentials, raw HAR files, personal holdings, or account exports.
Use synthetic or reviewed, sanitized examples. Report security concerns privately
as described in [SECURITY.md](SECURITY.md).

Participation follows the [Code of Conduct](CODE_OF_CONDUCT.md). Contributions
are licensed under the project's [MIT license](LICENSE).
