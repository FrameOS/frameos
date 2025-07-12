{
  description = "Raspberry Pi 4 system with custom lgpio derivation";

  inputs.nixpkgs.url = "nixpkgs/nixos-unstable";
  inputs.nixos-generators = {
    url = "github:nix-community/nixos-generators";
    inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = { self, nixpkgs, nixos-generators, ... }:
  let
    # A helper so we can create pkgs for any host/target.
    mkPkgsFor = system: import nixpkgs {
      inherit system;
      overlays = [
        # -------------------------
        # BEGIN: The lgpio overlay
        # -------------------------
        (final: prev: {
          lgpio = prev.stdenv.mkDerivation {
            pname = "lgpio";
            version = "0.2.2";

            src = prev.fetchFromGitHub {
              owner   = "joan2937";
              repo    = "lg";
              rev     = "v0.2.2";
              sha256  = "sha256-92lLV+EMuJj4Ul89KIFHkpPxVMr/VvKGEocYSW2tFiE=";
            };

            nativeBuildInputs = [ prev.pkg-config ];
            buildInputs       = [ ];

            phases = [ "unpackPhase" "patchPhase" "buildPhase" "installPhase" ];

            buildPhase = ''make'';

            installPhase = ''
              make DESTDIR=$out install
              mkdir -p $out/include
              if [ -d $out/usr/local/include ]; then
                mv $out/usr/local/include/* $out/include/
              fi
              mkdir -p $out/lib
              if [ -d $out/usr/local/lib ]; then
                mv $out/usr/local/lib/* $out/lib/
              fi
              rm -rf $out/usr
              patchelf --shrink-rpath $out/lib/*.so* || true
            '';

            meta = with prev.lib; {
              description = "GPIO library and tools by joan2937 (author of pigpio)";
              homepage    = "https://github.com/joan2937/lg";
              license     = licenses.gpl3;
              platforms   = platforms.linux;
            };
          };
        })
        # -------------------------
        # END: The lgpio overlay
        # -------------------------
      ];
    };

    # Convenience list of the two host systems we care about.
    allSystems = [ "x86_64-linux" "aarch64-linux" ];

    # Generate an attr-set like { x86_64-linux = pkgs; aarch64-linux = pkgs; }
    pkgsFor = builtins.listToAttrs
      (map (s: { name = s; value = mkPkgsFor s; }) allSystems);
  in
  {
    ########################################################################
    ## NixOS modules and SD-card image (unchanged)
    ########################################################################
    nixosModules = {
      system = { config, pkgs, ... }: {
        nix.settings.experimental-features = [ "nix-command" "flakes" ];
        disabledModules = [ "profiles/base.nix" ];

        # TODO: Set the hostname to something meaningful
        networking.hostName = "frame-df3e129a";
        # TODO: Set the timezone to something meaningful
        time.timeZone = "Europe/Brussels";

        networking.useDHCP = true;
        networking.wireless.enable = true;
        networking.wireless.networks = {
          # TODO: Replace with your actual Wi-Fi network
          "xxx" = { psk = "xxx.xxx.xxx"; };
        };

        services.openssh.enable = true;
        services.ntp.enable     = true;
        system.stateVersion     = "23.11";
        hardware.enableRedistributableFirmware = true;

        security.sudo = {
          enable             = true;
          wheelNeedsPassword = false;
        };

        environment.systemPackages = with pkgs; [
          lgpio
          ffmpeg libevdev ntp
          gcc gnumake binutils pkg-config
          autoconf automake libtool cmake
        ];
      };

      users = { users.users = {
        admin = {
          password     = "not-an-admin-!!!";
          isNormalUser = true;
          extraGroups  = [ "wheel" ];
        };
        marius = {
          openssh.authorizedKeys.keys = [
            "ssh-rsa xxx marius@xxx"
          ];
          isNormalUser = true;
          extraGroups  = [ "wheel" ];
        };
        pi = {
          openssh.authorizedKeys.keys = [
            "ssh-rsa xxx marius@xxx"
          ];
          isNormalUser = true;
          extraGroups  = [ "wheel" ];
        };
      };};
    };

    packages.aarch64-linux.sdcard = nixos-generators.nixosGenerate {
      system  = "aarch64-linux";
      format  = "sd-aarch64";
      modules = [
        self.nixosModules.system
        self.nixosModules.users
      ];
    };


    devShells = builtins.mapAttrs
      (system: pkgs: {
        # generic/default shell still here if you need it
        default = pkgs.mkShell { buildInputs = pkgs; };

        # FrameOS build shell
        frameos = pkgs.mkShell {
          packages = with pkgs; [
            # Nim tool-chain
            nim nimble

            # Tools & libs mirrored from the old apt-install list
            gcc gnumake pkg-config
            libevdev lgpio ntp hostapd

            # Extras
            clang-tools
            gitMinimal openssl
            python3Full python3Packages.virtualenv
          ];

          shellHook = ''
            export NIMBLE_BIN="${pkgs.nimble}/bin/nimble"
            export PATH="${pkgs.gitMinimal}/bin:${pkgs.openssl}/bin:$PATH"
            export NIMBLE_BIN="${pkgs.nimble}/bin/nimble"
            echo "Dev-shell (${system}) ready – run:  make build"
          '';
        };
      })
      pkgsFor;                                  # ← iterates over x86_64 & aarch64
  };
}
