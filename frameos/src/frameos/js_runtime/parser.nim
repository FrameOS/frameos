# Lightweight Sucrase-style parser/traverser annotations for the native
# FrameOS JS transpiler. This module consumes the raw tokenizer stream and
# annotates token roles used by token-driven transformers.

import std/strutils

import ./tokens

type
  ParsedFile* = object
    tokens*: seq[JsToken]
    scopes*: seq[Scope]

proc raw(code: string, token: JsToken): string =
  if token.start >= 0 and token.`end` <= code.len and token.start <= token.`end`:
    code[token.start..<token.`end`]
  else:
    ""

proc nextNonEof(tokens: seq[JsToken], i: int): int =
  result = i + 1
  while result < tokens.len and tokens[result].typ == ttEof:
    inc result

proc findMatching(tokens: seq[JsToken], openIndex: int, openType, closeType: TokenType): int =
  var depth = 0
  for i in openIndex..<tokens.len:
    # `${` opens a brace context closed by a plain `}` token.
    if tokens[i].typ == openType or (openType == ttBraceL and tokens[i].typ == ttDollarBraceL):
      inc depth
    elif tokens[i].typ == closeType:
      dec depth
      if depth == 0:
        return i
  -1

proc findStatementEnd(tokens: seq[JsToken], start: int): int =
  var parenDepth = 0
  var braceDepth = 0
  var bracketDepth = 0
  for i in start..<tokens.len:
    case tokens[i].typ
    of ttParenL: inc parenDepth
    of ttParenR:
      if parenDepth > 0: dec parenDepth
    of ttBraceL, ttDollarBraceL: inc braceDepth
    of ttBraceR:
      if braceDepth == 0 and parenDepth == 0 and bracketDepth == 0:
        return i
      if braceDepth > 0: dec braceDepth
    of ttBracketL: inc bracketDepth
    of ttBracketR:
      if bracketDepth > 0: dec bracketDepth
    of ttSemi:
      if parenDepth == 0 and braceDepth == 0 and bracketDepth == 0:
        return i
    of ttEof:
      return i
    else:
      discard
  max(0, tokens.len - 1)

proc isTypeBoundary(typ: TokenType): bool =
  typ in {ttComma, ttSemi, ttEq, ttBraceR, ttParenR, ttBracketR, ttArrow, ttEof}

proc markRangeType(tokens: var seq[JsToken], first, lastInclusive: int) =
  if first < 0 or lastInclusive < first:
    return
  for i in first..min(lastInclusive, tokens.len - 1):
    tokens[i].isType = true

proc prevTokenIndex(tokens: seq[JsToken], index: int): int =
  result = index - 1
  while result >= 0 and tokens[result].typ == ttEof:
    dec result

proc roleForDeclaration(scopeDepth: int, functionScoped: bool): IdentifierRole =
  if scopeDepth == 0:
    irTopLevelDeclaration
  elif functionScoped:
    irFunctionScopedDeclaration
  else:
    irBlockScopedDeclaration

proc annotateScopes(tokens: var seq[JsToken]): seq[Scope] =
  var scopeDepth = 0
  var stack: seq[tuple[index: int, isFunction: bool]] = @[]
  var nextContextId = 1
  var pendingFunctionBrace = false

  for i in 0..<tokens.len:
    tokens[i].scopeDepth = scopeDepth

    case tokens[i].typ
    of ttFunction, ttArrow:
      pendingFunctionBrace = true
    of ttClass:
      tokens[i].contextId = nextContextId
      inc nextContextId
    of ttBraceL:
      tokens[i].contextId = nextContextId
      inc nextContextId
      stack.add((i, pendingFunctionBrace))
      pendingFunctionBrace = false
      inc scopeDepth
    of ttDollarBraceL:
      # Template interpolation opens a brace context closed by a plain `}`;
      # track it so that `}` does not pop an enclosing scope.
      tokens[i].contextId = nextContextId
      inc nextContextId
      stack.add((i, false))
      inc scopeDepth
    of ttBraceR:
      if scopeDepth > 0:
        dec scopeDepth
      tokens[i].scopeDepth = scopeDepth
      if stack.len > 0:
        let opened = stack.pop()
        tokens[i].contextId = tokens[opened.index].contextId
        result.add(Scope(
          startTokenIndex: opened.index,
          endTokenIndex: i,
          isFunctionScope: opened.isFunction,
        ))
    else:
      discard

  result.add(Scope(startTokenIndex: 0, endTokenIndex: max(0, tokens.len - 1), isFunctionScope: true))

proc markBindingList(tokens: var seq[JsToken], start, stop: int, role: IdentifierRole) =
  var i = start
  var expectingBinding = true
  var depth = 0
  while i <= stop and i < tokens.len:
    case tokens[i].typ
    of ttBraceL, ttBracketL, ttParenL, ttDollarBraceL:
      inc depth
    of ttBraceR, ttBracketR, ttParenR:
      if depth > 0: dec depth
    of ttComma:
      if depth == 0:
        expectingBinding = true
    of ttName:
      if expectingBinding:
        tokens[i].identifierRole = role
        expectingBinding = false
    of ttEq:
      expectingBinding = false
    else:
      discard
    inc i

proc annotateVarDeclarations(tokens: var seq[JsToken]) =
  var i = 0
  while i < tokens.len:
    if tokens[i].typ in {ttConst, ttLet, ttVar}:
      let role = roleForDeclaration(tokens[i].scopeDepth, tokens[i].typ == ttVar)
      var j = i + 1
      var expectingBinding = true
      var depth = 0
      while j < tokens.len:
        case tokens[j].typ
        of ttSemi, ttEof:
          break
        of ttBraceL, ttBracketL, ttParenL, ttDollarBraceL:
          inc depth
        of ttBraceR, ttBracketR, ttParenR:
          if depth == 0 and tokens[j].typ == ttParenR:
            break
          if depth > 0: dec depth
        of ttComma:
          if depth == 0:
            expectingBinding = true
        of ttEq:
          expectingBinding = false
        of ttName:
          if expectingBinding:
            tokens[j].identifierRole = role
            expectingBinding = false
        else:
          discard
        inc j
      i = j
    inc i

proc annotateFunctionAndClassDeclarations(tokens: var seq[JsToken]) =
  for i in 0..<tokens.len:
    if tokens[i].typ == ttFunction:
      var nameIndex = i + 1
      while nameIndex < tokens.len and tokens[nameIndex].typ in {ttStar, ttAsync}:
        inc nameIndex
      if nameIndex < tokens.len and tokens[nameIndex].typ == ttName:
        tokens[nameIndex].identifierRole = roleForDeclaration(tokens[i].scopeDepth, true)
      var paren = nameIndex
      while paren < tokens.len and tokens[paren].typ != ttParenL and tokens[paren].typ != ttEof:
        inc paren
      if paren < tokens.len and tokens[paren].typ == ttParenL:
        let close = findMatching(tokens, paren, ttParenL, ttParenR)
        if close >= 0:
          markBindingList(tokens, paren + 1, close - 1, irFunctionScopedDeclaration)

    if tokens[i].typ == ttClass:
      let nameIndex = i + 1
      if nameIndex < tokens.len and tokens[nameIndex].typ == ttName:
        tokens[nameIndex].identifierRole = roleForDeclaration(tokens[i].scopeDepth, false)

proc annotateImportsExports(code: string, tokens: var seq[JsToken]) =
  var i = 0
  while i < tokens.len:
    if tokens[i].typ == ttImport:
      let stmtEnd = findStatementEnd(tokens, i)
      var j = i + 1
      if j < tokens.len and tokens[j].typ == ttType:
        markRangeType(tokens, i, stmtEnd)
      elif j < tokens.len and tokens[j].typ != ttParenL and tokens[j].typ != ttDot and tokens[j].typ != ttString:
        if tokens[j].typ == ttName:
          tokens[j].identifierRole = irImportDeclaration
          inc j
        if j < tokens.len and tokens[j].typ == ttComma:
          inc j
        if j < tokens.len and tokens[j].typ == ttStar:
          if j + 2 < tokens.len and tokens[j + 1].typ == ttAs and tokens[j + 2].typ == ttName:
            tokens[j + 2].identifierRole = irImportDeclaration
        elif j < tokens.len and tokens[j].typ == ttBraceL:
          let close = findMatching(tokens, j, ttBraceL, ttBraceR)
          var k = j + 1
          while k >= 0 and close >= 0 and k < close:
            if tokens[k].typ == ttName or tokens[k].typ == ttType:
              if k + 1 < close and tokens[k + 1].typ == ttAs:
                tokens[k].identifierRole = irImportAccess
                if k + 2 < close and tokens[k + 2].typ == ttName:
                  tokens[k + 2].identifierRole = irImportDeclaration
                  k += 2
              elif k > j + 1 and tokens[k - 1].typ == ttAs:
                tokens[k].identifierRole = irImportDeclaration
              else:
                tokens[k].identifierRole = irImportDeclaration
            inc k
      i = stmtEnd

    elif tokens[i].typ == ttExport:
      let stmtEnd = findStatementEnd(tokens, i)
      tokens[i].rhsEndIndex = stmtEnd
      var j = i + 1
      if j < tokens.len and tokens[j].typ == ttType:
        markRangeType(tokens, i, stmtEnd)
      elif j < tokens.len and tokens[j].typ == ttBraceL:
        let close = findMatching(tokens, j, ttBraceL, ttBraceR)
        var k = j + 1
        while k >= 0 and close >= 0 and k < close:
          if tokens[k].typ == ttName or tokens[k].typ == ttType:
            if k == j + 1 or tokens[k - 1].typ in {ttComma, ttBraceL}:
              tokens[k].identifierRole = irExportAccess
          inc k
      elif j < tokens.len and tokens[j].typ in {ttConst, ttLet, ttVar, ttFunction, ttClass, ttEnum}:
        discard
      i = stmtEnd
    inc i

proc annotateObjectKeys(code: string, tokens: var seq[JsToken]) =
  for i in 0..<tokens.len:
    if tokens[i].typ in {ttName, ttString, ttNum, ttBigint, ttDecimal, ttType, ttAs}:
      let next = nextNonEof(tokens, i)
      if next < tokens.len and tokens[next].typ == ttColon and tokens[i].identifierRole == irNone:
        tokens[i].identifierRole = irObjectKey

proc inImportExportStatement(tokens: seq[JsToken], index: int): bool =
  var i = index
  while i >= 0 and tokens[i].typ notin {ttSemi, ttEof}:
    if tokens[i].typ in {ttImport, ttExport}:
      return true
    dec i
  false

proc isPropertyAccessName(tokens: seq[JsToken], index: int): bool =
  let prev = prevTokenIndex(tokens, index)
  prev >= 0 and tokens[prev].typ in {ttDot, ttQuestionDot}

proc isLikelyTernaryColon(tokens: seq[JsToken], index: int): bool =
  var depth = 0
  var i = index - 1
  while i >= 0:
    case tokens[i].typ
    of ttParenR, ttBraceR, ttBracketR:
      inc depth
    of ttParenL, ttBraceL, ttBracketL, ttDollarBraceL:
      if depth == 0:
        return false
      dec depth
    of ttQuestion:
      if depth == 0:
        return i != index - 1
    of ttComma, ttSemi:
      if depth == 0:
        return false
    else:
      discard
    dec i
  false

proc annotateTypeSpans(code: string, tokens: var seq[JsToken]) =
  var i = 0
  while i < tokens.len:
    if tokens[i].typ == ttType:
      var j = i + 1
      if j < tokens.len and tokens[j].typ == ttName:
        while j < tokens.len and tokens[j].typ != ttEq and tokens[j].typ != ttEof:
          inc j
        if j < tokens.len and tokens[j].typ == ttEq:
          let endIndex = findStatementEnd(tokens, i)
          markRangeType(tokens, i, endIndex)
          i = endIndex

    if tokens[i].typ == ttName and tokens[i].contextualKeyword == ckInterface:
      let endIndex =
        block:
          var brace = i
          while brace < tokens.len and tokens[brace].typ != ttBraceL and tokens[brace].typ != ttEof:
            inc brace
          if brace < tokens.len and tokens[brace].typ == ttBraceL:
            let close = findMatching(tokens, brace, ttBraceL, ttBraceR)
            if close >= 0: close else: findStatementEnd(tokens, i)
          else:
            findStatementEnd(tokens, i)
      markRangeType(tokens, i, endIndex)
      i = endIndex

    if tokens[i].typ == ttColon and not isLikelyTernaryColon(tokens, i):
      let prev = prevTokenIndex(tokens, i)
      if prev >= 0 and tokens[prev].identifierRole != irObjectKey:
        var j = i + 1
        var depth = 0
        while j < tokens.len:
          if tokens[j].typ in {ttLessThan, ttBraceL, ttBracketL, ttParenL}:
            inc depth
          elif tokens[j].typ in {ttGreaterThan, ttBraceR, ttBracketR, ttParenR}:
            if depth == 0:
              break
            dec depth
          if depth == 0 and isTypeBoundary(tokens[j].typ):
            break
          inc j
        markRangeType(tokens, i, j - 1)
        i = max(i, j - 1)

    if (tokens[i].typ == ttAs or (tokens[i].typ == ttName and tokens[i].contextualKeyword == ckSatisfies)) and
        not inImportExportStatement(tokens, i) and
        not isPropertyAccessName(tokens, i) and
        tokens[i].identifierRole != irObjectKey:
      var j = i + 1
      while j < tokens.len and not isTypeBoundary(tokens[j].typ):
        inc j
      markRangeType(tokens, i, j - 1)
      i = max(i, j - 1)

    if tokens[i].typ == ttLessThan:
      var prev = i - 1
      while prev >= 0 and tokens[prev].typ == ttEof:
        dec prev
      let close = findMatching(tokens, i, ttLessThan, ttGreaterThan)
      if close > i and prev >= 0 and tokens[prev].typ in {ttName, ttFunction, ttClass, ttParenR}:
        var after = close + 1
        if after < tokens.len and tokens[after].typ in {ttParenL, ttBraceL, ttExtends, ttImplements}:
          markRangeType(tokens, i, close)
          i = close
      elif close > i and close + 1 < tokens.len and tokens[close + 1].typ == ttParenL:
        let parenClose = findMatching(tokens, close + 1, ttParenL, ttParenR)
        if parenClose > close and parenClose + 1 < tokens.len and tokens[parenClose + 1].typ == ttArrow:
          markRangeType(tokens, i, close)
          i = close
    inc i

proc annotateJsxRoles(code: string, tokens: var seq[JsToken]) =
  var stack: seq[tuple[start: int, explicitChildren: int, hasSpread: bool, propSpreadSeen: bool]] = @[]
  var i = 0
  while i < tokens.len:
    if tokens[i].typ == ttJsxTagStart:
      let isClosing = i + 1 < tokens.len and tokens[i + 1].typ == ttSlash
      if isClosing:
        if stack.len > 0:
          let item = stack.pop()
          if tokens[item.start].jsxRole != jsxKeyAfterPropSpread:
            tokens[item.start].jsxRole =
              if item.explicitChildren == 0: jsxNoChildren
              elif item.explicitChildren == 1 and not item.hasSpread: jsxOneChild
              else: jsxStaticChildren
          if stack.len > 0:
            stack[^1].explicitChildren += 1
        inc i
        continue

      var selfClosing = false
      var propSpreadSeen = false
      var keyAfterSpread = false
      var seenTagName = false
      var j = i + 1
      while j < tokens.len and tokens[j].typ != ttJsxTagEnd:
        if tokens[j].typ == ttBraceL and j + 1 < tokens.len and tokens[j + 1].typ == ttEllipsis:
          propSpreadSeen = true
        if tokens[j].typ == ttJsxName:
          if not seenTagName:
            seenTagName = true
          elif j + 1 < tokens.len and tokens[j + 1].typ in {ttEq, ttJsxTagEnd, ttSlash}:
            tokens[j].identifierRole = irObjectKey
        if propSpreadSeen and tokens[j].typ == ttJsxName and raw(code, tokens[j]) == "key":
          keyAfterSpread = true
        if tokens[j].typ == ttSlash:
          selfClosing = true
        inc j

      if keyAfterSpread:
        tokens[i].jsxRole = jsxKeyAfterPropSpread
      elif selfClosing:
        tokens[i].jsxRole = jsxNoChildren
        if stack.len > 0:
          stack[^1].explicitChildren += 1
      else:
        tokens[i].jsxRole = jsxNoChildren
        stack.add((i, 0, false, propSpreadSeen))
      i = j
    elif stack.len > 0:
      if tokens[i].typ == ttJsxText:
        stack[^1].explicitChildren += 1
      elif tokens[i].typ == ttBraceL:
        let next = i + 1
        if next < tokens.len and tokens[next].typ == ttEllipsis:
          stack[^1].hasSpread = true
          stack[^1].explicitChildren += 1
        else:
          let close = findMatching(tokens, i, ttBraceL, ttBraceR)
          if close < 0 or close == i + 1:
            discard
          else:
            stack[^1].explicitChildren += 1
    inc i

proc annotateOptionalAndNullish(tokens: var seq[JsToken]) =
  for i in 0..<tokens.len:
    if tokens[i].typ == ttNullishCoalescing:
      var start = i - 1
      while start > 0 and tokens[start].typ notin {ttComma, ttSemi, ttParenL, ttBraceL, ttDollarBraceL, ttBracketL, ttEq}:
        dec start
      if start < i and tokens[start].typ in {ttComma, ttSemi, ttParenL, ttBraceL, ttDollarBraceL, ttBracketL, ttEq}:
        inc start
      tokens[start].numNullishCoalesceStarts += 1
      var finish = i + 1
      while finish < tokens.len and tokens[finish].typ notin {ttComma, ttSemi, ttParenR, ttBraceR, ttBracketR, ttEof}:
        inc finish
      if finish > i + 1:
        tokens[finish - 1].numNullishCoalesceEnds += 1

    if tokens[i].typ == ttQuestionDot:
      var start = i - 1
      while start > 0 and tokens[start].typ notin {ttComma, ttSemi, ttParenL, ttBraceL, ttDollarBraceL, ttBracketL, ttEq}:
        dec start
      if start < i and tokens[start].typ in {ttComma, ttSemi, ttParenL, ttBraceL, ttDollarBraceL, ttBracketL, ttEq}:
        inc start
      tokens[start].isOptionalChainStart = true
      var finish = i + 1
      while finish < tokens.len and tokens[finish].typ notin {ttComma, ttSemi, ttParenR, ttBraceR, ttBracketR, ttEof}:
        inc finish
      if finish > i + 1:
        tokens[finish - 1].isOptionalChainEnd = true
      tokens[i].subscriptStartIndex = start

proc annotateAccessIdentifiers(tokens: var seq[JsToken]) =
  for i in 0..<tokens.len:
    if tokens[i].typ == ttName and tokens[i].identifierRole == irNone and not tokens[i].isType and
        tokens[i].contextualKeyword == ckNone and not inImportExportStatement(tokens, i):
      tokens[i].identifierRole = irAccess

proc parseJs*(code: string, options = defaultTokenizeOptions()): ParsedFile =
  result.tokens = tokenizeJs(code, options)
  result.scopes = annotateScopes(result.tokens)
  annotateVarDeclarations(result.tokens)
  annotateFunctionAndClassDeclarations(result.tokens)
  annotateImportsExports(code, result.tokens)
  annotateObjectKeys(code, result.tokens)
  annotateTypeSpans(code, result.tokens)
  annotateJsxRoles(code, result.tokens)
  annotateOptionalAndNullish(result.tokens)
  annotateAccessIdentifiers(result.tokens)

proc formatAnnotatedToken*(code: string, token: JsToken): string =
  result = formatToken(code, token)
  var fields: seq[string] = @[]
  if token.scopeDepth != 0:
    fields.add("scope=" & $token.scopeDepth)
  if token.isType:
    fields.add("type")
  if token.identifierRole != irNone:
    fields.add("role=" & formatIdentifierRole(token.identifierRole))
  if token.jsxRole != jsxRoleNone:
    fields.add("jsx=" & formatJSXRole(token.jsxRole))
  if token.contextId >= 0:
    fields.add("ctx=" & $token.contextId)
  if token.rhsEndIndex >= 0:
    fields.add("rhsEnd=" & $token.rhsEndIndex)
  if token.numNullishCoalesceStarts > 0:
    fields.add("nullishStart=" & $token.numNullishCoalesceStarts)
  if token.numNullishCoalesceEnds > 0:
    fields.add("nullishEnd=" & $token.numNullishCoalesceEnds)
  if token.isOptionalChainStart:
    fields.add("optionalStart")
  if token.isOptionalChainEnd:
    fields.add("optionalEnd")
  if fields.len > 0:
    result.add(" [" & fields.join(",") & "]")

proc formatAnnotatedTokens*(code: string, file: ParsedFile): string =
  for token in file.tokens:
    if result.len > 0:
      result.add("\n")
    result.add(formatAnnotatedToken(code, token))
