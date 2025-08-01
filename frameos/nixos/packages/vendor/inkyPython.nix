{ pkgs }:

# ─── 1.  helper alias ───────────────────────────────────────────────
let
  pyPkgs = pkgs.python311Packages;   # ← outside the lambda, always defined

  # ─── 2.  vendored wheels built once ───────────────────────────────

  py_gpiod = pyPkgs.buildPythonPackage rec {
    pname   = "gpiod";
    version = "2.3.0";
    format  = "pyproject";

    src = pyPkgs.fetchPypi {
      inherit pname version;
      hash = "sha256-2qhA7VtpHnB4qc8hx5/oE7mpHD7Qvbr64Bgce5i4AwA=";
    };

    nativeBuildInputs = [                   # build backend
      pyPkgs.setuptools
      pyPkgs.wheel
    ];

    propagatedBuildInputs = [ pkgs.libgpiod ]; # shared library at runtime

    doCheck = false;                  # upstream has no test suite
  };
  
  py_gpiodevice = pyPkgs.buildPythonPackage rec {
    pname   = "gpiodevice";
    version = "0.0.5";
    format  = "wheel";

    src = pkgs.fetchurl {
      url  = "https://files.pythonhosted.org/packages/py3/g/gpiodevice/${pname}-${version}-py3-none-any.whl";
      hash = "sha256-uAglDNHYk3m2n5jMZEK2sJiqMmBMPtf7GUo5YH7jUlM=";
    };

    propagatedBuildInputs = [ py_gpiod ];
    pythonImportsCheck    = [ "gpiodevice" ];
    doCheck = false;

    postFixup = ''
      # Avoid file collision with inky wheel
      rm -f $out/${python.sitePackages}/LICENSE
      rm -f $out/${python.sitePackages}/CHANGELOG.md
      rm -f $out/${python.sitePackages}/README.md
    '';
  };

  py_inky = pyPkgs.buildPythonPackage rec {
    pname   = "inky";
    version = "2.1.0";
    format  = "wheel";

    src = pkgs.fetchurl {
      url  = "https://files.pythonhosted.org/packages/py3/i/inky/${pname}-${version}-py3-none-any.whl";
      hash = "sha256-g0YBNR/zzwxppuj2swBOgMIWr/76tygbJaUa9PVkQB8=";
    };

    propagatedBuildInputs = [
      pyPkgs.pillow
      pyPkgs.numpy
      pyPkgs."rpi-gpio"
      pyPkgs.spidev
      pyPkgs.smbus2
      py_gpiod
      py_gpiodevice
    ];

    pythonImportsCheck = [ "inky" ];
    doCheck = false;
  };

  # ─── 3.  final interpreter with everything in site-packages ───────
  python = pkgs.python311.withPackages (ps: [
    py_gpiod
    py_gpiodevice   # depends on py_gpiod
    py_inky         # depends on py_gpiod, py_gpiodevice, …
  ]);

in
pkgs.stdenvNoCC.mkDerivation {
  pname   = "inkyPython";
  version = "0.1.0";
  src     = ../../../vendor/inkyPython;

  nativeBuildInputs = [ python pkgs.makeWrapper pkgs.rsync ];
  dontBuild = true;

  installPhase = ''
    mkdir -p $out/{bin,share/inkyPython}
    rsync -a --chmod=D755,F644 --exclude='env' --exclude='__pycache__' \
          ./ $out/share/inkyPython/

    makeWrapper ${python}/bin/python $out/bin/inkyPython-check \
      --add-flags "$out/share/inkyPython/check.py"
    makeWrapper ${python}/bin/python $out/bin/inkyPython-run  \
      --add-flags "$out/share/inkyPython/run.py"
  '';
}
