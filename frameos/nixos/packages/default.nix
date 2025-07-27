{ pkgs }:
{
  frameos        = import ./frameos.nix       { inherit pkgs; };
  frameos_agent  = import ./frameos_agent.nix { inherit pkgs; };
  frameos_assets = import ./frameos_assets.nix { inherit pkgs; };
  nim_lk         = pkgs.nim_lk;
}
