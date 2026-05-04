.PHONY: run build drivers maybe-driver-libraries driver-libraries test test-shard debug cross-list release-% release-all

CROSS_OUT ?= build/cross
PREBUILT_OUT ?= build/prebuilt-cross
DRIVER_BUILD_MODE ?=
RELEASE_ARGS ?=
SKIP_DRIVER_LIBRARIES ?= 0
DRIVER_BUILD_MODE_ARG = $(if $(DRIVER_BUILD_MODE),--driver-build-mode $(DRIVER_BUILD_MODE),)
NIM ?= nim
NIMCACHE ?= .nimcache
NIM_BUILD_FLAGS = --out:build/frameos --nimcache:"$(NIMCACHE)" --lineTrace:on --stackTrace:on

run: build
	./build/frameos --verbose

build: apploaders drivers maybe-driver-libraries
	python3 tools/prepare_assets.py
	@if [ ! -d quickjs ]; then nimble build_quickjs --silent; fi
	@if [ ! -f nimble.paths ]; then nimble setup --silent; fi
	mkdir -p build
	$(NIM) c $(NIM_BUILD_FLAGS) src/frameos.nim

drivers:
	python3 tools/generate_driver_sources.py --config frame.json $(DRIVER_BUILD_MODE_ARG)

maybe-driver-libraries:
	@if [ "$(SKIP_DRIVER_LIBRARIES)" = "1" ]; then \
		echo "Skipping shared driver libraries"; \
	else \
		python3 tools/build_driver_libraries.py --config frame.json --out build/drivers --only-if-shared $(DRIVER_BUILD_MODE_ARG); \
	fi

driver-libraries: drivers
	python3 tools/build_driver_libraries.py --config frame.json --out build/drivers

debug: apploaders drivers maybe-driver-libraries
	python3 tools/prepare_assets.py
	@if [ ! -d quickjs ]; then nimble build_quickjs --silent; fi
	@if [ ! -f nimble.paths ]; then nimble setup --silent; fi
	mkdir -p build
	$(NIM) c $(NIM_BUILD_FLAGS) --debugger:native src/frameos.nim
	lldb ./build/frameos

apploaders:
	FRAMEOS_ROOT_DIR="." python3 ../e2e/makeapploaders.py

cross-list:
	python3 ../backend/bin/cross list

cross-%: apploaders
	python3 ../backend/bin/cross build --target $* --frameos-root $(CURDIR) --artifacts-dir $(CROSS_OUT)

release-%: apploaders
	python3 ../backend/bin/cross release --target $* --frameos-root $(CURDIR) --artifacts-dir $(PREBUILT_OUT) $(RELEASE_ARGS)

release-all: apploaders
	python3 ../backend/bin/cross release --all-targets --frameos-root $(CURDIR) --artifacts-dir $(PREBUILT_OUT) $(RELEASE_ARGS)

test:
	nimble test

test-shard:
	@test -n "$(SHARD)" || (echo "SHARD is required, e.g. make test-shard SHARD=1" >&2; exit 1)
	bash ./tools/run_test_shard.sh "$(SHARD)"
