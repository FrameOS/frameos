REMOTE_VERSION ?= $(shell python3 ../tools/frameos_version.py --key=remote ../../versions.json)
NIM_REMOTE_FLAGS = --define:frameosRemoteVersion:"$(REMOTE_VERSION)"

.PHONY: run build test debug

run: build
	./build/frameos_remote --verbose

build:
	nimble build -y --verbose --lineTrace:on --define:useMalloc -d:ssl --panics:on --profiler:on $(NIM_REMOTE_FLAGS)

debug:
	nimble build -y --verbose --debugger:native --lineTrace:on -d:ssl $(NIM_REMOTE_FLAGS)
	lldb ./build/frameos_remote

test:
	nimble test
