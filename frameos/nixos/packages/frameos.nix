{ pkgs }:
let
  frameosSrc = ../../.;
  pkgsAll = import ./default.nix { inherit pkgs; };
  qjs = pkgsAll.quickjs;
in
pkgs.buildNimPackage {
  pname   = "frameos";
  version = "0.1.0";

  src        = frameosSrc;
  nimbleFile = "frameos.nimble";
  lockFile   = "${frameosSrc}/lock.json";

  # bring QuickJS in as a build input
  buildInputs = with pkgs; [ qjs lgpio libevdev zstd openssl ];

  nimDefines = [ "ssl" ];
  nimFlags   = [ "--lineTrace:on" "--stackTrace:on" "-d:ssl" ];

  # Tell Nim/C compiler where to find headers and libquickjs.a
  NIX_CFLAGS_COMPILE = "-I${qjs}/include";
  NIX_LDFLAGS        = "-L${qjs}/lib -lquickjs -lm";

  meta.mainProgram = "frameos";

  postPatch = ''
    # 1) Prevent networked download of quickjs during Nix build
    substituteInPlace frameos.nimble \
      --replace-fail '@["frameos"]' '"frameos"' \
      --replace-fail 'if not dirExists("quickjs")' 'if false' \
      --replace-fail 'exec "nimble build_quickjs --silent"' 'echo "Nix provides quickjs; skipping."'
  '';
}
