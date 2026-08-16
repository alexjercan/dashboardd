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

      perSystem = { pkgs, ... }:
        let
          rustNightly = pkgs.rust-bin.nightly.latest.default.override {
            extensions = [ "rust-src" "clippy" "rustfmt" ];
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
          checks.docs = docs;

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
