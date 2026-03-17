.PHONY: nim_scenes compiled_scene_plugins snapshots

PYTHON ?= $(if $(wildcard ../env/bin/python3),../env/bin/python3,python3)
FRAMEOS_BUILD_APP_RETRIES ?= 2

all: snapshots

nim_scenes:
	PYTHONPATH="../backend:${PYTHONPATH}" DEBUG=1 SCENE_FILTER="$(SCENE_FILTER)" $(PYTHON) ./makescenes.py

compiled_scene_plugins: nim_scenes
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
	cp -r ./code "$$tmpdir/src/scenes" && \
	cp -r ./code/scenes.json "$$tmpdir/" && \
	(cd "$$tmpdir" && make build-scenes COMPILED_SCENES_OUTPUT_DIR=../../scenes) && \
	attempt=0; \
	until (cd "$$tmpdir" && make build-app); do \
		status=$$?; \
		attempt=$$((attempt + 1)); \
		if [ "$$attempt" -gt "$(FRAMEOS_BUILD_APP_RETRIES)" ]; then \
			exit "$$status"; \
		fi; \
		echo "frameos build-app failed with exit $$status; retrying ($$attempt/$(FRAMEOS_BUILD_APP_RETRIES))..." >&2; \
	done && \
	cp "$$tmpdir/build/frameos" ./tmp/frameos-bin && \
	cp "$$tmpdir/scenes.json" ./tmp/scenes.json

snapshots: compiled_scene_plugins
	ls -l ./tmp/frameos-bin
	DEBUG=1 $(PYTHON) ./makeapploaders.py
	DEBUG=1 SCENE_FILTER="$(SCENE_FILTER)" $(PYTHON) ./makesnapshots.py
