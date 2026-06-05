import std/[sequtils, strutils]

type
  SourceLineMap* = object
    generatedName*: string
    sourceName*: string
    generatedToSourceLine*: seq[int]

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

proc normalizedLine(line: string): string =
  line.strip()

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

proc withGeneratedName*(sourceMap: SourceLineMap, generatedName: string): SourceLineMap =
  result = sourceMap
  result.generatedName = generatedName

proc mapGeneratedLine*(sourceMap: SourceLineMap, generatedLine: int): int =
  if generatedLine > 0 and generatedLine < sourceMap.generatedToSourceLine.len:
    sourceMap.generatedToSourceLine[generatedLine]
  else:
    0

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
    let sourceLine = sourceMap.mapGeneratedLine(generatedLine)
    if sourceLine > 0:
      result.add(sourceMap.sourceName)
      result.add(":")
      result.add($sourceLine)
    else:
      result.add(text[at..<lineEnd])
    i = lineEnd
