.PHONY: run build test debug

run: build
	./build/agent --verbose

build:
	nimble build -y --verbose --lineTrace:on

debug:
	nimble build -y --verbose --debugger:native --lineTrace:on
	lldb ./build/agent

test:
	nimble test
