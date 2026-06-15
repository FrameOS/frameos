## Entropy HAL.
##
## Nim's no-argument `randomize()` reads OS entropy (getrandom//dev/urandom)
## and calls quit() when the platform has neither — which aborts the firmware
## on FreeRTOS. The ESP32 has a hardware TRNG instead: seed explicitly from
## esp_random(). Everything that seeds std/random goes through here.

import std/random

when defined(frameosEmbedded):
  proc esp_random(): uint32 {.importc: "esp_random", cdecl.}

  proc randomizeSafe*() =
    ## Seed std/random's global state from the hardware RNG.
    let seed = (int64(esp_random()) shl 32) or int64(esp_random())
    randomize(if seed == 0: 1'i64 else: seed)

  proc initRandSafe*(): Rand =
    let seed = (int64(esp_random()) shl 32) or int64(esp_random())
    initRand(if seed == 0: 1'i64 else: seed)
else:
  proc randomizeSafe*() =
    randomize()

  proc initRandSafe*(): Rand =
    var r = initRand()
    r
