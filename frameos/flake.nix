{
  description = "FrameOS for Raspberry Pi - packages, dev shells and flash-ready SD image";

  inputs = {
    nixpkgs.url          = "nixpkgs/nixos-unstable";
    nixos-generators.url = "github:nix-community/nixos-generators";
  };

  outputs = { self, nixpkgs, nixos-generators, ... }@inputs:
    let
      shortHash = "nixtest"; # TODO
      hostName   = "frame-${shortHash}";

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
      # Common module used for both the sd image *and* nixosConfigurations
      # ──────────────────────────────────────────────────────────────────
      frameosModule = { pkgs, lib, ... }: {
        nixpkgs.overlays = [ lgpioOverlay allowMissingMods ];
        system.stateVersion     = "25.05";

        networking.hostName = hostName;
        time.timeZone       = "Europe/Brussels";
        networking.networkmanager.enable = true;
        networking.wireless.enable       = lib.mkForce false;
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
            psk=XXX

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
        services.openssh.enable = true;

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
              # -------- I²C
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

              # -------- SPI  (new – enables both CS0 & CS1 as spidev)
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

              # -------- PWM 2-channel  (taken from pwm.dts in pi-zero-2 repo)
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
        '';

        # Groups & permissions (unchanged but required)
        users.groups.spi = {};

        users.users = {
          admin = { password = "not-an-admin-!!!"; isNormalUser = true; extraGroups = [ "wheel" ]; };
          marius = { openssh.authorizedKeys.keys = [ "XXX" ]; isNormalUser = true; extraGroups = [ "wheel" ]; };
          pi     = { openssh.authorizedKeys.keys = [ "ssh-rsa XXX" ]; isNormalUser = true; extraGroups = [ "wheel" ]; };
        };

        security.sudo.wheelNeedsPassword = false;
        
        boot = {
          kernelPackages = pkgs.linuxPackages_rpi3;             # tuned Pi kernel
          initrd.availableKernelModules = [ "xhci_pci" "usbhid" "usb_storage" ];
          loader.generic-extlinux-compatible.enable = true;      # already true
          loader.grub.enable  = false;
          swraid.enable       = lib.mkForce false;               # silence mdadm
          supportedFilesystems.zfs = lib.mkForce false;          # save time compiling zfs
        };


        systemd.services.frameos = {
          wantedBy      = [ "multi-user.target" ];
          serviceConfig = {
            ExecStart        = "/srv/frameos/current/frameos";
            WorkingDirectory = "/srv/frameos/current";
            Restart          = "always";
          };
        };

        system.activationScripts.initializeFrameOS.text =
          let bin = self.packages.${pkgs.system}.frameos + "/bin/frameos";
          in ''
            initial="/srv/frameos/releases/initial"

            # Only run on very first boot
            if [ ! -e "/srv/frameos" ]; then
              echo "⏩  populating first-boot FrameOS release"

              mkdir -p "$initial" /srv/frameos/state

              # Only copy the binary if it actually exists for the target arch
              if [ -x "${bin}" ]; then
                install -m700 "${bin}" "$initial/frameos"
              else
                echo "⚠️  ${bin} not found – skipping copy" >&2
              fi
              chown -R admin:users /srv/frameos

              ln -sfn /srv/frameos/state "$initial/state"
              echo '{"name":"first-boot","frameHost":"localhost","framePort":8787}' > "$initial/frame.json"

              ln -sfn "$initial" /srv/frameos/current
            fi
          '';
      };

      # ──────────────────────────────────────────────────────────────────
      packages = builtins.listToAttrs (map
        (system:
          { name = system; value = {
              frameos = mkFrameOS (pkgsFor system);
              nim_lk  = (pkgsFor system).nim_lk;

              sdImage = nixos-generators.nixosGenerate {
                inherit system;
                format  = "sd-aarch64";   # compressed .img.zst
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
