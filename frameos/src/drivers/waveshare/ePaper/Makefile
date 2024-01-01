transform_epd_files:
	export USE_LGPIO_LIB=1
	`nimble path c2nim`/c2nim --assumedef:DEBUG --assumedef:USE_LGPIO_LIB --assumedef:RPI --assumendef:JETSON --assumendef:USE_BCM2835_LIB --assumendef:USE_WIRINGPI_LIB --assumendef:USE_DEV_LIB --importc EPD_*.h
	
	echo '{.compile("EPD_7in5_V2.c", "-D epd7in5V2 -D USE_LGPIO_LIB -D RPI -llgpio").}' > EPD_7in5_V2.nim.tmp
	cat EPD_7in5_V2.nim >> EPD_7in5_V2.nim.tmp
	mv EPD_7in5_V2.nim.tmp EPD_7in5_V2.nim

