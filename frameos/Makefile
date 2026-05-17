.PHONY: run build drivers maybe-driver-libraries maybe-scene-libraries driver-libraries scene-libraries test test-shard debug cross-list release-% release-all

CROSS_OUT ?= build/cross
PREBUILT_OUT ?= build/prebuilt-cross
COMPILATION_MODE ?=
RELEASE_ARGS ?=
SKIP_DRIVER_LIBRARIES ?= 0
SKIP_SCENE_LIBRARIES ?= 0
COMPILATION_MODE_ARG = $(if $(COMPILATION_MODE),--compilation-mode $(COMPILATION_MODE),)
NIM ?= nim
NIMCACHE ?= .nimcache
FRAMEOS_VERSION ?= $(shell python3 tools/frameos_version.py ../versions.json)
NIM_BUILD_FLAGS = --out:build/frameos --nimcache:"$(NIMCACHE)" --lineTrace:on --stackTrace:on -d:malloc --define:frameosVersion:"$(FRAMEOS_VERSION)"

run: build
	./build/frameos --verbose

build: apploaders drivers maybe-driver-libraries maybe-scene-libraries
	python3 tools/prepare_assets.py
	@if [ ! -d quickjs ]; then nimble build_quickjs --silent; fi
	@if [ ! -f nimble.paths ]; then nimble setup --silent; fi
	mkdir -p build
	$(NIM) c $(NIM_BUILD_FLAGS) src/frameos.nim

drivers:
	python3 tools/generate_driver_sources.py --config frame.json $(COMPILATION_MODE_ARG)

maybe-driver-libraries:
	@if [ "$(SKIP_DRIVER_LIBRARIES)" = "1" ]; then \
		echo "Skipping shared driver libraries"; \
	else \
		python3 tools/build_driver_libraries.py --config frame.json --out build/drivers --only-if-shared $(COMPILATION_MODE_ARG); \
	fi

maybe-scene-libraries:
	@if [ "$(SKIP_SCENE_LIBRARIES)" = "1" ]; then \
		echo "Skipping shared scene libraries"; \
	else \
		python3 tools/build_scene_libraries.py --config frame.json --out build/scenes --only-if-shared $(COMPILATION_MODE_ARG); \
	fi

driver-libraries: drivers
	python3 tools/build_driver_libraries.py --config frame.json --out build/drivers

scene-libraries:
	python3 tools/build_scene_libraries.py --config frame.json --out build/scenes

debug: apploaders drivers maybe-driver-libraries maybe-scene-libraries
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
	@test -n "$(SHARD)" || (echo "SHARD is required, e.g. make test-shard SHARD=1..5" >&2; exit 1)
	bash ./tools/run_test_shard.sh "$(SHARD)"
