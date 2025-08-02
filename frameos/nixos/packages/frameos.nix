{ pkgs }:
let
  frameosSrc = ../../.;
in pkgs.buildNimPackage {
  pname   = "frameos";
  version = "0.1.0";

  src        = frameosSrc;
  nimbleFile = "frameos.nimble";
  lockFile   = "${frameosSrc}/lock.json";

  buildInputs = with pkgs; [ lgpio libevdev zstd openssl ];
  nimDefines  = [ "ssl" ];
  nimFlags    = [ "--lineTrace:on" "--stackTrace:on" "-d:ssl" ];

  meta.mainProgram = "frameos";

  postPatch = ''
    substituteInPlace frameos.nimble \
      --replace-fail '@["frameos"]' '"frameos"'
  '';
}
