{
  description = "wstn-cua: isolated Weston sandbox and live portal for OpenAI computer-use agents";

  # Pinned to the stable branch on purpose: weston 16 (unstable) deprecates the
  # pipewire/remoting backends and nixpkgs defaults them off, which breaks capture.
  inputs.nixpkgs.url = "nixpkgs/nixos-26.05";

  outputs =
    {
      self,
      nixpkgs,
    }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          name = "wstn-cua";
          packages = with pkgs; [
            # compositor + multimedia runtime
            weston
            pipewire
            # native module build (libwstn_injector.so, pw_stream)
            gcc
            gnumake
            pkg-config
            wayland
            libxkbcommon
            libjpeg_turbo
            pixman
            # gateway + tests
            bun
            curl
          ];
          shellHook = ''
            echo "wstn-cua dev shell (weston $(weston --version | awk '{print $2}'), bun $(bun --version))"
            echo "  make            build native modules and type-check TypeScript"
            echo "  make test       run the full test suite against a real weston"
            echo "  bin/wstn-cua start"
          '';
        };
      });
    };
}
