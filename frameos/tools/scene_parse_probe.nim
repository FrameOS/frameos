## Host probe: the heap a Linux runtime spends reading its scenes
## (docs/scene-packages.md, "What reading a set costs on a Pi").
##
##   python3 tools/prepare_assets.py   # once: the asset modules the runtime imports
##   nim c -d:release --nimcache:build/scene-packages/nimcache \
##     -o:build/scene-packages/scene_parse_probe tools/scene_parse_probe.nim
##   build/scene-packages/scene_parse_probe <scenes.json> deployed
##   build/scene-packages/scene_parse_probe <{"scenes": [...]}> upload
##
## `deployed` is scenes.json read whole and parsed by the scene reader
## (interpreter.parseInterpretedScenes), as loadInterpretedScenesFromDisk
## does after the gunzip. `upload` is the uploadScenes path
## (scenes.updateUploadedScenesFromPayload): the HTTP body parsed by std/json,
## turned back into text, read by the scene reader and built. The numbers
## are x86_64 ORC's (getOccupiedMem / getMaxMem); a 32-bit Pi's pointers are
## half the size, so its trees are somewhat smaller.
import std/[json, os, tables]
import frameos/interpreter

proc kb(n: int): string = $(n div 1024) & " KB"

let path = paramStr(1)
let mode = paramStr(2)
let before = getOccupiedMem()
if mode == "deployed":
  let text = readFile(path)
  let afterRead = getOccupiedMem()
  let scenes = parseInterpretedScenes(text)
  echo "deployed: text ", kb(text.len), " read +", kb(afterRead - before),
    " held after parse (text included) +", kb(getOccupiedMem() - before),
    " peak ", kb(getMaxMem()), " scenes ", scenes.len
elif mode == "upload":
  let body = readFile(path)
  let payload = parseJson(body)
  let afterJson = getOccupiedMem()
  let again = $payload["scenes"]
  let afterText = getOccupiedMem()
  let inputs = parseInterpretedSceneInputs(again)
  let built = buildInterpretedScenes(inputs)
  echo "upload: body ", kb(body.len), " std/json tree +", kb(afterJson - before),
    " text again +", kb(afterText - afterJson),
    " held after build +", kb(getOccupiedMem() - before), " peak ", kb(getMaxMem()),
    " scenes ", built.len
else:
  quit "mode is deployed or upload"
