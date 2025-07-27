{ pkgs, lib, ... }:
{
  hardware = {
    enableRedistributableFirmware = lib.mkForce false;
    firmware = [ pkgs.raspberrypiWirelessFirmware ];
    i2c.enable = true;

    deviceTree = {
      enable        = true;
      # Use the Raspberry Pi-specific kernel; same choice as pi-zero-2 flake
      kernelPackage = pkgs.linuxKernel.packages.linux_rpi3.kernel;
      filter        = "*2837*";                 # BCM2837 / Pi 3 / Zero 2 W
      overlays = [
        # I²C
        {
          name = "i2c_arm";
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
        # SPI with two chip‑selects
        {
          name = "spi0-2cs";
          dtsText = ''
            /dts-v1/;
            /plugin/;
            / { compatible = "brcm,bcm2837";
              fragment@0 { target = <&spi0>;
                __overlay__ {
                  status = "okay";
                  spidev0: spidev@0 {
                    compatible        = "spidev";
                    reg               = <0>;          // CS0
                    spi-max-frequency = <50000000>;
                  };
                  spidev1: spidev@1 {
                    compatible        = "spidev";
                    reg               = <1>;          // CS1
                    spi-max-frequency = <50000000>;
                  };
                };
              };
            };
          '';
        }
        # Two‑channel PWM on GPIO 18/19
        {
          name = "pwm-2chan";
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

  boot = {
    kernelPackages = pkgs.linuxPackages_rpi3;
    initrd.availableKernelModules = [ "xhci_pci" "usbhid" "usb_storage" ];
    loader.generic-extlinux-compatible.enable = true;

    loader.grub = {
      enable  = false;
      devices = lib.mkDefault [ ];
    };

    swraid.enable              = lib.mkForce false;
    supportedFilesystems.zfs   = lib.mkForce false;
  };
}
