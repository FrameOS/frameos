.PHONY: nim_scenes snapshots

all: nim_scenes snapshots

nim_scenes:
	PYTHONPATH="../backend:${PYTHONPATH}" DEBUG=1 python3 ./makescenes.py

snapshots:
	mkdir -p ./tmp && \
	tmpdir=$$(mktemp -d -p ./tmp) && \
	cp -r ../frameos/* "$$tmpdir" && \
	rm -rf "$$tmpdir/src/scenes" && \
	cp -r ./generated "$$tmpdir/src/scenes" && \
	(cd "$$tmpdir" && make build) && \
	cp "$$tmpdir/build/frameos" ./tmp/frameos && \
	rm -rf "$$tmpdir"

	ls -l ./tmp/frameos	
	DEBUG=1 python3 ./makesnapshots.py
