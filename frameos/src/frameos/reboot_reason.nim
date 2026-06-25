import json, os, strutils

const LastServiceExitPath* = "/srv/frameos/runtime/frameos-last-exit"

proc serviceResultKind*(serviceResult: string): string =
  case serviceResult
  of "oom-kill":
    "oom"
  of "watchdog":
    "watchdog"
  of "success":
    "initiated"
  of "":
    "unknown"
  else:
    "error"

proc parseLastServiceExit*(content: string): JsonNode =
  result = newJObject()
  for rawLine in content.splitLines():
    let line = rawLine.strip()
    if line.len == 0:
      continue
    let separator = line.find('=')
    if separator <= 0:
      continue
    let key = line[0 ..< separator].strip()
    let value = line[separator + 1 .. ^1].strip()
    case key
    of "serviceResult", "exitCode", "exitStatus":
      result[key] = %value
    else:
      discard

  if result.hasKey("serviceResult"):
    result["kind"] = %serviceResultKind(result["serviceResult"].getStr())
    result["source"] = %"systemd"
    result["new"] = %true

proc readLastServiceExit*(): JsonNode =
  try:
    if fileExists(LastServiceExitPath):
      return parseLastServiceExit(readFile(LastServiceExitPath))
  except CatchableError:
    discard
  newJObject()

let startupRebootInfo = readLastServiceExit()

proc startupRebootInfoSnapshot*(): JsonNode =
  result = newJObject()
  for key, value in startupRebootInfo:
    result[key] = value
