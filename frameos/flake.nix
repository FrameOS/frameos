{
  description = "FrameOS for Raspberry Pi - packages, dev shells and flash-ready SD image";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";
    nixos-generators.url = "github:nix-community/nixos-generators";
    nixos-generators.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = { self, nixpkgs, nixos-generators, ... }@inputs:
    let
      hostName   = "frame-nixtest";

      allowMissingMods = _: prev: {
        makeModulesClosure = x: prev.makeModulesClosure (x // { allowMissing = true; });
      };

      # ──────────────────────────────────────────────────────────────────
      # Overlay that builds lgpio v0.2.2
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

      rootFsModule = { lib, ... }: {
        fileSystems = {
          "/" = {
            device = "/dev/disk/by-label/NIXOS_SD";
            fsType = "ext4";
          };
          # Keep /boot/firmware mounted on rebuilds so kernel + DTBs get updated,
          # but don’t fail the boot if it’s missing.
          "/boot/firmware" = lib.mkIf (builtins.pathExists "/dev/disk/by-label/FIRMWARE") {
            device  = "/dev/disk/by-label/FIRMWARE";
            fsType  = "vfat";
            options = [ "nofail" "noauto" ];
          };
        };
      };

      frameosSrc = ./.;
      mkFrameOS = pkgs: pkgs.buildNimPackage {
        pname        = "frameos";
        version      = "0.1.0";
        src          = frameosSrc;
        nimbleFile   = "frameos.nimble";
        lockFile     = "${frameosSrc}/lock.json";
        buildInputs  = with pkgs; [ lgpio libevdev zstd openssl ];
        nimDefines   = [ "ssl" ];
        nimFlags     = [ "--lineTrace:on" "--stackTrace:on" "-d:ssl" ];
        meta.mainProgram = "frameos";
        postPatch = ''
          substituteInPlace frameos.nimble \
            --replace-fail '@["frameos"]' '"frameos"'
        '';
      };
      mkFrameOSAgent = pkgs: pkgs.buildNimPackage {
        pname        = "frameos_agent";
        version      = "0.1.0";
        src          = ./agent;
        nimbleFile   = "frameos_agent.nimble";
        lockFile     = ./agent/lock.json;
        buildInputs  = with pkgs; [ zstd openssl ];
        nimDefines   = [ "ssl" ];
        nimFlags     = [ "--lineTrace:on" "--stackTrace:on" "--define:useMalloc" "--profiler:on" "--panics:on" "-g" "-d:ssl" ];
        meta.mainProgram = "frameos_agent";
        postPatch = ''
          substituteInPlace frameos_agent.nimble \
            --replace-fail '@["frameos_agent"]' '"frameos_agent"'
        '';
      };
      mkFrameOSAssets = pkgs: pkgs.stdenv.mkDerivation rec {
        pname        = "frameos-assets";
        version      = "0.1.0";
        src          = ./assets/copied;
        dontBuild    = true;
        installPhase = ''
          mkdir -p $out
          cp -a $src/* $out/
          chmod -R u+rwX,go+rX $out
        '';
      };
    in rec {
      # ──────────────────────────────────────────────────────────────────
      # Common module used for both the sd image *and* nixosConfigurations
      # ──────────────────────────────────────────────────────────────────
      frameosModule = { pkgs, lib, ... }: let
        frameosPkg = self.packages.${pkgs.system}.frameos; 
        frameosAgentPkg = self.packages.${pkgs.system}.frameos_agent;
        frameosAssetsPkg = self.packages.${pkgs.system}.frameos_assets;
      in {
        nixpkgs.overlays = [ lgpioOverlay allowMissingMods ];
        system.stateVersion = "25.05";
        time.timeZone       = "Europe/Brussels";
        environment.systemPackages = with pkgs; [ 
          cacert openssl frameosPkg frameosAgentPkg frameosAssetsPkg
        ];
        environment.variables.SSL_CERT_FILE = "/etc/ssl/certs/ca-bundle.crt";
        environment.etc."nixos/flake.nix".source = ./flake.nix;
        environment.etc."nixos/flake.lock".source = ./flake.lock;
        networking = {
          hostName = hostName;
          wireless.enable = lib.mkForce false; # using NetworkManager instead
          networkmanager = {
            enable = true;
            dns = "dnsmasq";
          };
          firewall = {
            allowedUDPPorts = [ 53 67 123 ];
            allowedTCPPorts = [
              22
              8787
            ];
          };
        };
        services.openssh.enable = true;

        services.timesyncd = {
          enable = true;
          servers         = [ "time.cloudflare.com" ];           # primary pool
          fallbackServers = [ "time.google.com" ];               # back‑up
          extraConfig = ''
            InitialBurst=yes           # 4 packets in quick succession
            PollIntervalMinSec=16      # legal minimum (default is 32 s)
            ConnectionRetrySec=5
          '';
        };

        hardware = {
          enableRedistributableFirmware = lib.mkForce false;
          firmware = [ pkgs.raspberrypiWirelessFirmware ];
          i2c.enable = true;          # already present, kept

          deviceTree = {
            enable        = true;
            # Use the Raspberry Pi-specific kernel; same choice as pi-zero-2 flake
            kernelPackage = pkgs.linuxKernel.packages.linux_rpi3.kernel;
            filter        = "*2837*";        # BCM2837 / Pi 3 / Zero 2 W

            overlays = [
              # I²C
              {
                name    = "i2c_arm";
                dtsText = ''
                  /dts-v1/;
                  /plugin/;
                  / { compatible = "brcm,bcm2835";
                    fragment@0 { target = <&i2c1>;
                      __overlay__ { status = "okay"; };
                    };
                  };
                '';
              }

              # SPI (enables both CS0 & CS1 as spidev)
              {
                name    = "spi0-2cs";
                dtsText = ''
                  /dts-v1/;
                  /plugin/;
                  / { compatible = "brcm,bcm2837";
                    fragment@0 { target = <&spi0>;
                      __overlay__ {
                        status = "okay";
                        spidev0: spidev@0 {
                          compatible = "spidev";
                          reg        = <0>;            // CS0
                          spi-max-frequency = <50000000>;
                        };
                        spidev1: spidev@1 {
                          compatible = "spidev";
                          reg        = <1>;            // CS1
                          spi-max-frequency = <50000000>;
                        };
                      };
                    };
                  };
                '';
              }

              # PWM 2-channel (taken from pwm.dts in pi-zero-2 repo)
              {
                name    = "pwm-2chan";
                dtsText = ''
                  /dts-v1/;
                  /plugin/;
                  / { compatible = "brcm,bcm2837";
                    fragment@0 { target = <&gpio>;
                      __overlay__ {
                        pwm_pins: pwm_pins {
                          brcm,pins     = <18 19>;
                          brcm,function = <2 2>; /* Alt5 */
                        };
                      };
                    };
                    fragment@1 { target = <&pwm>;
                      __overlay__ {
                        pinctrl-names = "default";
                        pinctrl-0     = <&pwm_pins>;
                        status        = "okay";
                      };
                    };
                  };
                '';
              }
            ];
          };
        };
        services.udev.extraRules = ''
          SUBSYSTEM=="spidev",  GROUP="spi", MODE="0660"
          SUBSYSTEM=="i2c-dev", GROUP="i2c", MODE="0660"
          KERNEL=="gpiomem",    GROUP="gpio", MODE="0660"
          KERNEL=="gpiochip[0-9]*", GROUP="gpio", MODE="0660"
        '';

        # Groups & permissions
        users.groups.spi = {};
        users.groups.gpio = {};

        users.users = {
          frame = { 
            password = "not-an-admin-!!!"; 
            # openssh.authorizedKeys.keys = [ "ssh-rsa XXX" ];
            isNormalUser = true; 
            extraGroups = [ "gpio" "spi" "i2c" "video" "wheel" ]; 
          };
        };

        security.sudo = {
          enable = true;
          wheelNeedsPassword = false;
          extraConfig = ''
            Defaults env_keep += "SSL_CERT_FILE"
          '';
        };

        services.avahi = {
          enable       = true;      # start avahi‑daemon
          nssmdns4     = true;      # write mdns entries to /etc/nsswitch.conf
          openFirewall = true;      # allow UDP 5353 and related traffic
          publish = {               # advertise the hostname & IP
            enable      = true;
            addresses   = true;
            workstation = true;     # so “_workstation._tcp” shows up
            domain      = true;     # broadcast the .local domain
          };
        };

        boot = {
          kernelPackages = pkgs.linuxPackages_rpi3;             # tuned Pi kernel
          initrd.availableKernelModules = [ "xhci_pci" "usbhid" "usb_storage" ];
          loader.generic-extlinux-compatible.enable = true;      # already true
          loader.grub.enable  = false;
          # nixos-rebuild complains if GRUB targets are missing; neutralise it
          loader.grub.devices = lib.mkDefault [ ];
          swraid.enable       = lib.mkForce false;               # silence mdadm
          supportedFilesystems.zfs = lib.mkForce false;          # save time compiling zfs
        };
        
        systemd.globalEnvironment.SSL_CERT_FILE = "/etc/ssl/certs/ca-bundle.crt";
        systemd.globalEnvironment.FRAMEOS_CONFIG = "/var/lib/frameos/frame.json";
        systemd.globalEnvironment.FRAMEOS_STATE = "/var/lib/frameos/state";

        systemd.services.frameos = {
          wantedBy = [ "multi-user.target" ];
          after    = [ "systemd-udev-settle.service" "time-sync.target" ];
          restartIfChanged = true;
          restartTriggers = [ frameosPkg ];
          
          serviceConfig = {
            User        = "frame";
            StateDirectory  = "frameos";
            WorkingDirectory = "%S/frameos";    # %S → /var/lib
            SupplementaryGroups  = [ "gpio" "spi" "i2c" "video" "wheel" ];
            After       = ["systemd-udev-settle.service" "dev-spidev0.0.device" "time-sync.target"];
            Environment = [ "PATH=/run/wrappers/bin:/run/current-system/sw/bin" ];
            ExecStart   = "${frameosPkg}/bin/frameos";

            Restart   = "always";
            AmbientCapabilities = [ "CAP_SYS_RAWIO" ];
            NoNewPrivileges = "no";
            DevicePolicy = lib.mkForce "private";
          };
          path = [ pkgs.coreutils ];
        };

        systemd.services.frameos_agent = {
          wantedBy = [ "multi-user.target" ];
          after    = [ "network-online.target" ];
          wants    = [ "network-online.target" ];
          restartIfChanged = true;
          restartTriggers = [ frameosAgentPkg ];

          serviceConfig = {
            Type        = "simple";
            User        = "frame";
            StateDirectory  = "frameos_agent";
            SupplementaryGroups  = [ "wheel" ];
            Environment = [ "PATH=/run/wrappers/bin:/run/current-system/sw/bin" ];
            WorkingDirectory = "%S/frameos_agent";
            ExecStart   = "${frameosAgentPkg}/bin/frameos_agent";

            Restart     = "always";
            RestartSec  = 1;
            LimitNOFILE = 65536;
            PrivateTmp  = true;
            DevicePolicy = lib.mkForce "private";
          };
        };

        systemd.services.NetworkManager = {
          # Tell systemd to keep /var/lib/NetworkManager around
          serviceConfig.StateDirectory = "NetworkManager";
        };
        environment.etc."NetworkManager/NetworkManager.conf".text = lib.mkForce ''
          [main]
          plugins=keyfile

          [keyfile]
          # Save every profile here instead of /etc
          path=/var/lib/NetworkManager/system-connections
        '';

        systemd.tmpfiles.rules = [
          "d /var/log/frameos 0750 frame users - -"
          "d /var/lib/frameos/state    0770 frame users - -"
          "C /var/lib/frameos/frame.json 0660 frame users - ${./frame.json}"

          "C /etc/nixos/flake.nix 0644 root root - ${./flake.nix}"
          "C /etc/nixos/flake.lock 0644 root root - ${./flake.lock}"

          "C /srv/assets 0755 frame users - ${frameosAssetsPkg}"
        ];
      };

      # ──────────────────────────────────────────────────────────────────
      packages = builtins.listToAttrs (map
        (system:
          { name = system; value = {
              frameos = mkFrameOS (pkgsFor system);
              frameos_agent = mkFrameOSAgent (pkgsFor system);
              frameos_assets = mkFrameOSAssets (pkgsFor system);
              nim_lk  = (pkgsFor system).nim_lk;

              sdImage = nixos-generators.nixosGenerate {
                inherit system;
                format  = "sd-aarch64";   # compressed .img.zst
                modules = [ rootFsModule frameosModule ];
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
          modules = [ rootFsModule frameosModule ];
        };
      };

      # ──────────────────────────────────────────────────────────────────
      devShells = builtins.listToAttrs (map
        (system:
          { name = system; value = {
              default = (pkgsFor system).mkShell { buildInputs = [ ]; };
              frameos = (pkgsFor system).mkShell {
                inputsFrom = [ self.packages.${system}.frameos ];
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
