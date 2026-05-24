AGENT_VERSION ?= $(shell python3 ../tools/frameos_version.py --key=agent ../../versions.json)
NIM_AGENT_FLAGS = --define:frameosAgentVersion:"$(AGENT_VERSION)"

.PHONY: run build test debug

run: build
	./build/frameos_agent --verbose

build:
	nimble build -y --verbose --lineTrace:on --define:useMalloc -d:ssl --panics:on --profiler:on $(NIM_AGENT_FLAGS)

debug:
	nimble build -y --verbose --debugger:native --lineTrace:on -d:ssl $(NIM_AGENT_FLAGS)
	lldb ./build/frameos_agent

test:
	nimble test
