import std/[strutils, unittest]

import frameos/js_runtime/source_map

# The line mapper builds a longest-common-subsequence table with one int per
# (generated line x source line) pair, so its memory cost is quadratic in file
# length. A 260-line app app already needed ~550 KB and a 1200-line one ~11 MB,
# which is how a bundled scene exhausted an 8 MB ESP32 — building a source map
# so error messages could name the right line cost more than the render did.
# Past LcsCellBudget the map degrades to line-for-line instead.

suite "source map line budget":
  test "small inputs still map moved lines through the LCS table":
    let source = "alpha\nbeta\ngamma\n"
    let generated = "prelude\nalpha\nbeta\ngamma\n"
    let map = lineBasedSourceLineMap(source, generated, "gen.js", "src.ts")
    # "alpha" moved from source line 1 to generated line 2, and the mapper
    # tracks it — this is the behaviour the budget must not disturb.
    check map.generatedToSourceLine[2] == 1
    check map.generatedToSourceLine[3] == 2
    check map.generatedToSourceLine[4] == 3

  test "oversized inputs fall back to line-for-line instead of allocating":
    # Comfortably past the host budget: the LCS table for this pair would be
    # ~4M cells (~32 MB) if it were built at all.
    let lineCount = 2200
    var lines = newSeq[string](lineCount)
    for i in 0 ..< lineCount:
      lines[i] = "const value" & $i & " = " & $i & ";"
    let text = lines.join("\n")

    let map = lineBasedSourceLineMap(text, text, "gen.js", "src.ts")
    check map.generatedName == "gen.js"
    check map.sourceName == "src.ts"
    check map.generatedToSourceLine.len >= lineCount
    # Identity mapping: the transpiler rewrites lines in place, so line N of
    # the output really is line N of the input for this input.
    check map.generatedToSourceLine[1] == 1
    check map.generatedToSourceLine[lineCount] == lineCount

  test "the budget is tighter on embedded than on hosts":
    # Embedded frames have a few megabytes for a whole render, so they trade
    # exact line attribution away much sooner than a development host does.
    when defined(frameosEmbedded):
      check LcsCellBudget <= 20_000
    else:
      check LcsCellBudget >= 1_000_000
