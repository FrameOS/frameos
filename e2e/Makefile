.PHONY: nim_scenes snapshots

all: nim_scenes snapshots

nim_scenes:
	PYTHONPATH="../backend:${PYTHONPATH}" DEBUG=1 SCENE_FILTER="$(SCENE_FILTER)" python3 ./makescenes.py

snapshots:
	mkdir -p ./tmp && \
	mkdir -p ./tmp/state && \
	tmpdir=$$(mktemp -d -p ./tmp) && \
	cp -r ../frameos/* "$$tmpdir" && \
	rm -rf "$$tmpdir/src/scenes" && \
	cp -r ./generated "$$tmpdir/src/scenes" && \
	cp -r ./generated/scenes.json "$$tmpdir/" && \
	cp -r ../frameos/src/scenes/interpreted.nim "$$tmpdir"/src/scenes/ && \
	(cd "$$tmpdir" && make build) && \
	cp "$$tmpdir/build/frameos" ./tmp/frameos && \
	cp "$$tmpdir/scenes.json" ./tmp/scenes.json && \
	rm -rf "$$tmpdir"

	ls -l ./tmp/frameos
	DEBUG=1 SCENE_FILTER="$(SCENE_FILTER)" python3 ./makesnapshots.py
