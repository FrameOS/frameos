# Syntax-check a scene app or snippet with the runtime's own engine.
#
#   js_check <source-file>
#
# Compiles the file as an ES module with the bundled QuickJS (quickts, which
# parses TypeScript and JSX itself) and prints one JSON object:
#
#   {"ok": true}
#   {"ok": false, "errors": [{"text": "...", "location": {"line": N, "column": M}}]}
#
# The backend runs this for the editor's "validate" button. It used to run the
# Nim transpiler and then `node --check` on the output, mapping the position
# back through a source map; now the same parser the frame uses reports the
# position directly, so what validates here is exactly what runs there.
import std/[json, os, strutils]

import frameos/js_runtime/burrito

if paramCount() < 1:
  stderr.writeLine("Usage: js_check <source-file>")
  quit(2)

let path = paramStr(1)
let source = readFile(path)
let name = path.extractFilename

proc locationIn(text: string): tuple[line, column: int] =
  ## QuickJS puts the position in the stack ("    at app.ts:12:34") and, for
  ## syntax errors, sometimes in the message. Either way it is the first
  ## `name:line[:column]` after the file name.
  result = (1, 1)
  let at = text.find(name & ":")
  if at < 0:
    return
  var i = at + name.len + 1
  var line = ""
  while i < text.len and text[i] in {'0'..'9'}:
    line.add(text[i])
    inc i
  if line.len == 0:
    return
  result.line = parseInt(line)
  if i < text.len and text[i] == ':':
    inc i
    var column = ""
    while i < text.len and text[i] in {'0'..'9'}:
      column.add(text[i])
      inc i
    if column.len > 0:
      result.column = parseInt(column)

var js = newQuickJS()
let ctx = js.context
let flags = (JS_EVAL_TYPE_MODULE or JS_EVAL_FLAG_COMPILE_ONLY or quicktsFlagsFor(name)).cint
let compiled = JS_Eval(ctx, source.cstring, source.len.csize_t, name.cstring, flags)
if JS_IsException(compiled) != 0:
  let exception = JS_GetException(ctx)
  var message = ""
  var stack = ""
  if jsIsObject(exception):
    let messageVal = JS_GetPropertyStr(ctx, exception, "message")
    message = toNimString(ctx, messageVal)
    JS_FreeValue(ctx, messageVal)
    let stackVal = JS_GetPropertyStr(ctx, exception, "stack")
    stack = toNimString(ctx, stackVal)
    JS_FreeValue(ctx, stackVal)
  else:
    message = toNimString(ctx, exception)
  JS_FreeValue(ctx, exception)
  if message.len == 0:
    message = "JavaScript error"
  var location = locationIn(stack)
  if location.line == 1 and location.column == 1:
    location = locationIn(message)
  stdout.write($(%*{
    "ok": false,
    "errors": [{"text": message, "location": {"line": location.line, "column": location.column}}],
  }))
  js.close()
  quit(1)
JS_FreeValue(ctx, compiled)
js.close()
stdout.write($(%*{"ok": true}))
