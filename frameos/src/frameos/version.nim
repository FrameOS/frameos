import std/strutils

const frameosVersion* {.strdefine.}: string = "unknown"

proc compiledFrameOSVersion*(): string =
  result = frameosVersion.strip()
  if result.len == 0:
    result = "unknown"

proc publishedFrameOSVersion*(version: string): string =
  result = version.strip()
  if result.startsWith("v"):
    result = result[1 .. ^1]
  let plus = result.find('+')
  if plus >= 0:
    result = result[0 ..< plus]
  if result.len == 0:
    result = "unknown"
