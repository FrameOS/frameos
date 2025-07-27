{ lib, ... }:
{
  fileSystems = {
    "/" = {
      device = "/dev/disk/by-label/NIXOS_SD";
      fsType = "ext4";
    };
    "/boot/firmware" = lib.mkIf (builtins.pathExists "/dev/disk/by-label/FIRMWARE") {
      device  = "/dev/disk/by-label/FIRMWARE";
      fsType  = "vfat";
      options = [ "nofail" "noauto" ];
    };
  };
}
