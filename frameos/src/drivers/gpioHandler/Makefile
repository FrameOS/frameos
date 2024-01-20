debug:
	rm -f debug
	gcc -o debug debug.c gpioHandler.c -llgpio
	./debug
c2nim:
	# `nimble path c2nim`/c2nim --importc gpioHandler.h
	`nimble path c2nim`/c2nim --importc lgpio.h
