# TokenProcessor-style rewrite stream for the native FrameOS JS transpiler.
# It preserves original whitespace/comments between tokens and records
# token-index to output-position mappings for future diagnostics/source maps.

import std/sequtils

import ./tokens

type
  TokenProcessorSnapshot* = object
    resultCode*: string
    tokenIndex*: int

  TokenProcessorResult* = object
    code*: string
    mappings*: seq[int]

  TokenProcessor* = object
    code*: string
    tokens*: seq[JsToken]
    resultCode*: string
    resultMappings*: seq[int]
    tokenIndex*: int

proc initTokenProcessor*(code: string, tokens: seq[JsToken]): TokenProcessor =
  TokenProcessor(
    code: code,
    tokens: tokens,
    resultMappings: newSeqWith(tokens.len, -1),
  )

proc isAtEnd*(processor: TokenProcessor): bool =
  processor.tokenIndex >= processor.tokens.len

proc currentIndex*(processor: TokenProcessor): int =
  processor.tokenIndex

proc currentToken*(processor: TokenProcessor): JsToken =
  if processor.isAtEnd():
    raise newException(ValueError, "Unexpectedly reached end of input.")
  processor.tokens[processor.tokenIndex]

proc tokenAtRelativeIndex*(processor: TokenProcessor, relativeIndex: int): JsToken =
  let index = processor.tokenIndex + relativeIndex
  if index < 0 or index >= processor.tokens.len:
    raise newException(ValueError, "Token lookaround out of bounds.")
  processor.tokens[index]

proc rawCodeForToken*(processor: TokenProcessor, token: JsToken): string =
  if token.start >= 0 and token.`end` <= processor.code.len and token.start <= token.`end`:
    processor.code[token.start..<token.`end`]
  else:
    ""

proc currentTokenCode*(processor: TokenProcessor): string =
  processor.rawCodeForToken(processor.currentToken())

proc identifierNameForToken*(processor: TokenProcessor, token: JsToken): string =
  processor.rawCodeForToken(token)

proc identifierName*(processor: TokenProcessor): string =
  processor.identifierNameForToken(processor.currentToken())

proc identifierNameAtIndex*(processor: TokenProcessor, index: int): string =
  processor.identifierNameForToken(processor.tokens[index])

proc stringValueForToken*(processor: TokenProcessor, token: JsToken): string =
  let raw = processor.rawCodeForToken(token)
  if raw.len >= 2:
    raw[1..^2]
  else:
    ""

proc stringValue*(processor: TokenProcessor): string =
  processor.stringValueForToken(processor.currentToken())

proc matches1AtIndex*(processor: TokenProcessor, index: int, t1: TokenType): bool =
  index >= 0 and index < processor.tokens.len and processor.tokens[index].typ == t1

proc matches2AtIndex*(processor: TokenProcessor, index: int, t1, t2: TokenType): bool =
  processor.matches1AtIndex(index, t1) and processor.matches1AtIndex(index + 1, t2)

proc matches3AtIndex*(processor: TokenProcessor, index: int, t1, t2, t3: TokenType): bool =
  processor.matches2AtIndex(index, t1, t2) and processor.matches1AtIndex(index + 2, t3)

proc matches1*(processor: TokenProcessor, t1: TokenType): bool =
  processor.matches1AtIndex(processor.tokenIndex, t1)

proc matches2*(processor: TokenProcessor, t1, t2: TokenType): bool =
  processor.matches2AtIndex(processor.tokenIndex, t1, t2)

proc matches3*(processor: TokenProcessor, t1, t2, t3: TokenType): bool =
  processor.matches3AtIndex(processor.tokenIndex, t1, t2, t3)

proc matchesContextualAtIndex*(processor: TokenProcessor, index: int, keyword: ContextualKeyword): bool =
  processor.matches1AtIndex(index, ttName) and processor.tokens[index].contextualKeyword == keyword

proc matchesContextual*(processor: TokenProcessor, keyword: ContextualKeyword): bool =
  processor.matchesContextualAtIndex(processor.tokenIndex, keyword)

proc matchesContextIdAndLabel*(processor: TokenProcessor, typ: TokenType, contextId: int): bool =
  processor.matches1(typ) and processor.currentToken().contextId == contextId

proc previousWhitespaceAndComments*(processor: TokenProcessor): string =
  let start =
    if processor.tokenIndex > 0: processor.tokens[processor.tokenIndex - 1].`end`
    else: 0
  let finish =
    if processor.tokenIndex < processor.tokens.len: processor.tokens[processor.tokenIndex].start
    else: processor.code.len
  if start >= 0 and finish >= start and finish <= processor.code.len:
    processor.code[start..<finish]
  else:
    ""

proc snapshot*(processor: TokenProcessor): TokenProcessorSnapshot =
  TokenProcessorSnapshot(resultCode: processor.resultCode, tokenIndex: processor.tokenIndex)

proc restoreToSnapshot*(processor: var TokenProcessor, snapshot: TokenProcessorSnapshot) =
  processor.resultCode = snapshot.resultCode
  processor.tokenIndex = snapshot.tokenIndex

proc dangerouslyGetAndRemoveCodeSinceSnapshot*(processor: var TokenProcessor, snapshot: TokenProcessorSnapshot): string =
  result = processor.resultCode[snapshot.resultCode.len..^1]
  processor.resultCode = snapshot.resultCode

proc appendTokenPrefix(processor: var TokenProcessor) =
  discard

proc appendTokenSuffix(processor: var TokenProcessor) =
  discard

proc replaceToken*(processor: var TokenProcessor, newCode: string) =
  if processor.isAtEnd():
    raise newException(ValueError, "Cannot replace token at end of input.")
  processor.resultCode.add(processor.previousWhitespaceAndComments())
  processor.appendTokenPrefix()
  processor.resultMappings[processor.tokenIndex] = processor.resultCode.len
  processor.resultCode.add(newCode)
  processor.appendTokenSuffix()
  inc processor.tokenIndex

proc replaceTokenTrimmingLeftWhitespace*(processor: var TokenProcessor, newCode: string) =
  let whitespace = processor.previousWhitespaceAndComments()
  for ch in whitespace:
    if ch in {'\n', '\r'}:
      processor.resultCode.add(ch)
  processor.appendTokenPrefix()
  processor.resultMappings[processor.tokenIndex] = processor.resultCode.len
  processor.resultCode.add(newCode)
  processor.appendTokenSuffix()
  inc processor.tokenIndex

proc removeInitialToken*(processor: var TokenProcessor) =
  processor.replaceToken("")

proc removeToken*(processor: var TokenProcessor) =
  processor.replaceTokenTrimmingLeftWhitespace("")

proc copyToken*(processor: var TokenProcessor) =
  if processor.isAtEnd():
    raise newException(ValueError, "Cannot copy token at end of input.")
  processor.resultCode.add(processor.previousWhitespaceAndComments())
  processor.appendTokenPrefix()
  processor.resultMappings[processor.tokenIndex] = processor.resultCode.len
  processor.resultCode.add(processor.rawCodeForToken(processor.currentToken()))
  processor.appendTokenSuffix()
  inc processor.tokenIndex

proc copyTokenWithPrefix*(processor: var TokenProcessor, prefix: string) =
  if processor.isAtEnd():
    raise newException(ValueError, "Cannot copy token at end of input.")
  processor.resultCode.add(processor.previousWhitespaceAndComments())
  processor.appendTokenPrefix()
  processor.resultCode.add(prefix)
  processor.resultMappings[processor.tokenIndex] = processor.resultCode.len
  processor.resultCode.add(processor.rawCodeForToken(processor.currentToken()))
  processor.appendTokenSuffix()
  inc processor.tokenIndex

proc copyExpectedToken*(processor: var TokenProcessor, tokenType: TokenType) =
  if not processor.matches1(tokenType):
    raise newException(ValueError, "Expected token " & formatTokenType(tokenType))
  processor.copyToken()

proc appendCode*(processor: var TokenProcessor, code: string) =
  processor.resultCode.add(code)

proc nextToken*(processor: var TokenProcessor) =
  if processor.isAtEnd():
    raise newException(ValueError, "Unexpectedly reached end of input.")
  inc processor.tokenIndex

proc previousToken*(processor: var TokenProcessor) =
  if processor.tokenIndex > 0:
    dec processor.tokenIndex

proc removeBalancedCode*(processor: var TokenProcessor) =
  var braceDepth = 0
  while not processor.isAtEnd():
    if processor.matches1(ttBraceL):
      inc braceDepth
    elif processor.matches1(ttBraceR):
      if braceDepth == 0:
        return
      dec braceDepth
    processor.removeToken()

proc finish*(processor: var TokenProcessor): TokenProcessorResult =
  if processor.tokenIndex != processor.tokens.len:
    raise newException(ValueError, "Tried to finish processing tokens before reaching the end.")
  processor.resultCode.add(processor.previousWhitespaceAndComments())
  TokenProcessorResult(code: processor.resultCode, mappings: processor.resultMappings)

proc copyAll*(processor: var TokenProcessor): TokenProcessorResult =
  while not processor.isAtEnd():
    processor.copyToken()
  processor.finish()
