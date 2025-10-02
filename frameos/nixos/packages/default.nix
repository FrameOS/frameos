{ pkgs }:
{
  frameos        = import ./frameos.nix       { inherit pkgs; };
  frameos_agent  = import ./frameos_agent.nix { inherit pkgs; };
  frameos_assets = import ./frameos_assets.nix { inherit pkgs; };
  nim_lk         = pkgs.nim_lk;
  quickjs        = import ./vendor/quickjs.nix { inherit pkgs; };

  # TODO: these don't work yet, issues with spi and i2c
  inkyPython       = import ./vendor/inkyPython.nix       { inherit pkgs; };
  inkyHyperPixel2r = import ./vendor/inkyHyperPixel2r.nix { inherit pkgs; };
}
