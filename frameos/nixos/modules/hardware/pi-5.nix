{ pkgs, lib, ... }:
{
  hardware = {
    enableRedistributableFirmware = lib.mkForce false;
    firmware = [ pkgs.raspberrypiWirelessFirmware ];
    i2c.enable = true;

    deviceTree = {
      enable        = true;
      kernelPackage = pkgs.linuxKernel.packages.linux_rpi5.kernel;
      filter        = "*2712*";                # BCM2712 / Pi 5
      overlays = [
        #!- IMPORT OVERLAYS HERE -!#
      ];
    };
  };

  boot.kernelPackages = pkgs.linuxPackages_rpi5;
}
