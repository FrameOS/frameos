{
  description = "Raspberry Pi 4 system with custom lgpio derivation";

  inputs.nixpkgs.url = "nixpkgs/nixos-unstable";
  inputs.nixos-generators = {
    url = "github:nix-community/nixos-generators";
    inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = { self, nixpkgs, nixos-generators, ... }:
  let
    # We import nixpkgs with our overlay so that `pkgs.lgpio` will exist.
    pkgs = import nixpkgs {
      system = "aarch64-linux";
      overlays = [
        # -------------------------
        # BEGIN: The lgpio overlay
        # -------------------------
        (final: prev: {
          lgpio = prev.stdenv.mkDerivation {
            pname = "lgpio";
            version = "0.2.2";

            # Pull from GitHub as a source
            src = prev.fetchFromGitHub {
              owner = "joan2937";
              repo = "lg";
              rev = "v0.2.2";
              # Using the sha256 you got from nix-prefetch-url:
              sha256 = "sha256-92lLV+EMuJj4Ul89KIFHkpPxVMr/VvKGEocYSW2tFiE=";
            };

            # If the Makefile might need pkg-config or something else:
            nativeBuildInputs = [ prev.pkg-config ];

            # If it requires development libraries (e.g. glibc, etc.), add them here:
            buildInputs = [];

            # The project uses a straightforward Makefile, so we override the typical phases:
            phases = [ "unpackPhase" "patchPhase" "buildPhase" "installPhase" ];

            buildPhase = ''
              make
            '';

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

              # Optionally strip unneeded symbols:
              patchelf --shrink-rpath $out/lib/*.so* || true
            '';

            meta = with prev.lib; {
              description = "GPIO library and tools by joan2937 (the author of pigpio)";
              homepage = "https://github.com/joan2937/lg";
              license = licenses.gpl3;
              platforms = platforms.linux;
            };
          };
        })
        # -------------------------
        # END: The lgpio overlay
        # -------------------------
      ];
    };
  in
  {
    nixosModules = {
      system = { config, ... }: {
        nix.settings.experimental-features = [
          "nix-command"
          "flakes"
        ];

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
        system.stateVersion = "23.11";
        hardware.enableRedistributableFirmware = true;

        environment.systemPackages = with pkgs; [
          lgpio # This is the custom GPIO library
          ffmpeg
          libevdev
          ntp
          gcc
          gnumake
          binutils
          pkg-config
          autoconf
          automake
          libtool
          cmake
        ];

        services.ntp.enable = true;
        security.sudo.enable = true;
        security.sudo.wheelNeedsPassword = false;
      };

      users = {
        users.users = {
          # TODO: Replace with actual users and keys
          admin = {
            password = "not-an-admin-!!!";
            isNormalUser = true;
            extraGroups = [ "wheel" ];
          };
          marius = {
            openssh.authorizedKeys.keys = [
              "ssh-rsa xxx marius@xxx"
            ];
            isNormalUser = true;
            extraGroups = [ "wheel" ];
          };
          pi = {
            openssh.authorizedKeys.keys = [
              "ssh-rsa xxx marius@xxx"
            ];
            isNormalUser = true;
            extraGroups = [ "wheel" ];
          };
        };
      };
    };

    packages.aarch64-linux = {
      sdcard = nixos-generators.nixosGenerate {
        system = "aarch64-linux";
        format = "sd-aarch64";
        modules = [
          self.nixosModules.system
          self.nixosModules.users
        ];
      };
    };

    devShells.aarch64-linux = {
      # Default shell retained for other ad-hoc needs (optional).
      default = pkgs.mkShell {
        buildInputs = pkgs;
      };

      frameos = pkgs.mkShell {
        packages = with pkgs; [
          # ---- Nim tool-chain ----
          nim nimble

          # ---- Build helpers identical to apt-installs ----
          gcc gnumake pkg-config
          libevdev
          lgpio           # from our overlay
          ntp hostapd

          # ---- Extras that smooth C and Python vendor blobs ----
          clang-tools
          python3Full python3Packages.venv
        ];

        shellHook = ''
          export NIMBLE_BIN="${pkgs.nimble}/bin/nimble"
          echo "Dev-shell ready - run:  make build"
        '';
      };
    };

  };

}
