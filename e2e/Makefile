.PHONY: nim_scenes snapshots

all: nim_scenes snapshots

nim_scenes:
	PYTHONPATH="../backend:${PYTHONPATH}" DEBUG=1 SCENE_FILTER="$(SCENE_FILTER)" python3 ./makescenes.py

snapshots:
	mkdir -p ./tmp && \
	mkdir -p ./tmp/state && \
	mkdir -p ./tmp/e2e-temp-frameos && \
	mkdir -p ./tmp/e2e && \
	mkdir -p ./tmp/backend/app/codegen && \
	tmpdir=./tmp/e2e-temp-frameos && \
	cp -r ../e2e/*.py ./tmp/e2e && \
	cp -r ../backend/app/codegen/*.py ./tmp/backend/app/codegen && \
	cp -r ../frameos/* "$$tmpdir" && \
	rm -rf "$$tmpdir/src/scenes" && \
	cp -r ./generated "$$tmpdir/src/scenes" && \
	cp -r ./generated/scenes.json "$$tmpdir/" && \
	(cd "$$tmpdir" && make build) && \
	cp "$$tmpdir/build/frameos" ./tmp/frameos && \
	cp "$$tmpdir/scenes.json" ./tmp/scenes.json

	ls -l ./tmp/frameos
	DEBUG=1 python3 ./makeapploaders.py
	DEBUG=1 SCENE_FILTER="$(SCENE_FILTER)" python3 ./makesnapshots.py
