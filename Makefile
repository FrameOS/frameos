all: &build

build:
	nix --extra-experimental-features 'nix-command flakes' \
		build .#packages.aarch64-linux.sdImage \
		--system aarch64-linux \
		--show-trace

bin:
	nix --extra-experimental-features 'nix-command flakes' \
		build .#packages.aarch64-linux.frameos \
		--system aarch64-linux \
		--show-trace \
		-o tmp/result-frameos
	install -Dm755 tmp/result-frameos/bin/frameos bin/frameos
	@echo "✅  Built binary is now at bin/frameos (aarch64, ready for Pi Zero 2 W)"

shell:
	nix --extra-experimental-features 'nix-command flakes' \
		develop .#frameos

lock:
	nix --extra-experimental-features 'nix-command flakes' \
		run .#nim_lk -- ./frameos > frameos/lock.json
