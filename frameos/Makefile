.PHONY: run build test test-shard debug cross-list

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

test:
	nimble test

test-shard:
	@test -n "$(SHARD)" || (echo "SHARD is required, e.g. make test-shard SHARD=1" >&2; exit 1)
	bash ./tools/run_test_shard.sh "$(SHARD)"
