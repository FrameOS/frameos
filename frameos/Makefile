.PHONY: run build test

run: build
	./build/frameos --verbose

build:
	nimble build -y --verbose --lineTrace:on

test:
	nimble test
