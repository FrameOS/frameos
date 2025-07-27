{ pkgs }:
pkgs.stdenv.mkDerivation rec {
  pname   = "frameos-assets";
  version = "0.1.0";
  src     = ../../assets/copied;

  dontBuild = true;
  installPhase = ''
    mkdir -p $out
    cp -a $src/* $out/
    chmod -R u+rwX,go+rX $out
  '';
}
