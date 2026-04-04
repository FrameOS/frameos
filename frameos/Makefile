.PHONY: run build build-app build-scenes test test-shard debug cross-list clean-scenes
.PHONY: cross-frameos-% cross-drivers-%

CROSS_OUT ?= ../files
COMPILED_SCENES_OUTPUT_DIR ?= scenes
COMPILED_SCENES_JOBS ?=

run: build
	./build/frameos --verbose

build: build-scenes build-app

build-app: apploaders
	nimble build -y --verbose --lineTrace:on --stackTrace:on

build-scenes: apploaders
	nimble assets -y
	nimble setup
	python3 tools/build_compiled_scenes.py --frameos-root . --output-dir "$(COMPILED_SCENES_OUTPUT_DIR)" $(if $(COMPILED_SCENES_JOBS),--jobs "$(COMPILED_SCENES_JOBS)")

debug: build-scenes apploaders
	nimble build -y --verbose --debugger:native --lineTrace:on --stackTrace:on
	lldb ./build/frameos

apploaders:
	FRAMEOS_ROOT_DIR="." python3 ../e2e/makeapploaders.py

cross-list:
	python3 ../backend/bin/cross list

cross-%: apploaders
	python3 ../backend/bin/cross build --target $* --frameos-root $(CURDIR) --artifacts-dir $(CROSS_OUT)

cross-frameos-%: apploaders
	python3 ../backend/bin/cross build-frameos --target $* --frameos-root $(CURDIR) --artifacts-dir $(CROSS_OUT)

cross-drivers-%: apploaders
	python3 ../backend/bin/cross build-drivers --target $* --frameos-root $(CURDIR) --artifacts-dir $(CROSS_OUT)

test:
	nimble test

test-shard:
	@test -n "$(SHARD)" || (echo "SHARD is required, e.g. make test-shard SHARD=1" >&2; exit 1)
	bash ./tools/run_test_shard.sh "$(SHARD)"

clean-scenes:
	rm -rf ./scenes
