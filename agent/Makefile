.PHONY: run build test debug

run: build
	./build/frameos_agent --verbose

build:
	nimble build -y --verbose --lineTrace:on -d:ssl

debug:
	nimble build -y --verbose --debugger:native --lineTrace:on -d:ssl
	lldb ./build/frameos_agent

test:
	nimble test
