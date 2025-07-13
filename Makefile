all:
	nix --extra-experimental-features 'nix-command flakes' \
		build .#packages.aarch64-linux.sdImage \
		--system aarch64-linux \
		--show-trace

shell:
	nix --extra-experimental-features 'nix-command flakes' \
		develop .#frameos

lock:
	nix --extra-experimental-features 'nix-command flakes' \
		run .#nim_lk -- ./frameos > frameos/lock.json
