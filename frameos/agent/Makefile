.PHONY: run build test debug

run: build
	./build/frameos_agent --verbose

build:
	nimble build -y --verbose --lineTrace:on --define:useMalloc -d:ssl --panics:on --profiler:on

debug:
	nimble build -y --verbose --debugger:native --lineTrace:on -d:ssl
	lldb ./build/frameos_agent

test:
	nimble test

nix-bin:
	nix --extra-experimental-features 'nix-command flakes' \
		build ../#packages.aarch64-linux.frameos_agent \
		--system aarch64-linux \
		--show-trace \
		-o dist
	@echo "✅  Built binary is now at dist/bin/frameos_agent (aarch64, ready for Pi Zero 2 W)"

nix-lock:
	nix --extra-experimental-features 'nix-command flakes' \
		run ../#nim_lk -- . > lock.json
