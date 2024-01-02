transform_epd_files:
	`nimble path c2nim`/c2nim --assumendef:DEBUG --assumedef:USE_LGPIO_LIB --assumedef:RPI --assumendef:JETSON --assumendef:USE_BCM2835_LIB --assumendef:USE_WIRINGPI_LIB --assumendef:USE_DEV_LIB --importc EPD_*.h

	for file in EPD_*.h; do \
		base=$$(basename "$$file" .h); \
		baseupper=$$(basename "$$file" .h | tr '[:lower:]' '[:upper:]'); \
		`nimble path c2nim`/c2nim --assumendef:DEBUG --prefix:"$$base"_ --prefix:"$$baseupper"_ --importc $$file; \
		echo '{.compile: "'$$base'.c".}' > "$$file.tmp"; \
		cat "$$base".nim >> "$$file.tmp"; \
		mv "$$file.tmp" "$$base".nim; \
	done

	# TODO: remove Debug.h from all files
