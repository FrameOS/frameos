.PHONY: run build test debug

run: build
	./build/frameos --verbose

build:
	nimble build -y --verbose --lineTrace:on

debug:
	nimble build -y --verbose --debugger:native --lineTrace:on
	lldb ./build/frameos

test:
	nimble test


nix-sdcard:
	time nix --extra-experimental-features 'nix-command flakes' \
		build .#packages.aarch64-linux.sdImage \
		--system aarch64-linux \
		--show-trace

nix-bin:
	time nix --extra-experimental-features 'nix-command flakes' \
		build .#packages.aarch64-linux.frameos \
		--system aarch64-linux \
		--show-trace \
		-o tmp/result-frameos
	install -Dm755 tmp/result-frameos/bin/frameos bin/frameos
	@echo "✅  Built binary is now at bin/frameos (aarch64, ready for Pi Zero 2 W)"

nix-shell:
	nix --extra-experimental-features 'nix-command flakes' \
		develop .#frameos

nix-lock:
	time nix --extra-experimental-features 'nix-command flakes' \
		run .#nim_lk -- . > lock.json
