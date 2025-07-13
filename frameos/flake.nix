{
  description = "FrameOS for Raspberry Pi - packages, dev shells and flash-ready SD image";

  #──────────────────────────────────────────────────────────────────────────────
  inputs = {
    nixpkgs.url          = "nixpkgs/nixos-unstable";
    nixos-generators.url = "github:nix-community/nixos-generators";
  };

  #──────────────────────────────────────────────────────────────────────────────
  outputs = { self, nixpkgs, nixos-generators, ... }@inputs:
    let
      shortHash = "nixtest"; # TODO
      hostName   = "frame-${shortHash}";

      # overlay that builds lgpio v0.2.2
      lgpioOverlay = final: prev: {
        lgpio = prev.stdenv.mkDerivation rec {
          pname    = "lgpio"; version = "0.2.2";
          src      = prev.fetchFromGitHub {
            owner = "joan2937"; repo = "lg"; rev = "v${version}";
            sha256 = "sha256-92lLV+EMuJj4Ul89KIFHkpPxVMr/VvKGEocYSW2tFiE=";
          };
          nativeBuildInputs = [ prev.pkg-config ];
          buildPhase   = "make";
          installPhase = ''
            make DESTDIR=$out install
            mkdir -p $out/include $out/lib
            mv $out/usr/local/include/* $out/include/ || true
            mv $out/usr/local/lib/*     $out/lib/     || true
            rm -rf $out/usr
            patchelf --shrink-rpath $out/lib/*.so* || true
          '';
        };
      };

      supported = [ "x86_64-linux" "aarch64-linux" ];
      pkgsFor = system: import nixpkgs {
        inherit system; overlays = [ lgpioOverlay ];
      };

      frameosSrc = ./.;
      mkFrameOS = pkgs: pkgs.buildNimPackage {
        pname        = "frameos";
        version      = "0.1.0";
        src          = frameosSrc;
        nimbleFile   = "frameos.nimble";
        lockFile     = "${frameosSrc}/lock.json";
        nimFlags     = [ "--lineTrace:on" ];
        buildInputs  = with pkgs; [ lgpio libevdev zstd ];
        meta.mainProgram = "frameos";
        postPatch = ''
          substituteInPlace frameos.nimble \
            --replace-fail '@["frameos"]' '"frameos"'
        '';
      };
    in rec {

      # ──────────────────────────────────────────────────────────────────
      #  Common module used for both the sd image *and* nixosConfigurations
      # ──────────────────────────────────────────────────────────────────
      frameosModule = { pkgs, lib, ... }: {
        nixpkgs.overlays = [ lgpioOverlay ];

        networking.hostName = hostName;
        time.timeZone       = "Europe/Brussels";

        # --- Wi-Fi (same as before) -------------------------------------
        networking.networkmanager.enable = true;
        networking.wireless.enable       = lib.mkForce false;
        hardware.enableRedistributableFirmware = true;
        environment.etc."NetworkManager/system-connections/frameos-wifi.nmconnection" = {
          user  = "root"; group = "root"; mode = "0600";
          text  = ''
            [connection]
            id=frameos-wifi
            uuid=d96b6096-93a5-4c39-9f5c-6bb64bb97f7b
            type=wifi
            interface-name=wlan0
            autoconnect=true

            [wifi]
            mode=infrastructure
            ssid=XXX

            [wifi-security]
            key-mgmt=wpa-psk
            psk=XXXXX

            [ipv4]
            method=auto
            never-default=false

            [ipv6]
            method=auto
          '';
        };
        networking.firewall.allowedTCPPorts = [
          22
          8787
        ];

        # sdImage.populateFirmwareCommands = lib.mkAfter ''
        #   # "firmware/" is the work-dir created by the standard sd-image module
        #   sed -i '/^gpu_mem=/d'   firmware/config.txt   # drop any previous lines
        #   sed -i '/^start_x=/d'   firmware/config.txt
        #   echo 'start_x=0'  >> firmware/config.txt      # camera off = +128 MiB RAM
        #   echo 'gpu_mem=16' >> firmware/config.txt      # minimal split
        # '';

        # ③  keep the default extlinux boot loader (already enabled by the
        #     sd-image-aarch64 profile, but good to have when you rebuild on-device)
        boot.loader.generic-extlinux-compatible.enable = true;

        # ④  the VC4 driver pre-allocates 64 MiB of CMA – pin it there
        boot.kernelParams = [ "cma=64M" ];

        services.openssh.enable = true;
        system.stateVersion     = "25.05";

        security.sudo.wheelNeedsPassword = false;

        users.users = {
          admin = { password = "not-an-admin-!!!"; isNormalUser = true; extraGroups = [ "wheel" ]; };
          marius = { openssh.authorizedKeys.keys = [ "XXX" ]; isNormalUser = true; extraGroups = [ "wheel" ]; };
          pi     = { openssh.authorizedKeys.keys = [ "ssh-rsa XXX" ]; isNormalUser = true; extraGroups = [ "wheel" ]; };
        };

        environment.systemPackages = with pkgs; [
          lgpio libevdev ffmpeg
          self.packages.${pkgs.system}.frameos
        ];

        systemd.services.frameos = {
          wantedBy      = [ "multi-user.target" ];
          serviceConfig = {
            ExecStart        = "${self.packages.${pkgs.system}.frameos}/bin/frameos";
            WorkingDirectory = "/srv/frameos";
            Restart          = "always";
          };
        };
      };

      #──────────────────────────────────────────────────────────────────────────
      packages = builtins.listToAttrs (map
        (system:
          { name = system; value = {
              frameos = mkFrameOS (pkgsFor system);
              nim_lk  = (pkgsFor system).nim_lk;

              sdImage = nixos-generators.nixosGenerate {
                inherit system;
                format  = "sd-aarch64";         # compressed .img.zst
                modules = [ frameosModule ];
              };
            };
          })
        supported);

      # ──────────────────────────────────────────────────────────────────
      #  Export a nixosConfiguration for nixos-rebuild on the device
      # ──────────────────────────────────────────────────────────────────
      nixosConfigurations = {
        "${hostName}" = nixpkgs.lib.nixosSystem {
          system  = "aarch64-linux";
          modules = [ frameosModule ];
        };
      };
      
      #──────────────────────────────────────────────────────────────────────────
      devShells = builtins.listToAttrs (map
        (system:
          { name = system; value = {
              default = (pkgsFor system).mkShell { buildInputs = [ ]; };
              frameos = (pkgsFor system).mkShell {
                inputsFrom = [ self.packages.${system}.frameos ];   # reuse buildInputs
                packages   = with (pkgsFor system); [
                  nim nimble gcc gnumake pkg-config
                  openssl zstd
                  nim_lk
                ];
                shellHook = ''
                  echo "Dev-shell ($system) ready - run: nimble build"
                '';
              };
            };
          })
        supported);
    };

}
