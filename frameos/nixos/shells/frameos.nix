{ pkgs, self, system }:
pkgs.mkShell {
  inputsFrom = [ self.packages.${system}.frameos ];
  packages = with pkgs; [
    nim nimble gcc gnumake pkg-config openssl zstd pkgs.nim_lk
  ];
  shellHook = ''
    echo "Dev‑shell (${system}) ready – run: nimble build"
  '';
}
