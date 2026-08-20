{
  description = "Development environment for the dashboardd dashboard";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
    rust-flake.url = "github:juspay/rust-flake";
  };

  outputs =
    inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      imports = [
        inputs.rust-flake.flakeModules.default
        inputs.rust-flake.flakeModules.nixpkgs
      ];

      flake.homeManagerModules =
        let
          module =
            { pkgs, ... }@moduleArgs:
            import ./nix/home-manager.nix (
              moduleArgs
              // {
                dashboarddPackages =
                  let
                    system = moduleArgs.pkgs.stdenv.hostPlatform.system;
                  in
                  {
                    server = inputs.self.packages.${system}.dashboardd;
                    desktop = inputs.self.packages.${system}.dashboardd-desktop;
                  };
              }
            );
        in
        {
          default = module;
          dashboardd = module;
        };

      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];

      perSystem =
        {
          config,
          lib,
          pkgs,
          ...
        }:
        let
          rustNightly = pkgs.rust-bin.nightly.latest.default.override {
            extensions = [
              "rust-src"
              "clippy"
              "rustfmt"
            ];
          };
          tauriLinuxLibraries = lib.optionals pkgs.stdenv.isLinux [
            pkgs.webkitgtk_4_1
            pkgs.gtk3
            pkgs.libayatana-appindicator
            pkgs.librsvg
            pkgs.openssl
          ];
          dashboarddUnwrapped = config.rust-project.crates.dashboardd-server.crane.outputs.drv.crate;
          dashboarddDesktopUnwrapped = config.rust-project.crates.dashboardd-desktop.crane.outputs.drv.crate;
          dashboarddDesktopControl =
            config.rust-project.crates.dashboardd-desktop-control.crane.outputs.drv.crate;
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
          widgetBackends = lib.genAttrs widgetIds (
            id: config.rust-project.crates.${id}.crane.outputs.drv.crate
          );
          packWidgets = lib.concatMapStringsSep "\n" (id: ''
            mkdir -p widgets/${id}/dist/bin
            cp ${widgetBackends.${id}}/bin/${id} widgets/${id}/dist/bin/${id}
            dashboardd-widget pack widgets/${id}/widget.toml --output packed/${id}
          '') widgetIds;
          dashboardAssets = pkgs.buildNpmPackage {
            pname = "dashboardd-assets";
            version = "0.2.0";
            src = ./.;
            npmDepsHash = "sha256-VcmOwf1kYWEy3cVNnw0EzdEzuxfs4NSiid0OVMOL6yc=";
            nativeBuildInputs = [ widgetTool ];
            postBuild = ''
              mkdir packed
              ${packWidgets}
            '';
            installPhase = ''
              runHook preInstall
              mkdir -p "$out/share/dashboardd/web" "$out/share/dashboardd/widgets" \
                "$out/share/dashboardd-desktop/frontend"
              cp -R crates/dashboardd-server/frontend/dist/. "$out/share/dashboardd/web/"
              cp -R crates/dashboardd-desktop/frontend/dist "$out/share/dashboardd-desktop/frontend/"
              cp -R packed/. "$out/share/dashboardd/widgets/"
              runHook postInstall
            '';
          };
          bundledWidgets =
            pkgs.runCommand "dashboardd-bundled-widgets-0.2.0"
              {
                meta.description = "Built-in dashboardd runtime widget bundles";
              }
              ''
                mkdir -p "$out/share/dashboardd"
                ln -s ${dashboardAssets}/share/dashboardd/widgets "$out/share/dashboardd/widgets"
              '';
          dashboardd =
            pkgs.runCommand "dashboardd-0.2.0"
              {
                nativeBuildInputs = [ pkgs.makeWrapper ];
                meta = {
                  description = "Local-first dashboard with web assets and built-in widgets";
                  mainProgram = "dashboardd";
                };
              }
              ''
                mkdir -p "$out/bin" "$out/share/dashboardd"
                ln -s ${dashboardAssets}/share/dashboardd/web "$out/share/dashboardd/web"
                ln -s ${dashboardAssets}/share/dashboardd/widgets "$out/share/dashboardd/widgets"
                makeWrapper ${dashboarddUnwrapped}/bin/dashboardd "$out/bin/dashboardd" \
                  --set-default DASHBOARDD_WEB_DIR "$out/share/dashboardd/web" \
                  --set-default DASHBOARDD_WIDGET_PATH "$out/share/dashboardd/widgets"
              '';
          dashboarddDesktop =
            pkgs.runCommand "dashboardd-desktop-0.2.0"
              {
                nativeBuildInputs = [ pkgs.makeWrapper ];
                meta = {
                  description = "On-demand Dashboardd tray service and native widget host";
                  mainProgram = "dashboardd-desktop";
                  platforms = lib.platforms.linux;
                };
              }
              ''
                mkdir -p "$out/bin" "$out/share/dashboardd" "$out/share/applications" \
                  "$out/share/icons/hicolor/scalable/apps"
                ln -s ${dashboardAssets}/share/dashboardd/widgets "$out/share/dashboardd/widgets"
                makeWrapper ${dashboarddDesktopUnwrapped}/bin/dashboardd-desktop "$out/bin/dashboardd-desktop" \
                  --set-default DASHBOARDD_WIDGET_PATH "$out/share/dashboardd/widgets" \
                  --prefix LD_LIBRARY_PATH : ${lib.makeLibraryPath tauriLinuxLibraries}
                ln -s ${dashboarddDesktopControl}/bin/dashboardctl "$out/bin/dashboardctl"
                cat >"$out/bin/dashboardd-desktop-start" <<EOF
                #!${pkgs.runtimeShell}
                exec ${pkgs.systemd}/bin/systemctl --user start dashboardd-desktop.service
                EOF
                chmod +x "$out/bin/dashboardd-desktop-start"
                cp ${./crates/dashboardd-desktop/icons/dashboardd.svg} \
                  "$out/share/icons/hicolor/scalable/apps/dashboardd.svg"
                cat >"$out/share/applications/dashboardd.desktop" <<EOF
                [Desktop Entry]
                Type=Application
                Name=Dashboardd
                Comment=Start the Dashboardd native widget host
                Exec=$out/bin/dashboardd-desktop-start
                Icon=dashboardd
                Terminal=false
                Categories=Utility;
                EOF
              '';
          widgetSdk = pkgs.stdenvNoCC.mkDerivation {
            pname = "dashboardd-widget-sdk";
            version = "0.2.0";
            src = ./.;
            nativeBuildInputs = [
              pkgs.nodejs_22
              pkgs.typescript
            ];
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
            version = "0.2.0";
            src = ./.;
            nativeBuildInputs = [
              pkgs.mdbook
              pkgs.mdbook-mermaid
            ];
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
        in
        {
          rust-project.src = lib.cleanSourceWith {
            src = ./.;
            filter = config.rust-project.crane-lib.filterCargoSources;
          };
          rust-project.crates.projects.crane.args.nativeBuildInputs = [ pkgs.git ];
          rust-project.crates.tatr-tasks.crane.args.nativeBuildInputs = [ pkgs.git ];
          rust-project.crates.dashboardd-desktop.crane.args = {
            nativeBuildInputs = [ pkgs.pkg-config ];
            buildInputs = tauriLinuxLibraries;
            preBuild = ''
              mkdir -p crates/dashboardd-desktop/frontend
              rm -rf crates/dashboardd-desktop/frontend/dist crates/dashboardd-desktop/icons
              cp -R ${dashboardAssets}/share/dashboardd-desktop/frontend/dist \
                crates/dashboardd-desktop/frontend/dist
              cp -R ${./crates/dashboardd-desktop/icons} crates/dashboardd-desktop/icons
              cp ${./crates/dashboardd-desktop/tauri.conf.json} \
                crates/dashboardd-desktop/tauri.conf.json
            '';
          };

          packages.bundled-widgets = bundledWidgets;
          packages.dashboardd = lib.mkForce dashboardd;
          packages.dashboardd-desktop = lib.mkForce dashboarddDesktop;
          packages.dashboardd-unwrapped = dashboarddUnwrapped;
          packages.docs = docs;
          packages.widget-sdk = widgetSdk;
          apps.dashboardd-desktop = {
            type = "app";
            program = "${dashboarddDesktop}/bin/dashboardd-desktop";
          };
          checks.docs = docs;
          checks.widget-bundle =
            pkgs.runCommand "dashboardd-widget-bundle-check"
              {
                nativeBuildInputs = [ widgetTool ];
              }
              ''
                cp -R ${./tests/fixtures/external-widget} source
                chmod -R u+w source
                dashboardd-widget pack source/widget.toml --output external-fixture
                dashboardd-widget check external-fixture
                touch $out
              '';
          checks.dashboardd-desktop-package = pkgs.runCommand "dashboardd-desktop-package-check" { } ''
            test -x ${dashboarddDesktop}/bin/dashboardd-desktop
            test -x ${dashboarddDesktop}/bin/dashboardctl
            test -x ${dashboarddDesktop}/bin/dashboardd-desktop-start
            test -f ${dashboarddDesktop}/share/applications/dashboardd.desktop
            test -f ${dashboarddDesktop}/share/icons/hicolor/scalable/apps/dashboardd.svg
            test -d ${dashboarddDesktop}/share/dashboardd/widgets/tatr-tasks
            touch $out
          '';
          checks.dashboardd-package =
            pkgs.runCommand "dashboardd-package-check"
              {
                nativeBuildInputs = [
                  dashboardd
                  pkgs.curl
                  pkgs.jq
                  widgetTool
                ];
              }
              ''
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
                test "$(curl --fail --silent http://127.0.0.1:17321/api/v1/widgets | jq '.widgets | length')" -eq ${
                  toString (builtins.length widgetIds + 1)
                }
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
            ]
            ++ lib.optionals pkgs.stdenv.isLinux [
              pkgs.pkg-config
            ]
            ++ tauriLinuxLibraries;

            LD_LIBRARY_PATH = lib.makeLibraryPath tauriLinuxLibraries;
            RUST_SRC_PATH = "${rustNightly}/lib/rustlib/src/rust/library";
            CHROMIUM_PATH = "${pkgs.chromium}/bin/chromium";
          };
        };
    };
}
