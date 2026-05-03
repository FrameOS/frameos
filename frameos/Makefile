.PHONY: run build drivers maybe-driver-libraries driver-libraries test test-shard debug cross-list

CROSS_OUT ?= build/cross
DRIVER_BUILD_MODE ?=
SKIP_DRIVER_LIBRARIES ?= 0
DRIVER_BUILD_MODE_ARG = $(if $(DRIVER_BUILD_MODE),--driver-build-mode $(DRIVER_BUILD_MODE),)

run: build
	./build/frameos --verbose

build: apploaders drivers maybe-driver-libraries
	nimble build -y --verbose --lineTrace:on --stackTrace:on

drivers:
	python3 tools/generate_driver_sources.py --config frame.json $(DRIVER_BUILD_MODE_ARG)

maybe-driver-libraries:
	@if [ "$(SKIP_DRIVER_LIBRARIES)" = "1" ]; then \
		echo "Skipping shared driver libraries"; \
	else \
		python3 tools/build_driver_libraries.py --config frame.json --out build/drivers --only-if-shared; \
	fi

driver-libraries: drivers
	python3 tools/build_driver_libraries.py --config frame.json --out build/drivers

debug: apploaders drivers maybe-driver-libraries
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
