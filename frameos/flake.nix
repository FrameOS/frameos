{
  description = "FrameOS for Raspberry Pi - packages, dev shells and flash-ready SD image";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";
    nixos-generators.url = "github:nix-community/nixos-generators";
    nixos-generators.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = { self, nixpkgs, nixos-generators, ... }@inputs:
  let
    # ──────────────────────────────────────────────────────────────────
    systems = [ "x86_64-linux" "aarch64-linux" ];
    forEach = f: builtins.listToAttrs (map (s: { name = s; value = f s; }) systems);

    overlaysList = import ./nixos/overlays;               # list ‑ not attrset
    pkgsFor = system: import nixpkgs {
      inherit system;
      overlays = overlaysList;
    };
  in
  rec {
    # Re‑expose overlays for other flakes
    overlays = overlaysList;

    # ──────────────────────────────────────────────────────────────────
    # Packages (+ SD‑image) for every host system
    # ──────────────────────────────────────────────────────────────────
    packages = forEach (system:
      let
        pkgs   = pkgsFor system;
        built  = import ./nixos/packages { inherit pkgs; };
      in
        built //
        {
          sdImage = nixos-generators.nixosGenerate {
            inherit system;
            format  = "sd-aarch64";
            modules = [
              self.nixosModules.rootfs
              self.nixosModules.frameos
              self.nixosModules.overrides
              self.nixosModules.hardware.pi-zero2  # will be swapped out
              self.nixosModules.custom
            ];
            specialArgs = { inherit self; };
          };
        });

    # ──────────────────────────────────────────────────────────────────
    # NixOS modules
    # ──────────────────────────────────────────────────────────────────
    nixosModules = {
      rootfs  = import ./nixos/modules/rootfs.nix;
      frameos = import ./nixos/modules/frameos.nix;
      overrides = import ./nixos/modules/overrides.nix;
      hardware = import ./nixos/modules/hardware;
      custom = import ./nixos/modules/custom.nix;
    };

    # ──────────────────────────────────────────────────────────────────
    # Example host configuration built from the modules
    # ──────────────────────────────────────────────────────────────────
    nixosConfigurations = {
      frame-host = nixpkgs.lib.nixosSystem {
        system  = "aarch64-linux";
        modules = [
          self.nixosModules.rootfs
          self.nixosModules.frameos
          self.nixosModules.overrides
          self.nixosModules.hardware.pi-zero2  # will be swapped out
          self.nixosModules.custom
        ];
        specialArgs = { inherit self; };  # expose `self` inside modules
      };
    };

    # ──────────────────────────────────────────────────────────────────
    # Dev‑shells
    # ──────────────────────────────────────────────────────────────────
    devShells = forEach (system:
      let pkgs = pkgsFor system; in {
        default = pkgs.mkShell { buildInputs = [ pkgs.git pkgs.nixfmt ]; };
        frameos = import ./nixos/shells/frameos.nix { inherit pkgs self system; };
      });
  };
}
