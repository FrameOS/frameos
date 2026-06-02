.PHONY: nim_scenes snapshots

PYTHON ?= $(if $(wildcard ../env/bin/python3),../env/bin/python3,$(if $(wildcard ../.venv/bin/python3),../.venv/bin/python3,python3))
COMPILATION_MODE ?= static
E2E_FIXTURE_PORT ?= 54817

all: nim_scenes snapshots

nim_scenes:
	PYTHONPATH="../backend:${PYTHONPATH}" DEBUG=1 SCENE_FILTER="$(SCENE_FILTER)" COMPILATION_MODE="$(COMPILATION_MODE)" FRAMEOS_E2E_FIXTURE_BASE_URL="http://127.0.0.1:$(E2E_FIXTURE_PORT)" $(PYTHON) ./makescenes.py

snapshots:
	mkdir -p ./tmp && \
	mkdir -p ./tmp/state && \
	mkdir -p ./tmp/e2e && \
	mkdir -p ./tmp/backend/app/codegen && \
	mkdir -p ./tmp/backend/app/drivers && \
	mkdir -p ./tmp/backend/app/utils && \
	mkdir -p ./tmp/frontend && \
	rm -rf ./tmp/frameos ./tmp/frontend/src ./tmp/frontend/schema && \
	mkdir -p ./tmp/frameos ./tmp/frontend/src ./tmp/frontend/schema && \
	tmpdir=./tmp/frameos && \
	cp -r ../e2e/*.py ./tmp/e2e && \
	cp -r ../backend/app/codegen/*.py ./tmp/backend/app/codegen && \
	cp -r ../backend/app/drivers/*.py ./tmp/backend/app/drivers && \
	cp ../backend/app/utils/js_apps.py ./tmp/backend/app/utils/js_apps.py && \
	cp ../package.json ./tmp/package.json && \
	cp ../pnpm-workspace.yaml ./tmp/pnpm-workspace.yaml && \
	cp ../pnpm-lock.yaml ./tmp/pnpm-lock.yaml && \
	cp ../frontend/package.json ./tmp/frontend/package.json && \
	cp -r ../frontend/src/. ./tmp/frontend/src && \
	cp -r ../frontend/schema/. ./tmp/frontend/schema && \
	cp ../versions.json ./tmp/versions.json && \
	cp -r ../frameos/* "$$tmpdir" && \
	cp ./frame.json "$$tmpdir/frame.json" && \
	rm -rf "$$tmpdir/src/scenes" && \
	cp -r ./generated "$$tmpdir/src/scenes" && \
	cp -r ./generated/scenes.json "$$tmpdir/" && \
	(cd "$$tmpdir" && make build COMPILATION_MODE="$(COMPILATION_MODE)") && \
	cp "$$tmpdir/build/frameos" ./tmp/frameos-bin && \
	rm -rf ./tmp/scenes && \
	mkdir -p ./tmp/scenes && \
	if [ -d "$$tmpdir/build/scenes" ]; then cp -r "$$tmpdir/build/scenes"/. ./tmp/scenes; fi && \
	rm -rf ./tmp/drivers && \
	mkdir -p ./tmp/drivers && \
	if [ -d "$$tmpdir/build/drivers" ]; then cp -r "$$tmpdir/build/drivers"/. ./tmp/drivers; fi && \
	cp "$$tmpdir/scenes.json" ./tmp/scenes.json

	ls -l ./tmp/frameos-bin
	DEBUG=1 $(PYTHON) ./makeapploaders.py
	DEBUG=1 SCENE_FILTER="$(SCENE_FILTER)" FRAMEOS_E2E_FIXTURE_PORT="$(E2E_FIXTURE_PORT)" $(PYTHON) ./makesnapshots.py
