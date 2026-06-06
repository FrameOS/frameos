import std/[json, os]

import frameos/js_runtime/parser
import frameos/js_runtime/source_map
import frameos/js_runtime/tokens
import frameos/js_runtime/transpiler

if paramCount() < 2:
  stderr.writeLine("Usage: native_js_transpile <script|module|script-json|module-json|tokens|parse> <source-file>")
  quit(2)

let mode = paramStr(1)
let path = paramStr(2)
let source = readFile(path)

proc sourceMapToJson(sourceMap: SourceLineMap): JsonNode =
  let segments = newJArray()
  for segment in sourceMap.segments:
    segments.add(%*{
      "generatedLine": segment.generatedLine,
      "generatedColumn": segment.generatedColumn,
      "sourceLine": segment.sourceLine,
      "sourceColumn": segment.sourceColumn,
    })

  %*{
    "generatedName": sourceMap.generatedName,
    "sourceName": sourceMap.sourceName,
    "generatedToSourceLine": sourceMap.generatedToSourceLine,
    "segments": segments,
  }

proc writeTransformJson(transformed: TransformResult) =
  stdout.write($(%*{
    "ok": true,
    "code": transformed.code,
    "sourceMap": transformed.sourceMap.sourceMapToJson(),
  }))

try:
  case mode
  of "script":
    stdout.write(transformFrameosScript(source, path))
  of "module":
    stdout.write(transformFrameosModule(source, path))
  of "script-json":
    writeTransformJson(transform(source, TransformOptions(filePath: path, transforms: @["typescript", "jsx"])))
  of "module-json":
    writeTransformJson(transform(source, TransformOptions(filePath: path, transforms: @["typescript", "jsx", "imports"])))
  of "tokens":
    stdout.write(formatTokens(source, tokenizeJs(source)))
  of "parse":
    stdout.write(formatAnnotatedTokens(source, parseJs(source)))
  else:
    stderr.writeLine("Unknown mode: " & mode)
    quit(2)
except CatchableError as error:
  if mode in ["script-json", "module-json"]:
    stdout.write($(%*{
      "ok": false,
      "errors": [
        {
          "text": error.msg,
          "location": {"line": 1, "column": 1},
        }
      ],
    }))
  else:
    stderr.writeLine(error.msg)
  quit(1)
