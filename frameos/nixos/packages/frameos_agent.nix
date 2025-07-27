{ pkgs }:
pkgs.buildNimPackage {
  pname   = "frameos_agent";
  version = "0.1.0";

  src        = ../../agent;
  nimbleFile = "frameos_agent.nimble";
  lockFile   = ../../agent/lock.json;

  buildInputs = with pkgs; [ zstd openssl ];
  nimDefines  = [ "ssl" ];
  nimFlags    = [
    "--lineTrace:on" "--stackTrace:on"
    "--define:useMalloc" "--profiler:on" "--panics:on" "-g" "-d:ssl"
  ];

  meta.mainProgram = "frameos_agent";

  postPatch = ''
    substituteInPlace frameos_agent.nimble \
      --replace-fail '@["frameos_agent"]' '"frameos_agent"'
  '';
}
