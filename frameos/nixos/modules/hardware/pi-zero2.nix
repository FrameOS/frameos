{ pkgs, lib, ... }:
{
  hardware = {
    enableRedistributableFirmware = lib.mkForce false;
    firmware = [ pkgs.raspberrypiWirelessFirmware ];
    i2c.enable = true;

    deviceTree = {
      enable        = true;
      kernelPackage = pkgs.linuxKernel.packages.linux_rpi3.kernel;
      filter        = "*2837*";                 # BCM2837 / Pi 3 / Zero 2 W
      overlays = [
        #!- IMPORT OVERLAYS HERE -!#
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
