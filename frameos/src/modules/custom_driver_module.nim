proc frameosDriverInit*(frameOS: pointer) {.exportc, dynlib, cdecl.} =
  discard

proc frameosDriverRender*(image: pointer) {.exportc, dynlib, cdecl.} =
  discard

proc frameosDriverToPng*(rotate: cint): cstring {.exportc, dynlib, cdecl.} =
  ""

proc frameosDriverTurnOn*() {.exportc, dynlib, cdecl.} =
  discard

proc frameosDriverTurnOff*() {.exportc, dynlib, cdecl.} =
  discard
