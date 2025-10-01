.PHONY: run build test debug

run: build
	./build/frameos --verbose

build: apploaders
	nimble build -y --verbose --lineTrace:on --stackTrace:on

debug: apploaders
	nimble build -y --verbose --debugger:native --lineTrace:on --stackTrace:on
	lldb ./build/frameos

apploaders:
	FRAMEOS_ROOT_DIR="." python3 ../e2e/makeapploaders.py

test:
	nimble test

nix-sdcard:
	nix --extra-experimental-features 'nix-command flakes' \
		build .#packages.aarch64-linux.sdImage \
		--system aarch64-linux \
		--show-trace

nix-update:
	nix --extra-experimental-features 'nix-command flakes' \
		build .#nixosConfigurations."frame-nixtest".config.system.build.toplevel \
		--system aarch64-linux \
		--print-out-paths \
		--show-trace

nix-bin:
	nix --extra-experimental-features 'nix-command flakes' \
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
	nix --extra-experimental-features 'nix-command flakes' \
		run .#nim_lk -- . > lock.json
