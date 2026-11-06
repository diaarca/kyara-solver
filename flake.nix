{
  description = "Kyara: scrap updates snapshots; solve ranks boosters with CP-SAT";
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
              ./CMakeLists.txt ./pyproject.toml ./README.md
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
          };
          solver = pkgs.stdenv.mkDerivation {
            pname = "kyara-solver";
            version = "0.1.0";
            src = source;
            nativeBuildInputs = [ pkgs.cmake pkgs.ninja pkgs.pkg-config ];
            # The cached nixpkgs OR-Tools package exports its backend targets in
            # its CMake config. Supply their headers/libraries even though our
            # executable uses only CP-SAT; no backend is installed by the user.
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
          };
        in { inherit pkgs collector solver; };
    in {
      packages = eachSystem (system: let p = forSystem system; in {
        inherit (p) collector solver;
        default = p.solver;
      });
      # nix run .#scrap -- --help: collect live responses or import browser JSON.
      # nix run .#solve -- --help: rank, list universes, and manage owned IDs.
      apps = eachSystem (system: let p = forSystem system; in {
        scrap = { type = "app"; program = "${p.collector}/bin/scrap"; meta.description = "Update the Kyara database and JSON snapshot"; };
        solve = { type = "app"; program = "${p.solver}/bin/solve"; meta.description = "Choose a booster using profit and collection objectives"; };
        default = { type = "app"; program = "${p.solver}/bin/solve"; meta.description = "Choose a booster using CP-SAT"; };
      });
      checks = eachSystem (system: let p = forSystem system; in {
        inherit (p) collector solver;
      });
      devShells = eachSystem (system: let p = forSystem system; in {
        default = p.pkgs.mkShell {
          inputsFrom = [ p.solver p.collector ];
          packages = [ p.pkgs.python3 p.pkgs.python3Packages.setuptools p.collector p.solver ];
          shellHook = ''
            export PYTHONPATH="$PWD/python''${PYTHONPATH:+:$PYTHONPATH}"
            echo 'scrap --help: update data; solve --help: rank boosters'
            echo 'Build local changes: cmake -S . -B build -G Ninja && cmake --build build'
            echo 'Test local changes: ctest --test-dir build --output-on-failure'
          '';
        };
      });
    };
}
