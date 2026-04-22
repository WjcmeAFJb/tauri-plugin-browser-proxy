{
  description = "tauri-plugin-browser-proxy dev shell: build and run a Tauri app whose webview is mirrored to an ordinary browser tab.";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    rust-overlay.url = "github:oxalica/rust-overlay";
    rust-overlay.inputs.nixpkgs.follows = "nixpkgs";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, rust-overlay, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        overlays = [ (import rust-overlay) ];
        pkgs = import nixpkgs { inherit system overlays; };

        rustToolchain = pkgs.rust-bin.stable.latest.default.override {
          extensions = [ "rust-src" "rust-analyzer" "clippy" ];
        };

        # Native dependencies Tauri needs at runtime on Linux.
        linuxRuntimeDeps = with pkgs; lib.optionals stdenv.isLinux [
          webkitgtk_4_1
          gtk3
          cairo
          gdk-pixbuf
          glib
          dbus
          openssl
          librsvg
          libsoup_3
          xdotool
          libayatana-appindicator
        ];

        darwinDeps = with pkgs; lib.optionals stdenv.isDarwin [
          darwin.apple_sdk.frameworks.WebKit
          darwin.apple_sdk.frameworks.AppKit
          darwin.apple_sdk.frameworks.Security
          darwin.apple_sdk.frameworks.CoreServices
        ];
      in {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            rustToolchain
            nodejs_20
            pnpm
            pkg-config
            openssl
            # Browser for E2E + manual verification.
            chromium
            # Playwright browsers are pulled per-project; chromium is kept as a fallback.
          ] ++ linuxRuntimeDeps ++ darwinDeps;

          # Tauri expects these when building.
          shellHook = ''
            export PKG_CONFIG_PATH="${pkgs.openssl.dev}/lib/pkgconfig:$PKG_CONFIG_PATH"
            export LD_LIBRARY_PATH="${pkgs.lib.makeLibraryPath linuxRuntimeDeps}:$LD_LIBRARY_PATH"
            export PLAYWRIGHT_BROWSERS_PATH="${pkgs.playwright-driver.browsers}"
            export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true
            echo "tauri-vite-proxy dev shell ready"
            echo "  node: $(node --version)   pnpm: $(pnpm --version)   rust: $(rustc --version | head -c 40)"
          '';
        };
      });
}
