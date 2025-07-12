all:
	nix --extra-experimental-features nix-command \
		--extra-experimental-features flakes \
		build .#packages.aarch64-linux.sdcard \
		--system aarch64-linux \
		--show-trace
