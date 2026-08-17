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

      perSystem = { config, pkgs, ... }:
        let
          rustNightly = pkgs.rust-bin.nightly.latest.default.override {
            extensions = [ "rust-src" "clippy" "rustfmt" ];
          };
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
          packages.docs = docs;
          packages.widget-sdk = widgetSdk;
          checks.docs = docs;
          checks.widget-bundle = pkgs.runCommand "dashboardd-widget-bundle-check" {
            nativeBuildInputs = [ config.packages.dashboardd-widget ];
          } ''
            cp -R ${./tests/fixtures/external-widget} source
            chmod -R u+w source
            dashboardd-widget pack source/widget.toml --output external-fixture
            dashboardd-widget check external-fixture
            touch $out
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
            ];

            RUST_SRC_PATH = "${rustNightly}/lib/rustlib/src/rust/library";
            CHROMIUM_PATH = "${pkgs.chromium}/bin/chromium";
          };
        };
    };
}
