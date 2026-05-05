import std/[json, options]
import frameos/ids

type
  HostLogProc* = proc(event: JsonNode) {.cdecl, gcsafe.}
  HostSendEventProc* = proc(scene: Option[SceneId], event: string, payload: JsonNode) {.cdecl, gcsafe.}
  DriverSetupProc* = proc(): bool {.cdecl.}
  DriverInitProc* = proc(frameOS: pointer, logHook: HostLogProc, sendEventHook: HostSendEventProc): pointer {.cdecl.}
  DriverRenderProc* = proc(driver: pointer, image: pointer) {.cdecl.}
  DriverToPngProc* = proc(driver: pointer, rotate: cint, flip: cstring, length: ptr int): pointer {.cdecl.}
  DriverActionProc* = proc(driver: pointer) {.cdecl.}
