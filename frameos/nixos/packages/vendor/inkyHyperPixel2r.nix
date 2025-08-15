{ pkgs }:

let
  python = pkgs.python311.withPackages (ps: [
    ps.pillow ps.numpy ps.rpi_gpio
  ]);
in
pkgs.stdenvNoCC.mkDerivation {
  pname   = "inkyHyperPixel2r";
  version = "0.1.0";
  src     = ../../vendor/inkyHyperPixel2r;

  nativeBuildInputs = [ python pkgs.makeWrapper pkgs.rsync ];
  dontBuild = true;

  installPhase = ''
    mkdir -p $out/{bin,share/inkyHyperPixel2r}
    rsync -a --chmod=D755,F644 --exclude='env' --exclude='__pycache__' ./ $out/share/inkyHyperPixel2r/

    python -m venv $out/venv
    $out/venv/bin/pip install --no-index --find-links ${python}/${python.sitePackages} pillow numpy RPi.GPIO

    makeWrapper $out/venv/bin/python $out/bin/inkyHyperPixel2r-turnOn  \
      --add-flags "$out/share/inkyHyperPixel2r/turnOn.py"
    makeWrapper $out/venv/bin/python $out/bin/inkyHyperPixel2r-turnOff \
      --add-flags "$out/share/inkyHyperPixel2r/turnOff.py"
  '';
}
