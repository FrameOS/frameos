{.compile("gpioHandler.c", "-D USE_LGPIO_LIB -llgpio").}
{.passl: "-llgpio".}

type
  event_callback_t* = proc (gpio: cint; level: cint) {.cdecl.}
  log_callback_t* = proc (message: cstring) {.cdecl.}

proc init*(event_callback: event_callback_t; log_callback: log_callback_t): cint {.importc: "gpioHandler_init".}
proc registerButton*(button: cint): cint {.importc: "gpioHandler_registerButton".}
proc readValue*(button: cint): cint {.importc: "gpioHandler_readValue".}
proc cleanup*() {.importc: "gpioHandler_cleanup".}
