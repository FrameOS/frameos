{ pkgs, lib, self, ... }:

let
  frameosPkg       = self.packages.${pkgs.system}.frameos;
  frameosAgentPkg  = self.packages.${pkgs.system}.frameos_agent;
  frameosAssetsPkg = self.packages.${pkgs.system}.frameos_assets;
in
{
  nixpkgs.overlays = import ../overlays;

  system.stateVersion = "25.05";
  time.timeZone       = "Europe/Brussels";

  environment.systemPackages = with pkgs; [
    cacert openssl frameosPkg frameosAgentPkg frameosAssetsPkg
  ];
  environment.variables.SSL_CERT_FILE = "/etc/ssl/certs/ca-bundle.crt";

  environment.etc."nixos/flake.nix".source  = ../../flake.nix;
  environment.etc."nixos/flake.lock".source = ../../flake.lock;

  networking = {
    # TODO!
    # hostName = hostName;

    wireless.enable = lib.mkForce false;   # we use NetworkManager
    networkmanager = {
      enable = true;
      dns = "dnsmasq";
    };
    firewall = {
      allowedUDPPorts = [ 53 67 123 ];
      allowedTCPPorts = [ 22 8787 ];
    };
  };

  services.openssh.enable = true;

  services.timesyncd = {
    enable          = true;
    servers         = [ "time.cloudflare.com" ];
    fallbackServers = [ "time.google.com" ];
    extraConfig = ''
      PollIntervalMinSec=16
      ConnectionRetrySec=5
    '';
  };

  # ─── permissions & udev ────────────────────────────────────────────
  services.udev.extraRules = ''
    SUBSYSTEM=="spidev",  GROUP="spi",  MODE="0660"
    SUBSYSTEM=="i2c-dev", GROUP="i2c",  MODE="0660"
    KERNEL=="gpiomem",    GROUP="gpio", MODE="0660"
    KERNEL=="gpiochip[0-9]*", GROUP="gpio", MODE="0660"
  '';
  users.groups.spi  = {};
  users.groups.gpio = {};

  users.users.frame = {
    isNormalUser = true;
    extraGroups  = [ "gpio" "spi" "i2c" "video" "wheel" ];
  };

  security.sudo = {
    enable             = true;
    wheelNeedsPassword = false;
    extraConfig = ''
      Defaults env_keep += "SSL_CERT_FILE"
    '';
  };

  services.avahi = {
    enable       = true;
    nssmdns4     = true;
    openFirewall = true;
    publish = {
      enable      = true;
      addresses   = true;
      workstation = true;
      domain      = true;
    };
  };

  # ─── environment for FrameOS binaries ──────────────────────────────
  systemd.globalEnvironment = {
    SSL_CERT_FILE  = "/etc/ssl/certs/ca-bundle.crt";
    FRAMEOS_CONFIG = "/var/lib/frameos/frame.json";
    FRAMEOS_STATE  = "/var/lib/frameos/state";
  };

  systemd.services.frameos = {
    wantedBy = [ "multi-user.target" ];
    after    = [ "systemd-udev-settle.service" "dev-spidev0.0.device" "time-sync.target" ];
    restartIfChanged = true;
    restartTriggers = [ frameosPkg ];
    
    serviceConfig = {
      User        = "frame";
      StateDirectory  = "frameos";
      WorkingDirectory = "%S/frameos";    # %S → /var/lib
      SupplementaryGroups  = [ "gpio" "spi" "i2c" "video" "wheel" ];
      Environment = [ "PATH=/run/wrappers/bin:/run/current-system/sw/bin" ];
      ExecStart   = "${frameosPkg}/bin/frameos";

      Restart   = "always";
      AmbientCapabilities = [ "CAP_SYS_RAWIO" ];
      NoNewPrivileges = "no";
    };
    path = [ pkgs.coreutils ];
  };

  systemd.services.frameos_agent = {
    wantedBy = [ "multi-user.target" ];
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
    };
  };

  # Keep NetworkManager state in /var
  systemd.services.NetworkManager.serviceConfig.StateDirectory = "NetworkManager";
  environment.etc."NetworkManager/NetworkManager.conf".text = lib.mkForce ''
    [main]
    plugins=keyfile

    [keyfile]
    path=/var/lib/NetworkManager/system-connections
  '';

  # ─── tmpfiles ───────────────────────────────────────────────────────
  systemd.tmpfiles.rules = [
    "d /var/log/frameos           0750 frame users - -"
    "d /var/lib/frameos/state     0770 frame users - -"
    "C /var/lib/frameos/frame.json 0660 frame users - ${../../frame.json}"

    "C /etc/nixos/flake.nix  0644 root root - ${../../flake.nix}"
    "C /etc/nixos/flake.lock 0644 root root - ${../../flake.lock}"

    "C /srv/assets 0755 frame users - ${frameosAssetsPkg}"
  ];
}
