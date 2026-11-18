## A base64 string inside a JSON reply, written to a file without becoming a
## string of its own: what `httpRequest`'s `saveBase64Field` does with an
## image an API returns inline (OpenAI's image generation `result`, about
## 0.5-1 MB of text). As a JS string the same picture is several copies of
## that on an ESP32 (the reply, its JSON, the JS string, JSON.parse's copy,
## writeAsset's decode), more than an 8 MB board has left beside a large
## canvas; here it is the reply and one chunk at a time.

import std/[base64, os, strutils]

const Base64Chunk = 48 * 1024 ## base64 characters decoded at a time, a multiple of 4

proc jsonStringFieldSpan*(body, field: string): tuple[start, stop: int] =
  ## Where the text of the first `"field": "…"` string value in `body` is
  ## (`stop` exclusive), or (-1, -1). A key inside another string is escaped
  ## (`\"field\"`) and so never matches.
  result = (-1, -1)
  if field.len == 0:
    return
  let key = "\"" & field & "\""
  var at = body.find(key)
  while at >= 0:
    var i = at + key.len
    while i < body.len and body[i] in Whitespace: inc i
    if i < body.len and body[i] == ':':
      inc i
      while i < body.len and body[i] in Whitespace: inc i
      if i < body.len and body[i] == '"':
        var j = i + 1
        while j < body.len and body[j] != '"':
          if body[j] == '\\': inc j
          inc j
        if j < body.len:
          return (i + 1, j)
        return
    at = body.find(key, at + key.len)

proc writeBase64Span*(body: string, start, stop: int, path: string): int =
  ## Decodes `body[start ..< stop]`, base64 as JSON writes it (a `\/` is a
  ## slash, a `\n` or `\r` nothing), into the file at `path`, a chunk at a
  ## time. The bytes written, or -1 when the file cannot be written or the
  ## text is not base64 (the file is then removed).
  var file: File
  if not file.open(path, fmWrite):
    return -1
  var ok = true
  var total = 0
  var chunk = newStringOfCap(Base64Chunk)
  var i = start
  try:
    while i < stop and ok:
      chunk.setLen(0)
      while i < stop and chunk.len < Base64Chunk:
        let c = body[i]
        if c == '\\' and i + 1 < stop:
          inc i
          if body[i] notin {'n', 'r'}:
            chunk.add body[i]
        elif c notin Whitespace:
          chunk.add c
        inc i
      let bytes = decode(chunk)
      file.write(bytes)
      total += bytes.len
  except CatchableError:
    ok = false
  file.close()
  if not ok or total == 0:
    try: removeFile(path) except CatchableError: discard
    return -1
  total
