{
  description = "Development environment for the dashboardd dashboard";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
    rust-flake.url = "github:juspay/rust-flake";
  };

  outputs = inputs @ { flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      imports = [
        inputs.rust-flake.flakeModules.default
        inputs.rust-flake.flakeModules.nixpkgs
      ];

      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];

      perSystem = { config, lib, pkgs, ... }:
        let
          rustNightly = pkgs.rust-bin.nightly.latest.default.override {
            extensions = [ "rust-src" "clippy" "rustfmt" ];
          };
          tauriLinuxLibraries = lib.optionals pkgs.stdenv.isLinux [
            pkgs.webkitgtk_4_1
            pkgs.gtk3
            pkgs.libayatana-appindicator
            pkgs.librsvg
            pkgs.openssl
          ];
          dashboarddUnwrapped = config.rust-project.crates.dashboardd-server.crane.outputs.drv.crate;
          widgetTool = config.rust-project.crates.dashboardd-widget-bundle.crane.outputs.drv.crate;
          widgetIds = [
            "claude-usage"
            "codex-usage"
            "cpu"
            "disk"
            "memory"
            "network"
            "projects"
            "tatr-tasks"
          ];
          widgetBackends = lib.genAttrs widgetIds
            (id: config.rust-project.crates.${id}.crane.outputs.drv.crate);
          packWidgets = lib.concatMapStringsSep "\n" (id: ''
            mkdir -p widgets/${id}/dist/bin
            cp ${widgetBackends.${id}}/bin/${id} widgets/${id}/dist/bin/${id}
            dashboardd-widget pack widgets/${id}/widget.toml --output packed/${id}
          '') widgetIds;
          dashboardAssets = pkgs.buildNpmPackage {
            pname = "dashboardd-assets";
            version = "0.1.0";
            src = ./.;
            npmDepsHash = "sha256-3LPlqDfDZs53EHeWxxSvZSk7NGuO0Xaqh6h/Cyg3bIs=";
            nativeBuildInputs = [ widgetTool ];
            postBuild = ''
              mkdir packed
              ${packWidgets}
            '';
            installPhase = ''
              runHook preInstall
              mkdir -p "$out/share/dashboardd/web" "$out/share/dashboardd/widgets"
              cp -R web/dist/. "$out/share/dashboardd/web/"
              cp -R packed/. "$out/share/dashboardd/widgets/"
              runHook postInstall
            '';
          };
          bundledWidgets = pkgs.runCommand "dashboardd-bundled-widgets-0.1.0" {
            meta.description = "Built-in dashboardd runtime widget bundles";
          } ''
            mkdir -p "$out/share/dashboardd"
            ln -s ${dashboardAssets}/share/dashboardd/widgets "$out/share/dashboardd/widgets"
          '';
          dashboardd = pkgs.runCommand "dashboardd-0.1.0" {
            nativeBuildInputs = [ pkgs.makeWrapper ];
            meta = {
              description = "Local-first dashboard with web assets and built-in widgets";
              mainProgram = "dashboardd";
            };
          } ''
            mkdir -p "$out/bin" "$out/share/dashboardd"
            ln -s ${dashboardAssets}/share/dashboardd/web "$out/share/dashboardd/web"
            ln -s ${dashboardAssets}/share/dashboardd/widgets "$out/share/dashboardd/widgets"
            makeWrapper ${dashboarddUnwrapped}/bin/dashboardd "$out/bin/dashboardd" \
              --set-default DASHBOARDD_WEB_DIR "$out/share/dashboardd/web" \
              --set-default DASHBOARDD_WIDGET_PATH "$out/share/dashboardd/widgets"
          '';
          widgetSdk = pkgs.stdenvNoCC.mkDerivation {
            pname = "dashboardd-widget-sdk";
            version = "0.1.0";
            src = ./.;
            nativeBuildInputs = [ pkgs.nodejs_22 pkgs.typescript ];
            buildPhase = ''
              runHook preBuild
              export HOME="$TMPDIR/home"
              export npm_config_cache="$TMPDIR/npm-cache"
              mkdir -p "$HOME" "$npm_config_cache"
              cd packages/widget-sdk
              npm pack
              runHook postBuild
            '';
            installPhase = ''
              runHook preInstall
              mkdir -p "$out"
              cp dashboardd-widget-sdk-*.tgz "$out/"
              runHook postInstall
            '';
          };
          docs = pkgs.stdenvNoCC.mkDerivation {
            pname = "dashboardd-docs";
            version = "0.1.0";
            src = ./.;
            nativeBuildInputs = [ pkgs.mdbook pkgs.mdbook-mermaid ];
            buildPhase = ''
              runHook preBuild
              mdbook-mermaid install docs
              mdbook build docs
              runHook postBuild
            '';
            installPhase = ''
              runHook preInstall
              mkdir -p "$out"
              cp -R docs/book/. "$out/"
              cp -R schemas "$out/schemas"
              runHook postInstall
            '';
          };
        in {
          rust-project.src = lib.cleanSourceWith {
            src = ./.;
            filter = config.rust-project.crane-lib.filterCargoSources;
          };
          rust-project.crates.projects.crane.args.nativeBuildInputs = [ pkgs.git ];
          rust-project.crates.tatr-tasks.crane.args.nativeBuildInputs = [ pkgs.git ];

          packages.bundled-widgets = bundledWidgets;
          packages.dashboardd = lib.mkForce dashboardd;
          packages.dashboardd-unwrapped = dashboarddUnwrapped;
          packages.docs = docs;
          packages.widget-sdk = widgetSdk;
          checks.docs = docs;
          checks.widget-bundle = pkgs.runCommand "dashboardd-widget-bundle-check" {
            nativeBuildInputs = [ widgetTool ];
          } ''
            cp -R ${./tests/fixtures/external-widget} source
            chmod -R u+w source
            dashboardd-widget pack source/widget.toml --output external-fixture
            dashboardd-widget check external-fixture
            touch $out
          '';
          checks.dashboardd-package = pkgs.runCommand "dashboardd-package-check" {
            nativeBuildInputs = [ dashboardd pkgs.curl pkgs.jq widgetTool ];
          } ''
            test -f ${dashboardd}/share/dashboardd/web/index.html
            for bundle in ${dashboardd}/share/dashboardd/widgets/*; do
              dashboardd-widget check "$bundle"
            done
            mkdir external-widgets
            ln -s ${./tests/fixtures/external-widget} external-widgets/external-fixture
            export DASHBOARDD_WIDGET_PATH="${bundledWidgets}/share/dashboardd/widgets:$PWD/external-widgets"
            export DASHBOARDD_PORT=17321
            export DASHBOARDD_STATE_FILE="$TMPDIR/runtime.json"
            export DASHBOARDD_CONFIG_FILE="$TMPDIR/config.toml"
            dashboardd >dashboardd.log 2>&1 &
            pid=$!
            trap 'kill "$pid" 2>/dev/null || true' EXIT
            ready=0
            for _ in $(seq 1 50); do
              if curl --fail --silent http://127.0.0.1:17321/health >/dev/null; then
                ready=1
                break
              fi
              sleep 0.1
            done
            if [ "$ready" -ne 1 ]; then
              cat dashboardd.log
              exit 1
            fi
            test "$(curl --fail --silent http://127.0.0.1:17321/api/v1/widgets | jq '.widgets | length')" -eq ${toString (builtins.length widgetIds + 1)}
            kill -INT "$pid"
            wait "$pid"
            trap - EXIT
            touch "$out"
          '';
          checks.widget-sdk = widgetSdk;

          devShells.default = pkgs.mkShell {
            packages = [
              rustNightly
              pkgs.nodejs_22
              pkgs.chromium
              pkgs.rust-analyzer
              pkgs.python3
              pkgs.mdbook
              pkgs.mdbook-mermaid
            ] ++ lib.optionals pkgs.stdenv.isLinux [
              pkgs.pkg-config
            ] ++ tauriLinuxLibraries;

            LD_LIBRARY_PATH = lib.makeLibraryPath tauriLinuxLibraries;
            RUST_SRC_PATH = "${rustNightly}/lib/rustlib/src/rust/library";
            CHROMIUM_PATH = "${pkgs.chromium}/bin/chromium";
          };
        };
    };
}
