.PHONY: run build test debug cross-list

CROSS_OUT ?= build/cross

run: build
	./build/frameos --verbose

build: apploaders
	nimble build -y --verbose --lineTrace:on --stackTrace:on

debug: apploaders
	nimble build -y --verbose --debugger:native --lineTrace:on --stackTrace:on
	lldb ./build/frameos

apploaders:
	FRAMEOS_ROOT_DIR="." python3 ../e2e/makeapploaders.py

cross-list:
	python3 ../backend/bin/cross list

cross-%: apploaders
	python3 ../backend/bin/cross build --target $* --frameos-root $(CURDIR) --artifacts-dir $(CROSS_OUT)

run-%: cross-%
	@slug=$*; \
	metadata="$(CROSS_OUT)/$$slug/metadata.json"; \
	platform=$$(jq -r '.platform // empty' "$$metadata"); \
	image=$$(jq -r '.image // empty' "$$metadata"); \
	if [ -z "$$platform" ] || [ -z "$$image" ]; then \
		echo "Missing platform or image metadata in $$metadata"; \
		exit 1; \
	fi; \
	cache_root="${FRAMEOS_CROSS_CACHE:-$HOME/.cache/frameos/cross}"; \
	sysroot="$$cache_root/$$slug/sysroot"; \
	if [ ! -d "$$sysroot" ]; then \
		echo "Sysroot missing at $$sysroot; rebuilding cross target $$slug"; \
		python3 ../backend/bin/cross build --target $$slug --frameos-root $(CURDIR) --artifacts-dir $(CROSS_OUT); \
	fi; \
	docker run --rm --platform $$platform \
		-v "$(CURDIR)/$(CROSS_OUT)/$$slug:/workspace:ro" \
		-v "$$sysroot:/sysroot:ro" \
		$$image bash -c "set -euo pipefail; export DEBIAN_FRONTEND=noninteractive; apt-get update; SSL_PACKAGE=libssl3; if apt-cache show libssl3t64 >/dev/null 2>&1; then SSL_PACKAGE=libssl3t64; fi; apt-get install -y --no-install-recommends ca-certificates \\$$SSL_PACKAGE; export LD_LIBRARY_PATH=/sysroot/usr/local/lib:/sysroot/usr/lib:\\${LD_LIBRARY_PATH:-}; export PATH=/workspace:\\${PATH}; ${CMD:-/workspace/frameos}"

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
