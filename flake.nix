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
        in {
          devShells.default = pkgs.mkShell {
            packages = [
              rustNightly
              pkgs.nodejs_22
              pkgs.chromium
              pkgs.rust-analyzer
            ];

            RUST_SRC_PATH = "${rustNightly}/lib/rustlib/src/rust/library";
            CHROMIUM_PATH = "${pkgs.chromium}/bin/chromium";
          };
        };
    };
}
