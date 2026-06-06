import std/[sequtils, strutils]

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

  var sourcePos = 0
  for generatedPos, ch in generatedText:
    while sourcePos < sourceText.len and sourceText[sourcePos] != ch:
      inc sourcePos
    if sourcePos < sourceText.len:
      result.segments.add(SourceMapSegment(
        generatedLine: generatedLine,
        generatedColumn: generatedPos + 1,
        sourceLine: sourceLine,
        sourceColumn: sourcePos + 1
      ))
      inc sourcePos

proc lineBasedSourceLineMap*(source, generated, generatedName, sourceName: string): SourceLineMap =
  let sourceLines = source.splitLines()
  let generatedLines = generated.splitLines()
  var lcs = newSeqWith(generatedLines.len + 1, newSeq[int](sourceLines.len + 1))

  for generatedIndex in countdown(generatedLines.len - 1, 0):
    for sourceIndex in countdown(sourceLines.len - 1, 0):
      if normalizedLine(generatedLines[generatedIndex]) == normalizedLine(sourceLines[sourceIndex]):
        lcs[generatedIndex][sourceIndex] = lcs[generatedIndex + 1][sourceIndex + 1] + 1
      else:
        lcs[generatedIndex][sourceIndex] = max(lcs[generatedIndex + 1][sourceIndex], lcs[generatedIndex][sourceIndex + 1])

  result = emptySourceLineMap(generatedName, sourceName, generated.sourceLineCount())
  var generatedIndex = 0
  var sourceIndex = 0
  var lastGeneratedLine = 0
  var lastSourceLine = 0

  while generatedIndex < generatedLines.len and sourceIndex < sourceLines.len:
    if normalizedLine(generatedLines[generatedIndex]) == normalizedLine(sourceLines[sourceIndex]):
      result.generatedToSourceLine[generatedIndex + 1] = sourceIndex + 1
      result.addLineSegments(generatedIndex + 1, generatedLines[generatedIndex], sourceIndex + 1, sourceLines[sourceIndex])
      lastGeneratedLine = generatedIndex + 1
      lastSourceLine = sourceIndex + 1
      inc generatedIndex
      inc sourceIndex
    elif lcs[generatedIndex + 1][sourceIndex] >= lcs[generatedIndex][sourceIndex + 1]:
      inc generatedIndex
    else:
      inc sourceIndex

  for line in 1..<result.generatedToSourceLine.len:
    if result.generatedToSourceLine[line] == 0:
      if lastGeneratedLine > 0:
        let estimated = lastSourceLine + (line - lastGeneratedLine)
        if estimated >= 1 and estimated <= max(1, sourceLines.len):
          result.generatedToSourceLine[line] = estimated
      elif line <= sourceLines.len:
        result.generatedToSourceLine[line] = line
    if result.generatedToSourceLine[line] > 0 and line <= generatedLines.len and result.generatedToSourceLine[line] <= sourceLines.len:
      result.addLineSegments(line, generatedLines[line - 1], result.generatedToSourceLine[line], sourceLines[result.generatedToSourceLine[line] - 1])

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
