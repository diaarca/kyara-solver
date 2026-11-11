{
  description = "Kyara booster optimizer: browser extension with HiGHS and Python/C++ CLI";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/6dadaf4375be35033e1c84395adbd53ff5fded96";
  outputs = { self, nixpkgs }:
    let
      systems = [ "aarch64-darwin" "x86_64-darwin" "aarch64-linux" "x86_64-linux" ];
      eachSystem = nixpkgs.lib.genAttrs systems;
      forSystem = system:
        let
          pkgs = import nixpkgs { inherit system; };
          source = pkgs.lib.fileset.toSource {
            root = ./.;
            fileset = pkgs.lib.fileset.unions [
              (pkgs.lib.fileset.fileFilter (file: file.hasExt "cpp" || file.hasExt "h") ./src)
              (pkgs.lib.fileset.fileFilter (file: file.hasExt "py") ./python)
              (pkgs.lib.fileset.fileFilter (file: file.hasExt "py" || file.hasExt "json") ./tests)
              ./CMakeLists.txt ./pyproject.toml ./README.md ./LICENSE
            ];
          };
          collector = pkgs.python3Packages.buildPythonApplication {
            pname = "kyara-collector";
            version = "0.1.0";
            src = source;
            pyproject = true;
            build-system = [ pkgs.python3Packages.setuptools ];
            pythonImportsCheck = [ "kyara.collector" ];
            meta.mainProgram = "scrap";
            meta.license = pkgs.lib.licenses.mit;
          };
          solver = pkgs.stdenv.mkDerivation {
            pname = "kyara-solver";
            version = "0.1.0";
            src = source;
            nativeBuildInputs = [ pkgs.cmake pkgs.ninja pkgs.pkg-config ];
            # OR-Tools' CMake config also requires its bundled backend targets.
            buildInputs = [
              pkgs.or-tools pkgs.nlohmann_json pkgs.zlib pkgs.bzip2 pkgs.eigen
              pkgs.cbc pkgs.cgl pkgs.clp pkgs.osi pkgs.coin-utils pkgs.glpk
              (pkgs.re2.override { abseil-cpp = pkgs.abseil-cpp_202508; })
            ];
            nativeCheckInputs = [ pkgs.python3 ];
            doCheck = true;
            checkPhase = ''
              runHook preCheck
              ctest --output-on-failure
              runHook postCheck
            '';
            meta.mainProgram = "solve";
            meta.license = pkgs.lib.licenses.mit;
          };
          extension = pkgs.buildNpmPackage {
            pname = "kyara-extension";
            version = "0.1.0";
            src = pkgs.lib.fileset.toSource {
              root = ./.;
              fileset = pkgs.lib.fileset.unions [
                ./extension/src ./extension/test
                ./extension/package.json ./extension/package-lock.json
                ./extension/tsconfig.json ./extension/build.mjs
                ./extension/manifest.json ./extension/index.html ./extension/style.css
                ./extension/THIRD_PARTY_LICENSES.txt ./LICENSE
                (pkgs.lib.fileset.fileFilter (file: file.hasExt "py") ./python)
                ./tests/fixtures
              ];
            };
            sourceRoot = "source/extension";
            npmDepsHash = "sha256-k51sBpytRE2COp/XRvxo6vW++tRWfOcOa5QsvY5RKLI=";
            nativeBuildInputs = [ pkgs.zip ];
            nativeCheckInputs = [ pkgs.python3 solver ];
            env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
            doCheck = true;
            meta.license = pkgs.lib.licenses.mit;
            checkPhase = ''
              runHook preCheck
              KYARA_SOLVER=${solver}/bin/solve npm test
              runHook postCheck
            '';
            installPhase = ''
              runHook preInstall
              export TZ=UTC
              find dist -exec touch -t 198001010000 {} +
              mkdir -p "$out"
              cp -r dist/. "$out/"
              (
                cd dist
                find . -type f | LC_ALL=C sort | zip -Xq "$out/kyara-solver.zip" -@
              )
              runHook postInstall
            '';
          };
          build-extension = pkgs.writeShellApplication {
            name = "build-extension";
            runtimeInputs = [ pkgs.nodejs ];
            text = ''
              if [[ ! -f extension/package.json || ! -f extension/build.mjs ]]; then
                echo "Run build-extension from the repository root." >&2
                exit 1
              fi
              cd extension
              export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
              npm ci --no-audit --no-fund
              npm run build
              echo "Built extension/dist/. Reload Kyara Solver in your browser's Extensions page."
            '';
          };
        in { inherit pkgs collector solver extension build-extension; };
    in {
      packages = eachSystem (system: let p = forSystem system; in {
        inherit (p) collector solver extension;
        default = p.solver;
      });
      apps = eachSystem (system: let p = forSystem system; in {
        build-extension = { type = "app"; program = "${p.build-extension}/bin/build-extension"; meta.description = "Rebuild the unpacked Chrome extension in extension/dist"; };
        scrap = { type = "app"; program = "${p.collector}/bin/scrap"; meta.description = "Update the Kyara database and JSON snapshot"; };
        solve = { type = "app"; program = "${p.solver}/bin/solve"; meta.description = "Choose a booster using profit and collection objectives"; };
        default = { type = "app"; program = "${p.solver}/bin/solve"; meta.description = "Choose a booster using CP-SAT"; };
      });
      checks = eachSystem (system: let p = forSystem system; in {
        inherit (p) collector solver extension;
      });
      devShells = eachSystem (system: let p = forSystem system; in {
        default = p.pkgs.mkShell {
          inputsFrom = [ p.solver p.collector ];
          # Executable wrappers also work with direnv, which does not export
          # shell functions. Keep apps pointing at the actual packages above.
          packages = [
            p.build-extension
            p.pkgs.python3 p.pkgs.python3Packages.setuptools p.pkgs.nodejs
            (p.pkgs.writeShellScriptBin "scrap" ''
              exec nix run .#scrap -- "$@"
            '')
            (p.pkgs.writeShellScriptBin "solve" ''
              exec nix run .#solve -- "$@"
            '')
          ];
          shellHook = ''
            export PYTHONPATH="$PWD/python''${PYTHONPATH:+:$PYTHONPATH}"
          '';
        };
      });
    };
}
