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

proc normalizedLine(line: string): string =
  line.strip()

proc firstNonSpaceColumn(line: string): int =
  for index, ch in line:
    if ch notin {' ', '\t'}:
      return index + 1
  1

proc addLineSegments(result: var SourceLineMap, generatedLine: int, generatedText: string, sourceLine: int, sourceText: string) =
  if sourceLine <= 0:
    return

  result.segments.add(SourceMapSegment(
    generatedLine: generatedLine,
    generatedColumn: 1,
    sourceLine: sourceLine,
    sourceColumn: 1
  ))

  let generatedTrim = firstNonSpaceColumn(generatedText)
  let sourceTrim = firstNonSpaceColumn(sourceText)
  if generatedTrim != 1 or sourceTrim != 1:
    result.segments.add(SourceMapSegment(
      generatedLine: generatedLine,
      generatedColumn: generatedTrim,
      sourceLine: sourceLine,
      sourceColumn: sourceTrim
    ))

  # There used to be a third kind of segment here: one per character of the
  # line, produced by walking the source text until it found the same
  # character. That is one segment per byte of the file — ~36,000 of them,
  # about 1 MB, for the 36 KB app in the bundled Weather scene, retained for
  # as long as the app is loaded and scanned linearly on every error lookup.
  # It was also not really a column map: after type-stripping, "advance until
  # the characters match" aligns on whichever punctuation happens to come
  # first, so it bought an expensive guess. Line start and first non-space
  # cover what an error message actually needs.

# Maps generated lines back to source lines with a single forward scan.
#
# This used to build a full longest-common-subsequence table: one int per
# (generated line x source line) pair, quadratic in file length. A 367-line
# app needed a 135,056-cell table, a 965-line one 932,190 cells (~11 MB of
# per-row seqs on the device), and building it is how the bundled Weather
# scene exhausted an 8 MB ESP32 — not the canvas, not the images, but a
# source map so that error messages could name the right line.
#
# The table earned nothing. Measured on both apps in that scene, the map it
# produced was identity on every single line; the one line that differed was
# the `exports.get = get;` epilogue the imports transform appends, which has
# no source line at all. That is inherent, not luck: the transpiler strips
# types in place and appends an epilogue, so lines stay put. The scan below
# tracks the insertions and deletions that do occur by looking a bounded
# distance ahead, which is what the table was being asked for.
const LineLookahead = 64

proc lineBasedSourceLineMap*(source, generated, generatedName, sourceName: string): SourceLineMap =
  let sourceLines = source.splitLines()
  let generatedLines = generated.splitLines()
  var normalizedSource = newSeq[string](sourceLines.len)
  for i, line in sourceLines:
    normalizedSource[i] = normalizedLine(line)

  result = emptySourceLineMap(generatedName, sourceName, generated.sourceLineCount())
  # Lines matched in the scan already have their segments; the interpolation
  # pass below must not add a second copy of each (it used to, doubling the
  # segment list for every file).
  var segmented = newSeq[bool](result.generatedToSourceLine.len)
  var
    generatedIndex = 0
    sourceIndex = 0
    lastGeneratedLine = 0
    lastSourceLine = 0

  while generatedIndex < generatedLines.len and sourceIndex < sourceLines.len:
    let generatedNorm = normalizedLine(generatedLines[generatedIndex])
    if generatedNorm == normalizedSource[sourceIndex]:
      result.generatedToSourceLine[generatedIndex + 1] = sourceIndex + 1
      result.addLineSegments(generatedIndex + 1, generatedLines[generatedIndex],
                             sourceIndex + 1, sourceLines[sourceIndex])
      if generatedIndex + 1 < segmented.len: segmented[generatedIndex + 1] = true
      lastGeneratedLine = generatedIndex + 1
      lastSourceLine = sourceIndex + 1
      inc generatedIndex
      inc sourceIndex
      continue

    # Lines diverged. Look ahead a bounded distance on each side: a match
    # found ahead in the source means lines were dropped (a stripped type),
    # a match ahead in the generated code means lines were inserted.
    var sourceAhead = -1
    var limit = min(sourceLines.len, sourceIndex + 1 + LineLookahead)
    for candidate in sourceIndex + 1 ..< limit:
      if normalizedSource[candidate] == generatedNorm:
        sourceAhead = candidate
        break

    var generatedAhead = -1
    limit = min(generatedLines.len, generatedIndex + 1 + LineLookahead)
    for candidate in generatedIndex + 1 ..< limit:
      if normalizedLine(generatedLines[candidate]) == normalizedSource[sourceIndex]:
        generatedAhead = candidate
        break

    if sourceAhead >= 0 and (generatedAhead < 0 or
        sourceAhead - sourceIndex <= generatedAhead - generatedIndex):
      sourceIndex = sourceAhead
    elif generatedAhead >= 0:
      generatedIndex = generatedAhead
    else:
      # No anchor nearby: the two files genuinely disagree here, so advance
      # both and let the interpolation below cover the gap.
      inc generatedIndex
      inc sourceIndex

  for line in 1..<result.generatedToSourceLine.len:
    if result.generatedToSourceLine[line] == 0:
      if lastGeneratedLine > 0:
        let estimated = lastSourceLine + (line - lastGeneratedLine)
        if estimated >= 1 and estimated <= max(1, sourceLines.len):
          result.generatedToSourceLine[line] = estimated
      elif line <= sourceLines.len:
        result.generatedToSourceLine[line] = line
    if not segmented[line] and result.generatedToSourceLine[line] > 0 and
       line <= generatedLines.len and
       result.generatedToSourceLine[line] <= sourceLines.len:
      result.addLineSegments(line, generatedLines[line - 1],
                             result.generatedToSourceLine[line],
                             sourceLines[result.generatedToSourceLine[line] - 1])

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

proc composeSourceLineMaps*(outer, inner: SourceLineMap): SourceLineMap =
  result = emptySourceLineMap(
    outer.generatedName,
    if inner.sourceName.len > 0: inner.sourceName else: outer.sourceName,
    max(0, outer.generatedToSourceLine.len - 1)
  )
  for line in 1..<outer.generatedToSourceLine.len:
    let intermediateLine = outer.generatedToSourceLine[line]
    if intermediateLine > 0 and intermediateLine < inner.generatedToSourceLine.len:
      result.generatedToSourceLine[line] = inner.generatedToSourceLine[intermediateLine]
  for segment in outer.segments:
    let mapped = inner.mapGeneratedPosition(segment.sourceLine, segment.sourceColumn)
    if mapped.line > 0:
      result.segments.add(SourceMapSegment(
        generatedLine: segment.generatedLine,
        generatedColumn: segment.generatedColumn,
        sourceLine: mapped.line,
        sourceColumn: mapped.column
      ))

proc addSourceSegment*(sourceMap: var SourceLineMap, generatedLine, generatedColumn, sourceLine, sourceColumn: int) =
  if generatedLine <= 0 or generatedColumn <= 0 or sourceLine <= 0 or sourceColumn <= 0:
    return
  sourceMap.segments.add(SourceMapSegment(
    generatedLine: generatedLine,
    generatedColumn: generatedColumn,
    sourceLine: sourceLine,
    sourceColumn: sourceColumn
  ))

proc rewriteQuickJsLocations*(text: string, sourceMap: SourceLineMap): string =
  if text.len == 0 or sourceMap.generatedName.len == 0:
    return text

  var i = 0
  while i < text.len:
    let at = text.find(sourceMap.generatedName & ":", i)
    if at < 0:
      result.add(text[i..^1])
      break

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
