.PHONY: nim_scenes snapshots

PYTHON ?= $(if $(wildcard ../env/bin/python3),../env/bin/python3,python3)

all: nim_scenes snapshots

nim_scenes:
	PYTHONPATH="../backend:${PYTHONPATH}" DEBUG=1 SCENE_FILTER="$(SCENE_FILTER)" $(PYTHON) ./makescenes.py

snapshots:
	mkdir -p ./tmp && \
	mkdir -p ./tmp/state && \
	mkdir -p ./tmp/e2e && \
	mkdir -p ./tmp/backend/app/codegen && \
	mkdir -p ./tmp/frontend && \
	rm -rf ./tmp/frameos ./tmp/frontend/src ./tmp/frontend/schema && \
	mkdir -p ./tmp/frameos ./tmp/frontend/src ./tmp/frontend/schema && \
	tmpdir=./tmp/frameos && \
	cp -r ../e2e/*.py ./tmp/e2e && \
	cp -r ../backend/app/codegen/*.py ./tmp/backend/app/codegen && \
	cp ../package.json ./tmp/package.json && \
	cp ../pnpm-workspace.yaml ./tmp/pnpm-workspace.yaml && \
	cp ../pnpm-lock.yaml ./tmp/pnpm-lock.yaml && \
	cp ../frontend/package.json ./tmp/frontend/package.json && \
	cp -r ../frontend/src/. ./tmp/frontend/src && \
	cp -r ../frontend/schema/. ./tmp/frontend/schema && \
	cp ../versions.json ./tmp/versions.json && \
	cp -r ../frameos/* "$$tmpdir" && \
	rm -rf "$$tmpdir/src/scenes" && \
	cp -r ./generated "$$tmpdir/src/scenes" && \
	cp -r ./generated/scenes.json "$$tmpdir/" && \
	(cd "$$tmpdir" && make build) && \
	cp "$$tmpdir/build/frameos" ./tmp/frameos-bin && \
	cp "$$tmpdir/scenes.json" ./tmp/scenes.json

	ls -l ./tmp/frameos-bin
	DEBUG=1 $(PYTHON) ./makeapploaders.py
	DEBUG=1 SCENE_FILTER="$(SCENE_FILTER)" $(PYTHON) ./makesnapshots.py
