{.compile("gpioHandler.c", "-D USE_LGPIO_LIB -llgpio").}
{.passl: "-llgpio".}

##  Simplified callback function prototype
type
  button_callback_t* = proc (gpio: cint; level: cint)

##  Function to initialize the GPIO system and set the simplified callback
proc init*(callback: button_callback_t): cint {.importc: "init".}

##  Function to register a button for alerts
proc registerButton*(button: cint): cint {.importc: "registerButton".}

##  Function to cleanup resources
proc cleanup*() {.importc: "cleanup".}
