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

      frameosSrc = ./frameos;
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

      #──────────────────────────────────────────────────────────────────────────
      packages = builtins.listToAttrs (map
        (system:
          { name = system; value = {
              frameos = mkFrameOS (pkgsFor system);
              nim_lk  = (pkgsFor system).nim_lk;

              sdImage = nixos-generators.nixosGenerate {
                inherit system;
                format  = "sd-aarch64";         # compressed .img.zst
                modules = [
                  ({ pkgs, lib, ... }: {
                    nixpkgs.overlays = [ lgpioOverlay ];

                    networking.hostName =
                      let
                        # hash the flake’s path, take first 8 hex chars to keep the hostname short
                        short = builtins.substring 0 8
                                  (builtins.hashString "sha1" (builtins.toString self));
                      in "frame-${short}";

                    time.timeZone = "Europe/Brussels";

                    # ──────────────── Wi-Fi configuration ────────────────
                    networking.networkmanager.enable = true;
                    networking.wireless.enable = lib.mkForce false;  # disable the old interface
                    hardware.enableRedistributableFirmware = true;   # ← adds linux-firmware, incl. brcmfmac blobs
                    
                    environment.etc."NetworkManager/system-connections/frameos-wifi.nmconnection" = {
                      user  = "root";
                      group = "root";
                      mode  = "0600";
                      text  = ''
                        [connection]
                        id=frameos-wifi
                        uuid=d96b6096-93a5-4c39-9f5c-6bb64bb97f7b
                        type=wifi
                        interface-name=wlan0
                        autoconnect=true

                        [wifi]
                        mode=infrastructure
                        ssid=TODOTODOTODOTODO

                        [wifi-security]
                        key-mgmt=wpa-psk
                        psk=TODOTODOTODOTODO

                        [ipv4]
                        method=auto
                        never-default=false

                        [ipv6]
                        method=auto
                      '';
                    };          
                    services.openssh.enable = true;
                    system.stateVersion = "25.05";


                    # ──────────────── User accounts ────────────────
                    users.users = {
                      admin = {
                        password     = "not-an-admin-!!!";
                        isNormalUser = true;
                        extraGroups  = [ "wheel" ];
                      };
                      marius = {
                        openssh.authorizedKeys.keys = [
                          "ssh-rsa TODO marius@TODO"
                        ];
                        isNormalUser = true;
                        extraGroups  = [ "wheel" ];
                      };
                      pi = {
                        openssh.authorizedKeys.keys = [
                          "ssh-rsa TODO marius@TODO"
                        ];
                        isNormalUser = true;
                        extraGroups  = [ "wheel" ];
                      };
                    };

                    environment.systemPackages = with pkgs; [
                      lgpio libevdev ffmpeg
                      self.packages.${system}.frameos
                    ];

                    systemd.services.frameos = {
                      wantedBy      = [ "multi-user.target" ];
                      serviceConfig = {
                        ExecStart        = "${self.packages.aarch64-linux.frameos}/bin/frameos";
                        WorkingDirectory = "/srv/frameos";
                        Restart          = "always";
                      };
                    };
                  })
                ];
              };
            };
          })
        supported);

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
                  echo "Dev-shell ($system) ready - run: cd frameos && nimble build"
                '';
              };
            };
          })
        supported);
    };
}
