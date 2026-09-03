import std/[unittest]

import frameos/js_runtime/source_map

# App sources go to QuickJS untouched (quickts parses the TypeScript), so the
# only generated JavaScript left is the envelope around a code node's snippet
# and the only maps are the small ones runtime.nim builds for those. These
# pin the lookup and rewrite behaviour they rely on.

suite "source map line mapping":
  test "identity map returns the same line and column":
    let map = identitySourceLineMap("a\nb\nc", "gen.js", "src.ts")
    check map.mapGeneratedLine(2) == 2
    check map.mapGeneratedPosition(3, 7) == (line: 3, column: 7)
    check map.mapGeneratedLine(9) == 0

  test "segments shift columns within a line":
    var map = emptySourceLineMap("gen.js", "src.ts", 3)
    map.generatedToSourceLine[2] = 1
    map.segments.add(SourceMapSegment(generatedLine: 2, generatedColumn: 40, sourceLine: 1, sourceColumn: 1))
    check map.mapGeneratedPosition(2, 45) == (line: 1, column: 6)
    check map.mapGeneratedPosition(2, 3) == (line: 1, column: 3)

  test "rewrites file:line:column locations in error text":
    var map = emptySourceLineMap("<frameos:code:7>", "<frameos:code:7>", 4)
    map.generatedToSourceLine[3] = 1
    map.segments.add(SourceMapSegment(generatedLine: 3, generatedColumn: 40, sourceLine: 1, sourceColumn: 1))
    check "at <frameos:code:7>:3:42".rewriteQuickJsLocations(map) == "at <frameos:code:7>:1:3"
    check "at <frameos:code:7>:3".rewriteQuickJsLocations(map) == "at <frameos:code:7>:1"
    # a line the map does not cover is left alone
    check "at <frameos:code:7>:9:1".rewriteQuickJsLocations(map) == "at <frameos:code:7>:9:1"

  test "a file name only matches at a path boundary":
    # Modules are named after their files, and `util.ts` is the tail of
    # `lib/util.ts`. The shorter name's map must leave the longer's alone.
    var map = emptySourceLineMap("util.ts", "util.ts", 3)
    map.generatedToSourceLine[3] = 2
    check "at f (util.ts:3:1)".rewriteQuickJsLocations(map) == "at f (util.ts:2:1)"
    check "at f (lib/util.ts:3:1)".rewriteQuickJsLocations(map) == "at f (lib/util.ts:3:1)"
    check "at f (myutil.ts:3:1)".rewriteQuickJsLocations(map) == "at f (myutil.ts:3:1)"
