import std/os

import frameos/js_runtime/parser
import frameos/js_runtime/tokens
import frameos/js_runtime/transpiler

if paramCount() < 2:
  stderr.writeLine("Usage: native_js_transpile <script|module|tokens|parse> <source-file>")
  quit(2)

let mode = paramStr(1)
let path = paramStr(2)
let source = readFile(path)

try:
  case mode
  of "script":
    stdout.write(transformFrameosScript(source, path))
  of "module":
    stdout.write(transformFrameosModule(source, path))
  of "tokens":
    stdout.write(formatTokens(source, tokenizeJs(source)))
  of "parse":
    stdout.write(formatAnnotatedTokens(source, parseJs(source)))
  else:
    stderr.writeLine("Unknown mode: " & mode)
    quit(2)
except CatchableError as error:
  stderr.writeLine(error.msg)
  quit(1)
