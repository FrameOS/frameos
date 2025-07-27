# Builds Joan’s lgpio v0.2.2
final: prev:
{
  lgpio = prev.stdenv.mkDerivation rec {
    pname    = "lgpio";
    version  = "0.2.2";

    src = prev.fetchFromGitHub {
      owner  = "joan2937";
      repo   = "lg";
      rev    = "v${version}";
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
}
