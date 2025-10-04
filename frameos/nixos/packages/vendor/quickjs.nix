{ pkgs }:
pkgs.stdenv.mkDerivation rec {
  pname = "quickjs";
  version = "2025-09-13";

  src = pkgs.fetchurl {
    url  = "https://bellard.org/quickjs/quickjs-${version}.tar.xz";
    hash = "sha256-bx8yKuo7s6kIWNuFyf5xcBP95N99/K/i9X549btLSgw=";
  };

  nativeBuildInputs = [ pkgs.gnumake pkgs.pkg-config ];

  # Build the static library (headers are in the tree)
  buildPhase   = "make libquickjs.a";
  installPhase = ''
    mkdir -p $out/lib $out/include/quickjs
    cp libquickjs.a     $out/lib/
    cp quickjs.h quickjs-libc.h $out/include/quickjs/
  '';
}
