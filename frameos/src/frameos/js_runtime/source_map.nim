# Line maps for the one piece of generated JavaScript left in FrameOS: the
# envelope a code node's snippet is wrapped in (runtime.nim,
# buildEnvelopeFunctionWithMap). App sources go to QuickJS untouched --
# quickts parses their TypeScript -- so their error locations need no map.
import std/[strutils]

type
  SourceMapSegment* = object
    generatedLine*: int
    generatedColumn*: int
    sourceLine*: int
    sourceColumn*: int

  SourceLineMap* = object
    generatedName*: string
    sourceName*: string
    generatedToSourceLine*: seq[int]
    segments*: seq[SourceMapSegment]

proc sourceLineCount*(source: string): int =
  result = 1
  for ch in source:
    if ch == '\n':
      inc result

proc emptySourceLineMap*(generatedName, sourceName: string, generatedLineCount = 1): SourceLineMap =
  result.generatedName = generatedName
  result.sourceName = sourceName
  result.generatedToSourceLine = newSeq[int](max(1, generatedLineCount) + 1)

proc identitySourceLineMap*(source, generatedName, sourceName: string): SourceLineMap =
  result = emptySourceLineMap(generatedName, sourceName, source.sourceLineCount())
  for line in 1..<result.generatedToSourceLine.len:
    result.generatedToSourceLine[line] = line
    result.segments.add(SourceMapSegment(
      generatedLine: line,
      generatedColumn: 1,
      sourceLine: line,
      sourceColumn: 1
    ))

proc withGeneratedName*(sourceMap: SourceLineMap, generatedName: string): SourceLineMap =
  result = sourceMap
  result.generatedName = generatedName

proc mapGeneratedLine*(sourceMap: SourceLineMap, generatedLine: int): int =
  if generatedLine > 0 and generatedLine < sourceMap.generatedToSourceLine.len:
    sourceMap.generatedToSourceLine[generatedLine]
  else:
    0

proc mapGeneratedPosition*(sourceMap: SourceLineMap, generatedLine, generatedColumn: int): tuple[line: int, column: int] =
  result.line = sourceMap.mapGeneratedLine(generatedLine)
  result.column = if generatedColumn > 0: generatedColumn else: 1

  var best: SourceMapSegment
  var hasBest = false
  for segment in sourceMap.segments:
    if segment.generatedLine == generatedLine and segment.generatedColumn <= result.column:
      if not hasBest or segment.generatedColumn > best.generatedColumn:
        best = segment
        hasBest = true

  if hasBest:
    result.line = best.sourceLine
    result.column = max(1, best.sourceColumn + (result.column - best.generatedColumn))

proc rewriteQuickJsLocations*(text: string, sourceMap: SourceLineMap): string =
  if text.len == 0 or sourceMap.generatedName.len == 0:
    return text

  var i = 0
  while i < text.len:
    let at = text.find(sourceMap.generatedName & ":", i)
    if at < 0:
      result.add(text[i..^1])
      break

    # Module names are file names now, so `util.ts:` must not match inside
    # `lib/util.ts:` — the shorter name's map would rewrite the longer's lines.
    if at > 0 and text[at - 1] in {'/', '.', '-', '_', 'a'..'z', 'A'..'Z', '0'..'9'}:
      result.add(text[i..at])
      i = at + 1
      continue

    result.add(text[i..<at])
    var lineStart = at + sourceMap.generatedName.len + 1
    var lineEnd = lineStart
    while lineEnd < text.len and text[lineEnd] in {'0'..'9'}:
      inc lineEnd

    if lineEnd == lineStart:
      result.add(sourceMap.generatedName)
      result.add(":")
      i = lineStart
      continue

    let generatedLine = parseInt(text[lineStart..<lineEnd])
    var columnStart = lineEnd
    var columnEnd = columnStart
    var hasColumn = false
    if columnStart < text.len and text[columnStart] == ':':
      inc columnStart
      columnEnd = columnStart
      while columnEnd < text.len and text[columnEnd] in {'0'..'9'}:
        inc columnEnd
      hasColumn = columnEnd > columnStart

    let generatedColumn =
      if hasColumn: parseInt(text[columnStart..<columnEnd])
      else: 1
    let mapped = sourceMap.mapGeneratedPosition(generatedLine, generatedColumn)
    if mapped.line > 0:
      result.add(sourceMap.sourceName)
      result.add(":")
      result.add($mapped.line)
      if hasColumn:
        result.add(":")
        result.add($mapped.column)
    else:
      result.add(text[at..<(if hasColumn: columnEnd else: lineEnd)])
    i = if hasColumn: columnEnd else: lineEnd
