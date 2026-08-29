import std/[strutils, unittest]

import frameos/js_runtime/source_map

# The line mapper used to build a longest-common-subsequence table: one int per
# (generated line x source line) pair, quadratic in file length. A 965-line app
# wanted ~932,000 cells, which is how a bundled scene exhausted an 8 MB ESP32 —
# building a source map so error messages could name the right line cost more
# than the render did. It is a single forward scan now, and these tests pin the
# behaviour that scan has to keep.

suite "source map line mapping":
  test "maps lines through an inserted prelude":
    let source = "alpha\nbeta\ngamma\n"
    let generated = "\"use strict\";\nalpha\nbeta\ngamma\n"
    let map = lineBasedSourceLineMap(source, generated, "gen.js", "src.ts")
    check map.mapGeneratedLine(2) == 1
    check map.mapGeneratedLine(3) == 2
    check map.mapGeneratedLine(4) == 3

  test "maps lines across deleted type declarations":
    let source = "type Removed = number;\nalpha\ninterface Gone {}\nbeta\n"
    let generated = "alpha\nbeta\n"
    let map = lineBasedSourceLineMap(source, generated, "gen.js", "src.ts")
    check map.mapGeneratedLine(1) == 2
    check map.mapGeneratedLine(2) == 4

  test "handles insertions and deletions in the same file":
    let source = "alpha\ntype T = 1;\nbeta\ngamma\n"
    let generated = "\"use strict\";\nalpha\nbeta\ngamma\nexports.get = get;\n"
    let map = lineBasedSourceLineMap(source, generated, "gen.js", "src.ts")
    check map.mapGeneratedLine(2) == 1
    check map.mapGeneratedLine(3) == 3
    check map.mapGeneratedLine(4) == 4

  test "large line-preserving files map exactly and stay linear":
    # The shape a transpiled app actually has: a prelude inserted, an epilogue
    # appended, and type annotations stripped from a minority of lines while
    # the rest survive verbatim. The old table for this pair would have been
    # ~4 million cells; the scan visits each line once.
    let lineCount = 2000
    var sourceLines = newSeq[string](lineCount)
    var generatedLines = newSeq[string](lineCount)
    for i in 0 ..< lineCount:
      generatedLines[i] = "const value" & $i & " = " & $i & ";"
      sourceLines[i] =
        if i mod 10 == 0: "const value" & $i & ": number = " & $i & ";"
        else: generatedLines[i]

    let source = sourceLines.join("\n")
    let generated = "\"use strict\";\n" & generatedLines.join("\n") & "\nexports.get = get;\n"
    let map = lineBasedSourceLineMap(source, generated, "gen.js", "src.ts")

    # One inserted prelude line, so generated line N+1 is source line N — both
    # for the lines that survived verbatim and for the stripped ones between.
    check map.mapGeneratedLine(2) == 1
    check map.mapGeneratedLine(12) == 11     # a stripped line, interpolated
    check map.mapGeneratedLine(1001) == 1000
    check map.mapGeneratedLine(lineCount + 1) == lineCount

  test "segments stay proportional to lines, not to characters":
    # Segments were once emitted per character of every line — about one per
    # byte of the file, retained for as long as the app is loaded and scanned
    # linearly on each error lookup. A couple per line is the budget now.
    let lineCount = 300
    var lines = newSeq[string](lineCount)
    for i in 0 ..< lineCount:
      lines[i] = "  const someRatherLongVariableName" & $i & " = " & $i & ";"
    let text = lines.join("\n")
    let map = lineBasedSourceLineMap(text, text, "gen.js", "src.ts")
    check text.len > 10_000
    check map.segments.len <= lineCount * 3

  test "a file name only matches at a path boundary":
    # Modules are named after their files, and `util.ts` is the tail of
    # `lib/util.ts`. The shorter name's map must leave the longer's alone.
    let map = lineBasedSourceLineMap("a\nb", "// prelude\na\nb", "util.ts", "util.ts")
    check "at f (util.ts:3:1)".rewriteQuickJsLocations(map) == "at f (util.ts:2:1)"
    check "at f (lib/util.ts:3:1)".rewriteQuickJsLocations(map) == "at f (lib/util.ts:3:1)"
    check "at f (myutil.ts:3:1)".rewriteQuickJsLocations(map) == "at f (myutil.ts:3:1)"

  test "a line that only lost its type annotation still anchors":
    # After an erased interface, `export function f(): string {` comes out
    # as `export function f(){`. That line used to match nothing, so the
    # throw under it was reported one line off or not mapped at all.
    let source = "export interface Unused {\n  a: number\n}\nexport function explode(): string {\n  throw new Error(\"boom\")\n}\n"
    let generated = "\nexport function explode(){\n  throw new Error(\"boom\")\n}\n"
    let map = lineBasedSourceLineMap(source, generated, "util.ts", "util.ts")
    check map.mapGeneratedLine(2) == 4
    check map.mapGeneratedLine(3) == 5
    check map.mapGeneratedLine(4) == 6
