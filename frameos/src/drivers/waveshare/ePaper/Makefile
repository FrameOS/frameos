# this was used to convert the main files
#`nimble path c2nim`/c2nim --assumendef:DEBUG --assumedef:USE_LGPIO_LIB --assumedef:RPI --assumendef:JETSON --assumendef:USE_BCM2835_LIB --assumendef:USE_WIRINGPI_LIB --assumendef:USE_DEV_LIB --importc EPD_*.h

all: transform-epd-files

transform-epd-files: remove-slashes
	for file in EPD_*.h; do \
		base=$$(basename "$$file" .h); \
		`nimble path c2nim`/c2nim --assumendef:DEBUG --importc $$file; \
		echo '{.compile: "'$$base'.c".}' > "$$file.tmp"; \
		cat "$$base".nim >> "$$file.tmp"; \
		mv "$$file.tmp" "$$base".nim; \
	done


remove-slashes:
	# c2nim stumbles if a line ends with an empty comment "//", and makes noise with a full comment
	@if [ "$$(uname)" = "Darwin" ]; then \
		find . -type f -name 'EPD_*.h' -exec sed -i '' 's|//.*$$||' {} +; \
	else \
		find . -type f -name 'EPD_*.h' -exec sed -i 's|//$$||' {} +; \
	fi
