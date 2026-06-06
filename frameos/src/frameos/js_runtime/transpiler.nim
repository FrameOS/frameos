# Native TypeScript/JSX transpiler for FrameOS.
#
# This module is a Nim reimplementation track for the parts of Sucrase that
# FrameOS needs at runtime. The output is always evaluated by the bundled
# QuickJS runtime, so this intentionally erases TypeScript, lowers JSX to the
# FrameOS classic runtime, rewrites modules for the app wrapper, and preserves
# modern JavaScript syntax that QuickJS already supports.
#
# Sucrase is MIT licensed:
#
#   Copyright (c) 2012-2018 various contributors (see AUTHORS)
#
# Sucrase itself includes a modified fork of Babylon, which was forked from
# Acorn. This file intentionally keeps public naming close to Sucrase concepts
# (`TransformOptions`, `TransformResult`, `transform`) so upstream changes can
# be tracked and ported incrementally. See `js_runtime/README.md`.

import std/[strutils, sequtils]
from std/unicode import Rune, toUTF8

import ./parser
import ./source_map
import ./token_processor
import ./tokens

type
  TransformResult* = object
    code*: string
    sourceMap*: SourceLineMap

  TransformOptions* = object
    filePath*: string
    transforms*: seq[string]

  JsxParser = object
    code: string
    pos: int

const
  defaultTransforms = @["typescript", "jsx"]
  moduleTransforms = @["typescript", "jsx", "imports"]
  reservedWords = [
    "break", "case", "catch", "class", "const", "continue", "debugger",
    "default", "delete", "do", "else", "export", "extends", "finally",
    "for", "function", "if", "import", "in", "instanceof", "new", "return",
    "super", "switch", "this", "throw", "try", "typeof", "var", "void",
    "while", "with", "yield", "enum", "implements", "interface", "let",
    "package", "private", "protected", "public", "static", "await", "false",
    "null", "true"
  ]

proc hasTransform(options: TransformOptions, name: string): bool =
  let transforms = if options.transforms.len == 0: defaultTransforms else: options.transforms
  name in transforms

proc isIdentStart(c: char): bool =
  c in {'a'..'z', 'A'..'Z', '_', '$'}

proc isIdentPart(c: char): bool =
  isIdentStart(c) or c in {'0'..'9'}

proc isIdentifierName(name: string): bool =
  if name.len == 0 or not isIdentStart(name[0]):
    return false
  for ch in name:
    if not isIdentPart(ch):
      return false
  name notin reservedWords

proc skipSpaces(code: string, i: var int) =
  while i < code.len and code[i] in {' ', '\t', '\n', '\r'}:
    inc i

proc jsonQuote(s: string): string =
  result = "\""
  for ch in s:
    case ch
    of '\\': result.add("\\\\")
    of '"': result.add("\\\"")
    of '\n': result.add("\\n")
    of '\r': result.add("\\r")
    of '\t': result.add("\\t")
    else: result.add(ch)
  result.add('"')

proc decodeJsxEntities(s: string): string =
  var i = 0
  while i < s.len:
    if s[i] != '&':
      result.add(s[i])
      inc i
      continue
    let semi = s.find(';', i + 1)
    if semi < 0:
      result.add(s[i])
      inc i
      continue
    let entity = s[i + 1..<semi]
    case entity
    of "amp": result.add('&')
    of "lt": result.add('<')
    of "gt": result.add('>')
    of "quot": result.add('"')
    of "apos": result.add('\'')
    of "nbsp": result.add(" ")
    else:
      if entity.startsWith("#x") or entity.startsWith("#X"):
        try:
          result.add(Rune(parseHexInt(entity[2..^1])).toUTF8())
        except CatchableError:
          result.add("&" & entity & ";")
      elif entity.startsWith("#"):
        try:
          result.add(Rune(parseInt(entity[1..^1])).toUTF8())
        except CatchableError:
          result.add("&" & entity & ";")
      else:
        result.add("&" & entity & ";")
    i = semi + 1

proc startsWordAt(code: string, i: int, word: string): bool =
  if i < 0 or i + word.len > code.len:
    return false
  if code.substr(i, i + word.len - 1) != word:
    return false
  if i > 0 and isIdentPart(code[i - 1]):
    return false
  let after = i + word.len
  after >= code.len or not isIdentPart(code[after])

proc readIdentifier(code: string, i: var int): string =
  let start = i
  if i < code.len and isIdentStart(code[i]):
    inc i
    while i < code.len and isIdentPart(code[i]):
      inc i
  code[start..<i]

proc copyQuoted(code: string, i: var int, quote: char): string =
  let start = i
  inc i
  while i < code.len:
    if code[i] == '\\':
      i += min(2, code.len - i)
    elif code[i] == quote:
      inc i
      break
    else:
      inc i
  code[start..<i]

proc skipQuoted(code: string, i: var int, quote: char) =
  discard copyQuoted(code, i, quote)

proc copyLineComment(code: string, i: var int): string =
  let start = i
  i += 2
  while i < code.len and code[i] notin {'\n', '\r'}:
    inc i
  code[start..<i]

proc skipLineComment(code: string, i: var int) =
  discard copyLineComment(code, i)

proc copyBlockComment(code: string, i: var int): string =
  let start = i
  i += 2
  while i + 1 < code.len:
    if code[i] == '*' and code[i + 1] == '/':
      i += 2
      break
    inc i
  code[start..<i]

proc skipBlockComment(code: string, i: var int) =
  discard copyBlockComment(code, i)

proc copyTemplate(code: string, i: var int): string =
  let start = i
  inc i
  while i < code.len:
    if code[i] == '\\':
      i += min(2, code.len - i)
    elif code[i] == '`':
      inc i
      break
    else:
      inc i
  code[start..<i]

proc skipTemplate(code: string, i: var int) =
  discard copyTemplate(code, i)

proc findMatching(code: string, openIndex: int, openCh: char, closeCh: char): int =
  var i = openIndex
  var depth = 0
  while i < code.len:
    case code[i]
    of '\'', '"':
      skipQuoted(code, i, code[i])
      continue
    of '`':
      skipTemplate(code, i)
      continue
    of '/':
      if i + 1 < code.len and code[i + 1] == '/':
        skipLineComment(code, i)
        continue
      if i + 1 < code.len and code[i + 1] == '*':
        skipBlockComment(code, i)
        continue
    else:
      discard
    if code[i] == openCh:
      inc depth
    elif code[i] == closeCh:
      dec depth
      if depth == 0:
        return i
    inc i
  -1

proc findMatchingReverse(code: string, closeIndex: int, openCh: char, closeCh: char): int =
  var i = closeIndex
  var depth = 0
  while i >= 0:
    if code[i] == closeCh:
      inc depth
    elif code[i] == openCh:
      dec depth
      if depth == 0:
        return i
    dec i
  -1

proc findMatchingAngle(code: string, openIndex: int): int =
  var i = openIndex
  var depth = 0
  while i < code.len:
    case code[i]
    of '\'', '"':
      skipQuoted(code, i, code[i])
      continue
    of '`':
      skipTemplate(code, i)
      continue
    of '/':
      if i + 1 < code.len and code[i + 1] == '/':
        skipLineComment(code, i)
        continue
      if i + 1 < code.len and code[i + 1] == '*':
        skipBlockComment(code, i)
        continue
    of '<':
      inc depth
    of '>':
      dec depth
      if depth == 0:
        return i
    else:
      discard
    inc i
  -1

proc findStatementEnd(code: string, start: int): int =
  var i = start
  var parenDepth = 0
  var braceDepth = 0
  var bracketDepth = 0
  while i < code.len:
    case code[i]
    of '\'', '"':
      skipQuoted(code, i, code[i])
      continue
    of '`':
      skipTemplate(code, i)
      continue
    of '/':
      if i + 1 < code.len and code[i + 1] == '/':
        skipLineComment(code, i)
        continue
      if i + 1 < code.len and code[i + 1] == '*':
        skipBlockComment(code, i)
        continue
    of '(':
      inc parenDepth
    of ')':
      if parenDepth > 0: dec parenDepth
    of '[':
      inc bracketDepth
    of ']':
      if bracketDepth > 0: dec bracketDepth
    of '{':
      inc braceDepth
    of '}':
      if braceDepth > 0:
        dec braceDepth
      elif parenDepth == 0 and bracketDepth == 0:
        return i
    of ';':
      if parenDepth == 0 and braceDepth == 0 and bracketDepth == 0:
        return i + 1
    of '\n':
      if parenDepth == 0 and braceDepth == 0 and bracketDepth == 0:
        return i
    else:
      discard
    inc i
  code.len

proc findTopLevelCommaOrBrace(code: string, start: int, closeCh: char): int =
  var i = start
  var parenDepth = 0
  var braceDepth = 0
  var bracketDepth = 0
  while i < code.len:
    case code[i]
    of '\'', '"':
      skipQuoted(code, i, code[i])
      continue
    of '`':
      skipTemplate(code, i)
      continue
    of '/':
      if i + 1 < code.len and code[i + 1] == '/':
        skipLineComment(code, i)
        continue
      if i + 1 < code.len and code[i + 1] == '*':
        skipBlockComment(code, i)
        continue
    of '(':
      inc parenDepth
    of ')':
      if parenDepth > 0: dec parenDepth
    of '{':
      inc braceDepth
    of '}':
      if closeCh == '}' and parenDepth == 0 and braceDepth == 0 and bracketDepth == 0:
        return i
      if braceDepth > 0: dec braceDepth
    of '[':
      inc bracketDepth
    of ']':
      if bracketDepth > 0: dec bracketDepth
    of ',':
      if parenDepth == 0 and braceDepth == 0 and bracketDepth == 0:
        return i
    else:
      discard
    inc i
  code.len

proc readPropertyName(code: string, i: var int): tuple[nameStringCode: string, variableName: string] =
  skipSpaces(code, i)
  if i < code.len and code[i] in {'\'', '"'}:
    let raw = copyQuoted(code, i, code[i])
    let value =
      if raw.len >= 2: raw[1..^2]
      else: ""
    return (raw, if isIdentifierName(value): value else: "")
  let name = readIdentifier(code, i)
  if name.len == 0:
    raise newException(ValueError, "Expected name or string at beginning of enum element.")
  (jsonQuote(name), if isIdentifierName(name): name else: "")

proc isStringLiteralCode(code: string): bool =
  let trimmed = code.strip()
  trimmed.len >= 2 and trimmed[0] in {'\'', '"'} and trimmed[^1] == trimmed[0]

proc lowerEnumMember(enumName: string, nameStringCode: string, variableName: string, valueCode: string, hasValue: bool, previousValueCode: string): tuple[code: string, previous: string] =
  if hasValue and isStringLiteralCode(valueCode):
    if variableName.len > 0:
      result.code = "const " & variableName & " = " & valueCode.strip() & "; " & enumName & "[" & nameStringCode & "] = " & variableName & ";"
      result.previous = variableName
    else:
      result.code = enumName & "[" & nameStringCode & "] = " & valueCode.strip() & ";"
      result.previous = enumName & "[" & nameStringCode & "]"
    return

  let resolvedValue =
    if hasValue:
      valueCode.strip()
    elif previousValueCode.len > 0:
      previousValueCode & " + 1"
    else:
      "0"
  if variableName.len > 0:
    result.code = "const " & variableName & " = " & resolvedValue & "; " & enumName & "[" & enumName & "[" & nameStringCode & "] = " & variableName & "] = " & nameStringCode & ";"
    result.previous = variableName
  else:
    result.code = enumName & "[" & enumName & "[" & nameStringCode & "] = " & resolvedValue & "] = " & nameStringCode & ";"
    result.previous = enumName & "[" & nameStringCode & "]"

proc lowerEnumDeclaration(code: string, start: int): tuple[code: string, next: int] =
  var i = start
  var isExport = false
  if startsWordAt(code, i, "export"):
    isExport = true
    i += "export".len
    skipSpaces(code, i)
  if startsWordAt(code, i, "const"):
    i += "const".len
    skipSpaces(code, i)
  if not startsWordAt(code, i, "enum"):
    raise newException(ValueError, "Expected enum declaration.")
  i += "enum".len
  skipSpaces(code, i)
  let enumName = readIdentifier(code, i)
  if enumName.len == 0:
    raise newException(ValueError, "Expected enum name.")
  skipSpaces(code, i)
  if i >= code.len or code[i] != '{':
    raise newException(ValueError, "Expected enum body.")
  let close = findMatching(code, i, '{', '}')
  if close < 0:
    raise newException(ValueError, "Unterminated enum body.")

  var body = ""
  var memberPos = i + 1
  var previousValueCode = ""
  while memberPos < close:
    skipSpaces(code, memberPos)
    if memberPos >= close:
      break
    if code[memberPos] == ',':
      inc memberPos
      continue
    let keyInfo = readPropertyName(code, memberPos)
    skipSpaces(code, memberPos)
    var valueCode = ""
    var hasValue = false
    if memberPos < close and code[memberPos] == '=':
      hasValue = true
      inc memberPos
      let valueStart = memberPos
      let valueEnd = findTopLevelCommaOrBrace(code, memberPos, '}')
      valueCode = code[valueStart..<min(valueEnd, close)]
      memberPos = min(valueEnd, close)
    let lowered = lowerEnumMember(enumName, keyInfo.nameStringCode, keyInfo.variableName, valueCode, hasValue, previousValueCode)
    body.add(lowered.code)
    previousValueCode = lowered.previous
    skipSpaces(code, memberPos)
    if memberPos < close and code[memberPos] == ',':
      inc memberPos

  result.code = (if isExport: "export " else: "") & "var " & enumName & "; (function (" & enumName & ") {" & body & "})(" & enumName & " || (" & enumName & " = {}));"
  result.next = close + 1

proc lowerEnums(code: string): string =
  var i = 0
  while i < code.len:
    if code[i] in {'\'', '"'}:
      result.add(copyQuoted(code, i, code[i]))
      continue
    if code[i] == '`':
      result.add(copyTemplate(code, i))
      continue
    if code[i] == '/' and i + 1 < code.len and code[i + 1] == '/':
      result.add(copyLineComment(code, i))
      continue
    if code[i] == '/' and i + 1 < code.len and code[i + 1] == '*':
      result.add(copyBlockComment(code, i))
      continue

    if startsWordAt(code, i, "enum") or
        startsWordAt(code, i, "const") and (block:
          var j = i + "const".len
          skipSpaces(code, j)
          startsWordAt(code, j, "enum")
        ) or
        startsWordAt(code, i, "export") and (block:
          var j = i + "export".len
          skipSpaces(code, j)
          if startsWordAt(code, j, "const"):
            j += "const".len
            skipSpaces(code, j)
          startsWordAt(code, j, "enum")
        ):
      let lowered = lowerEnumDeclaration(code, i)
      result.add(lowered.code)
      i = lowered.next
      continue

    result.add(code[i])
    inc i

proc removeTypeDeclaration(code: string, start: int): int =
  var i = start
  if startsWordAt(code, i, "export"):
    i += "export".len
    skipSpaces(code, i)
  if startsWordAt(code, i, "interface"):
    let brace = code.find('{', i)
    if brace >= 0:
      let close = findMatching(code, brace, '{', '}')
      if close >= 0:
        return close + 1
  findStatementEnd(code, i)

proc skipType(code: string, start: int): int =
  var i = start
  var angleDepth = 0
  var parenDepth = 0
  var braceDepth = 0
  var bracketDepth = 0
  while i < code.len:
    case code[i]
    of '\'', '"':
      skipQuoted(code, i, code[i])
      continue
    of '`':
      skipTemplate(code, i)
      continue
    of '<':
      inc angleDepth
    of '>':
      if angleDepth > 0:
        dec angleDepth
      else:
        break
    of '(':
      inc parenDepth
    of ')':
      if parenDepth == 0 and angleDepth == 0 and braceDepth == 0 and bracketDepth == 0:
        break
      if parenDepth > 0: dec parenDepth
    of '{':
      inc braceDepth
    of '}':
      if braceDepth == 0 and angleDepth == 0 and parenDepth == 0 and bracketDepth == 0:
        break
      if braceDepth > 0: dec braceDepth
    of '[':
      inc bracketDepth
    of ']':
      if bracketDepth == 0 and angleDepth == 0 and parenDepth == 0 and braceDepth == 0:
        break
      if bracketDepth > 0: dec bracketDepth
    of ',', ';', '=':
      if angleDepth == 0 and parenDepth == 0 and braceDepth == 0 and bracketDepth == 0:
        break
    else:
      discard
    if i + 1 < code.len and code[i] == '=' and code[i + 1] == '>':
      break
    inc i
  i

proc skipAssertionType(code: string, start: int): int =
  var i = start
  var angleDepth = 0
  var parenDepth = 0
  var braceDepth = 0
  var bracketDepth = 0
  while i < code.len:
    case code[i]
    of '\'', '"':
      skipQuoted(code, i, code[i])
      continue
    of '`':
      skipTemplate(code, i)
      continue
    of '<':
      inc angleDepth
    of '>':
      if angleDepth > 0:
        dec angleDepth
      else:
        break
    of '(':
      inc parenDepth
    of ')':
      if parenDepth == 0 and angleDepth == 0 and braceDepth == 0 and bracketDepth == 0:
        break
      if parenDepth > 0: dec parenDepth
    of '{':
      inc braceDepth
    of '}':
      if braceDepth == 0 and angleDepth == 0 and parenDepth == 0 and bracketDepth == 0:
        break
      if braceDepth > 0: dec braceDepth
    of '[':
      inc bracketDepth
    of ']':
      if bracketDepth == 0 and angleDepth == 0 and parenDepth == 0 and braceDepth == 0:
        break
      if bracketDepth > 0: dec bracketDepth
    of ',', ';', '\n', '\r':
      if angleDepth == 0 and parenDepth == 0 and braceDepth == 0 and bracketDepth == 0:
        break
    else:
      discard
    if angleDepth == 0 and parenDepth == 0 and braceDepth == 0 and bracketDepth == 0:
      if i + 1 < code.len and ((code[i] == '=' and code[i + 1] == '>') or
          (code[i] == '|' and code[i + 1] == '|') or
          (code[i] == '&' and code[i + 1] == '&') or
          (code[i] == '?' and code[i + 1] == '?')):
        break
    inc i
  i

proc stripParamTypes(params: string): string

proc stripReturnTypeAfterParen(code: string, i: var int) =
  var j = i
  skipSpaces(code, j)
  if j < code.len and code[j] == ':':
    inc j
    skipSpaces(code, j)
    if j < code.len and code[j] == '{':
      let close = findMatching(code, j, '{', '}')
      if close >= 0:
        j = close + 1
      else:
        j = skipType(code, j)
    else:
      while j < code.len:
        if code[j] in {'{', ';'}:
          break
        if j + 1 < code.len and code[j] == '=' and code[j + 1] == '>':
          break
        if code[j] in {'\'', '"'}:
          skipQuoted(code, j, code[j])
          continue
        if code[j] == '`':
          skipTemplate(code, j)
          continue
        inc j
    i = j

proc stripParamTypes(params: string): string =
  var i = 0
  var braceDepth = 0
  var bracketDepth = 0
  while i < params.len:
    case params[i]
    of '\'', '"':
      result.add(copyQuoted(params, i, params[i]))
      continue
    of '`':
      result.add(copyTemplate(params, i))
      continue
    of '/':
      if i + 1 < params.len and params[i + 1] == '/':
        result.add(copyLineComment(params, i))
        continue
      if i + 1 < params.len and params[i + 1] == '*':
        result.add(copyBlockComment(params, i))
        continue
    of '{':
      inc braceDepth
    of '}':
      if braceDepth > 0: dec braceDepth
    of '[':
      inc bracketDepth
    of ']':
      if bracketDepth > 0: dec bracketDepth
    of '?':
      var j = i + 1
      skipSpaces(params, j)
      if j < params.len and params[j] == ':' and braceDepth == 0 and bracketDepth == 0:
        i = j
        continue
    of ':':
      if braceDepth == 0 and bracketDepth == 0:
        inc i
        i = skipType(params, i)
        continue
    else:
      discard
    result.add(params[i])
    inc i

proc stripFunctionAndArrowTypes(code: string): string =
  var i = 0
  while i < code.len:
    if code[i] in {'\'', '"'}:
      result.add(copyQuoted(code, i, code[i]))
      continue
    if code[i] == '`':
      result.add(copyTemplate(code, i))
      continue
    if code[i] == '/' and i + 1 < code.len and code[i + 1] == '/':
      result.add(copyLineComment(code, i))
      continue
    if code[i] == '/' and i + 1 < code.len and code[i + 1] == '*':
      result.add(copyBlockComment(code, i))
      continue

    if startsWordAt(code, i, "function"):
      result.add("function")
      i += "function".len
      while i < code.len and code[i] != '(':
        result.add(code[i])
        inc i
      if i < code.len:
        let close = findMatching(code, i, '(', ')')
        if close >= 0:
          result.add('(')
          result.add(stripParamTypes(code[i + 1..<close]))
          result.add(')')
          i = close + 1
          stripReturnTypeAfterParen(code, i)
          continue

    if code[i] == '(':
      let close = findMatching(code, i, '(', ')')
      if close >= 0:
        var after = close + 1
        stripReturnTypeAfterParen(code, after)
        var arrowCheck = after
        skipSpaces(code, arrowCheck)
        if arrowCheck + 1 < code.len and code[arrowCheck] == '=' and code[arrowCheck + 1] == '>':
          result.add('(')
          result.add(stripParamTypes(code[i + 1..<close]))
          result.add(')')
          i = after
          continue

    result.add(code[i])
    inc i

proc stripTypeParametersAndArguments(code: string): string =
  proc isLikelyTypeList(raw: string): bool =
    let content = raw.strip()
    if content.len == 0:
      return false
    for ch in content:
      if ch in {'{', '}', '"', '\'', '`'}:
        return false
    if "=" in content and not ("extends" in content):
      return false
    true

  var i = 0
  while i < code.len:
    if code[i] in {'\'', '"'}:
      result.add(copyQuoted(code, i, code[i]))
      continue
    if code[i] == '`':
      result.add(copyTemplate(code, i))
      continue
    if code[i] == '/' and i + 1 < code.len and code[i + 1] == '/':
      result.add(copyLineComment(code, i))
      continue
    if code[i] == '/' and i + 1 < code.len and code[i + 1] == '*':
      result.add(copyBlockComment(code, i))
      continue

    if code[i] == '<':
      let close = findMatchingAngle(code, i)
      if close >= 0 and isLikelyTypeList(code[i + 1..<close]):
        var after = close + 1
        skipSpaces(code, after)
        if after < code.len and code[after] in {'{', '('}:
          i = close + 1
          continue
        if startsWordAt(code, after, "extends") or startsWordAt(code, after, "implements"):
          i = close + 1
          continue
        if after < code.len and code[after] == '(':
          let parenClose = findMatching(code, after, '(', ')')
          var arrowCheck = if parenClose >= 0: parenClose + 1 else: after
          skipSpaces(code, arrowCheck)
          let prev = i - 1
          let isAfterIdentifier = prev >= 0 and (isIdentPart(code[prev]) or code[prev] == ')')
          let isGenericArrow = arrowCheck + 1 < code.len and code[arrowCheck] == '=' and code[arrowCheck + 1] == '>'
          if isAfterIdentifier or isGenericArrow:
            i = close + 1
            continue

    result.add(code[i])
    inc i

proc stripTypeScriptModifiers(code: string): string =
  let modifiers = ["public", "private", "protected", "abstract", "readonly", "override", "declare"]
  var i = 0
  while i < code.len:
    if code[i] in {'\'', '"'}:
      result.add(copyQuoted(code, i, code[i]))
      continue
    if code[i] == '`':
      result.add(copyTemplate(code, i))
      continue
    if code[i] == '/' and i + 1 < code.len and code[i + 1] == '/':
      result.add(copyLineComment(code, i))
      continue
    if code[i] == '/' and i + 1 < code.len and code[i + 1] == '*':
      result.add(copyBlockComment(code, i))
      continue
    var removed = false
    for modifier in modifiers:
      if startsWordAt(code, i, modifier):
        var after = i + modifier.len
        skipSpaces(code, after)
        if after < code.len and (isIdentStart(code[after]) or code[after] in {'{', '(', '[', '*'}):
          i = after
          removed = true
          break
    if removed:
      continue
    result.add(code[i])
    inc i

proc stripMethodAndMemberTypes(code: string): string =
  proc isLikelyMemberTypeColon(colonIndex: int): bool =
    var lineStart = colonIndex - 1
    while lineStart >= 0 and code[lineStart] notin {'\n', '\r', '{', ';'}:
      dec lineStart
    let prefix = code[lineStart + 1..<colonIndex]
    if "?" in prefix or "=" in prefix or "(" in prefix or ")" in prefix or "," in prefix:
      return false
    var prev = colonIndex - 1
    while prev >= 0 and code[prev] in {' ', '\t'}:
      dec prev
    if prev >= 0 and code[prev] == '!':
      dec prev
      while prev >= 0 and code[prev] in {' ', '\t'}:
        dec prev
    prev >= 0 and (isIdentPart(code[prev]) or code[prev] in {']', '?'})

  proc isMethodContextBeforeName(nameStart: int): bool =
    var before = nameStart - 1
    while before >= 0 and code[before] in {' ', '\t'}:
      dec before
    if before < 0:
      return true
    if code[before] in {'{', '}', ';', ',', '\n', '\r'}:
      return true
    if isIdentPart(code[before]):
      var wordStart = before
      while wordStart >= 0 and isIdentPart(code[wordStart]):
        dec wordStart
      let word = code[wordStart + 1..before]
      if word in ["async", "static", "get", "set"]:
        return isMethodContextBeforeName(wordStart + 1)
    false

  proc isLikelyMethodParen(openIndex: int): bool =
    var prev = openIndex - 1
    while prev >= 0 and code[prev] in {' ', '\t'}:
      dec prev
    if prev < 0:
      return false
    if code[prev] == ']':
      let openBracket = findMatchingReverse(code, prev, '[', ']')
      return openBracket >= 0 and isMethodContextBeforeName(openBracket)
    if not isIdentPart(code[prev]):
      return false
    var nameStart = prev
    while nameStart >= 0 and isIdentPart(code[nameStart]):
      dec nameStart
    inc nameStart
    isMethodContextBeforeName(nameStart)

  var i = 0
  while i < code.len:
    if code[i] in {'\'', '"'}:
      result.add(copyQuoted(code, i, code[i]))
      continue
    if code[i] == '`':
      result.add(copyTemplate(code, i))
      continue
    if code[i] == '/' and i + 1 < code.len and code[i + 1] == '/':
      result.add(copyLineComment(code, i))
      continue
    if code[i] == '/' and i + 1 < code.len and code[i + 1] == '*':
      result.add(copyBlockComment(code, i))
      continue

    if code[i] == '(' and isLikelyMethodParen(i):
      let close = findMatching(code, i, '(', ')')
      if close >= 0:
        var after = close + 1
        stripReturnTypeAfterParen(code, after)
        var braceCheck = after
        skipSpaces(code, braceCheck)
        if braceCheck < code.len and code[braceCheck] == '{':
          result.add('(')
          result.add(stripParamTypes(code[i + 1..<close]))
          result.add(')')
          i = after
          continue

    if code[i] == '?':
      var j = i + 1
      skipSpaces(code, j)
      if j < code.len and code[j] == ':':
        i = j
        continue

    if code[i] == ':':
      if isLikelyMemberTypeColon(i):
        let typeStart = i + 1
        let typeEnd = skipType(code, typeStart)
        var after = typeEnd
        skipSpaces(code, after)
        if after < code.len and code[after] in {';', '='}:
          if code[after] == '=':
            result.add(' ')
          i = typeEnd
          continue

    result.add(code[i])
    inc i

proc stripVarTypes(code: string): string =
  var i = 0
  var inVarDecl = false
  var inInitializer = false
  var braceDepth = 0
  var bracketDepth = 0
  var parenDepth = 0
  while i < code.len:
    if code[i] in {'\'', '"'}:
      result.add(copyQuoted(code, i, code[i]))
      continue
    if code[i] == '`':
      result.add(copyTemplate(code, i))
      continue
    if code[i] == '/' and i + 1 < code.len and code[i + 1] == '/':
      result.add(copyLineComment(code, i))
      continue
    if code[i] == '/' and i + 1 < code.len and code[i + 1] == '*':
      result.add(copyBlockComment(code, i))
      continue

    if startsWordAt(code, i, "const") or startsWordAt(code, i, "let") or startsWordAt(code, i, "var"):
      let word =
        if startsWordAt(code, i, "const"): "const"
        elif startsWordAt(code, i, "let"): "let"
        else: "var"
      result.add(word)
      i += word.len
      inVarDecl = true
      inInitializer = false
      braceDepth = 0
      bracketDepth = 0
      parenDepth = 0
      continue

    if inVarDecl:
      case code[i]
      of '{':
        inc braceDepth
      of '}':
        if braceDepth > 0: dec braceDepth
      of '[':
        inc bracketDepth
      of ']':
        if bracketDepth > 0: dec bracketDepth
      of '(':
        inc parenDepth
      of ')':
        if parenDepth > 0: dec parenDepth
      else:
        discard

    let atVarTopLevel = inVarDecl and braceDepth == 0 and bracketDepth == 0 and parenDepth == 0

    if atVarTopLevel and not inInitializer and code[i] == ':':
      inc i
      i = skipType(code, i)
      if i < code.len and code[i] == '=':
        result.add(' ')
      continue

    if atVarTopLevel:
      if code[i] == '=':
        inInitializer = true
      elif code[i] == ',':
        inInitializer = false
      elif code[i] in {';', '\n'}:
        inVarDecl = false
        inInitializer = false

    result.add(code[i])
    inc i

proc stripAsAssertions(code: string): string =
  proc isLikelyAssertionTypeStart(code: string, i: int): bool =
    i < code.len and (isIdentStart(code[i]) or code[i] in {'{', '[', '(', '\'', '"'})

  proc isPropertyAccessName(code: string, i: int): bool =
    var prev = i - 1
    while prev >= 0 and code[prev] in {' ', '\t'}:
      dec prev
    prev >= 0 and code[prev] == '.'

  var i = 0
  while i < code.len:
    if code[i] in {'\'', '"'}:
      result.add(copyQuoted(code, i, code[i]))
      continue
    if code[i] == '`':
      result.add(copyTemplate(code, i))
      continue
    if code[i] == '/' and i + 1 < code.len and code[i + 1] == '/':
      result.add(copyLineComment(code, i))
      continue
    if code[i] == '/' and i + 1 < code.len and code[i + 1] == '*':
      result.add(copyBlockComment(code, i))
      continue
    if startsWordAt(code, i, "import"):
      let endStmt = findStatementEnd(code, i)
      result.add(code[i..<endStmt])
      i = endStmt
      continue
    if startsWordAt(code, i, "export"):
      var j = i + "export".len
      skipSpaces(code, j)
      if j < code.len and code[j] in {'{', '*'}:
        let endStmt = findStatementEnd(code, i)
        result.add(code[i..<endStmt])
        i = endStmt
        continue
    if startsWordAt(code, i, "as") and not isPropertyAccessName(code, i):
      var j = i + 2
      skipSpaces(code, j)
      if not isLikelyAssertionTypeStart(code, j):
        result.add(code[i])
        inc i
        continue
      let endType = skipAssertionType(code, j)
      i = endType
      continue
    if startsWordAt(code, i, "satisfies") and not isPropertyAccessName(code, i):
      var j = i + "satisfies".len
      skipSpaces(code, j)
      if not isLikelyAssertionTypeStart(code, j):
        result.add(code[i])
        inc i
        continue
      i = skipAssertionType(code, j)
      continue
    if code[i] == '!' and i + 1 < code.len and code[i + 1] notin {'=', '!'}:
      var j = i + 1
      skipSpaces(code, j)
      if j >= code.len or code[j] in {'.', ',', ')', ']', '}', ';'}:
        inc i
        continue
    result.add(code[i])
    inc i

proc stripTypeScript(code: string): string

proc copyTemplateWithTransformedExpressions(code: string, i: var int): string =
  result.add('`')
  inc i
  while i < code.len:
    if code[i] == '\\':
      let count = min(2, code.len - i)
      result.add(code[i..<i + count])
      i += count
      continue
    if code[i] == '`':
      result.add('`')
      inc i
      break
    if code[i] == '$' and i + 1 < code.len and code[i + 1] == '{':
      let close = findMatching(code, i + 1, '{', '}')
      if close < 0:
        raise newException(ValueError, "Unterminated template literal expression.")
      result.add("${")
      result.add(stripTypeScript(code[i + 2..<close]))
      result.add('}')
      i = close + 1
      continue
    result.add(code[i])
    inc i

proc transformTemplateLiteralTypes(code: string): string =
  var i = 0
  while i < code.len:
    if code[i] in {'\'', '"'}:
      result.add(copyQuoted(code, i, code[i]))
      continue
    if code[i] == '`':
      result.add(copyTemplateWithTransformedExpressions(code, i))
      continue
    if code[i] == '/' and i + 1 < code.len and code[i + 1] == '/':
      result.add(copyLineComment(code, i))
      continue
    if code[i] == '/' and i + 1 < code.len and code[i + 1] == '*':
      result.add(copyBlockComment(code, i))
      continue
    result.add(code[i])
    inc i

proc splitTopLevelCommaList(spec: string): seq[string]

proc skipTypeParametersAt(code: string, i: var int) =
  skipSpaces(code, i)
  if i < code.len and code[i] == '<':
    let close = findMatchingAngle(code, i)
    if close >= 0:
      i = close + 1

proc looksLikeTypeAliasAt(code: string, i: int): bool =
  if not startsWordAt(code, i, "type"):
    return false
  var j = i + "type".len
  skipSpaces(code, j)
  if j >= code.len or not isIdentStart(code[j]):
    return false
  discard readIdentifier(code, j)
  skipTypeParametersAt(code, j)
  skipSpaces(code, j)
  j < code.len and code[j] == '='

proc looksLikeInterfaceDeclarationAt(code: string, i: int): bool =
  if not startsWordAt(code, i, "interface"):
    return false
  var j = i + "interface".len
  skipSpaces(code, j)
  if j >= code.len or not isIdentStart(code[j]):
    return false
  discard readIdentifier(code, j)
  skipTypeParametersAt(code, j)
  skipSpaces(code, j)
  if startsWordAt(code, j, "extends"):
    j += "extends".len
    while j < code.len and code[j] != '{':
      if code[j] in {';', '\n', '\r'}:
        return false
      if code[j] in {'\'', '"'}:
        skipQuoted(code, j, code[j])
        continue
      if code[j] == '`':
        skipTemplate(code, j)
        continue
      inc j
  skipSpaces(code, j)
  j < code.len and code[j] == '{'

proc stripTypeOnlyStatements(code: string): string =
  var i = 0
  while i < code.len:
    if code[i] in {'\'', '"'}:
      result.add(copyQuoted(code, i, code[i]))
      continue
    if code[i] == '`':
      result.add(copyTemplate(code, i))
      continue
    if code[i] == '/' and i + 1 < code.len and code[i + 1] == '/':
      result.add(copyLineComment(code, i))
      continue
    if code[i] == '/' and i + 1 < code.len and code[i + 1] == '*':
      result.add(copyBlockComment(code, i))
      continue

    if looksLikeInterfaceDeclarationAt(code, i) or
        looksLikeTypeAliasAt(code, i) or
        (startsWordAt(code, i, "export") and (block:
          var j = i + "export".len
          skipSpaces(code, j)
          looksLikeInterfaceDeclarationAt(code, j) or looksLikeTypeAliasAt(code, j) or
            (startsWordAt(code, j, "type") and (block:
              j += "type".len
              skipSpaces(code, j)
              j < code.len and code[j] == '{'
            ))
        )):
      i = removeTypeDeclaration(code, i)
      continue

    if startsWordAt(code, i, "import"):
      var j = i + "import".len
      skipSpaces(code, j)
      if startsWordAt(code, j, "type"):
        i = findStatementEnd(code, i)
        continue

    result.add(code[i])
    inc i

proc stripDeclareStatements(code: string): string =
  var i = 0
  while i < code.len:
    if code[i] in {'\'', '"'}:
      result.add(copyQuoted(code, i, code[i]))
      continue
    if code[i] == '`':
      result.add(copyTemplateWithTransformedExpressions(code, i))
      continue
    if code[i] == '/' and i + 1 < code.len and code[i + 1] == '/':
      result.add(copyLineComment(code, i))
      continue
    if code[i] == '/' and i + 1 < code.len and code[i + 1] == '*':
      result.add(copyBlockComment(code, i))
      continue

    if startsWordAt(code, i, "declare"):
      var j = i + "declare".len
      skipSpaces(code, j)
      if startsWordAt(code, j, "var") or startsWordAt(code, j, "let") or
          startsWordAt(code, j, "const") or startsWordAt(code, j, "function") or
          startsWordAt(code, j, "class") or startsWordAt(code, j, "enum") or
          startsWordAt(code, j, "module") or startsWordAt(code, j, "global"):
        i = findStatementEnd(code, i)
        continue

    if startsWordAt(code, i, "export"):
      var j = i + "export".len
      skipSpaces(code, j)
      if startsWordAt(code, j, "declare"):
        var k = j + "declare".len
        skipSpaces(code, k)
        if startsWordAt(code, k, "var") or startsWordAt(code, k, "let") or
            startsWordAt(code, k, "const") or startsWordAt(code, k, "function") or
            startsWordAt(code, k, "class") or startsWordAt(code, k, "enum") or
            startsWordAt(code, k, "module") or startsWordAt(code, k, "global"):
          i = findStatementEnd(code, i)
          continue

    result.add(code[i])
    inc i

proc transformConstructorParameterProperties(code: string): string =
  proc transformParams(params: string): tuple[code: string, assignments: seq[string]] =
    let parts = splitTopLevelCommaList(params)
    for index, part in parts:
      if index > 0:
        result.code.add(", ")
      var i = 0
      var leading = ""
      while i < part.len and part[i] in {' ', '\t', '\n', '\r'}:
        leading.add(part[i])
        inc i

      var scan = i
      var foundModifier = false
      while true:
        var beforeModifier = scan
        skipSpaces(part, scan)
        let modifier =
          if startsWordAt(part, scan, "public"): "public"
          elif startsWordAt(part, scan, "private"): "private"
          elif startsWordAt(part, scan, "protected"): "protected"
          elif startsWordAt(part, scan, "readonly"): "readonly"
          else: ""
        if modifier.len == 0:
          scan = beforeModifier
          break
        foundModifier = true
        scan += modifier.len
      skipSpaces(part, scan)

      if foundModifier and scan < part.len and isIdentStart(part[scan]):
        var namePos = scan
        let name = readIdentifier(part, namePos)
        if name.len > 0:
          result.assignments.add("this." & name & " = " & name & ";")
          result.code.add(leading & part[scan..^1])
          continue

      result.code.add(part)

  var i = 0
  while i < code.len:
    if code[i] in {'\'', '"'}:
      result.add(copyQuoted(code, i, code[i]))
      continue
    if code[i] == '`':
      result.add(copyTemplateWithTransformedExpressions(code, i))
      continue
    if code[i] == '/' and i + 1 < code.len and code[i + 1] == '/':
      result.add(copyLineComment(code, i))
      continue
    if code[i] == '/' and i + 1 < code.len and code[i + 1] == '*':
      result.add(copyBlockComment(code, i))
      continue

    if startsWordAt(code, i, "constructor"):
      var open = i + "constructor".len
      skipSpaces(code, open)
      if open < code.len and code[open] == '(':
        let close = findMatching(code, open, '(', ')')
        if close >= 0:
          var bodyOpen = close + 1
          skipSpaces(code, bodyOpen)
          if bodyOpen < code.len and code[bodyOpen] == '{':
            let transformed = transformParams(code[open + 1..<close])
            result.add(code[i..open])
            result.add(transformed.code)
            result.add(code[close..<bodyOpen + 1])
            if transformed.assignments.len > 0:
              result.add(transformed.assignments.join(""))
            i = bodyOpen + 1
            continue

    result.add(code[i])
    inc i

proc tokenRaw(code: string, token: JsToken): string =
  if token.start >= 0 and token.`end` <= code.len and token.start <= token.`end`:
    code[token.start..<token.`end`]
  else:
    ""

proc tokenStatementEnd(tokens: seq[JsToken], start: int): int =
  var parenDepth = 0
  var braceDepth = 0
  var bracketDepth = 0
  for index in start..<tokens.len:
    case tokens[index].typ
    of ttParenL:
      inc parenDepth
    of ttParenR:
      if parenDepth > 0: dec parenDepth
    of ttBraceL:
      inc braceDepth
    of ttBraceR:
      if braceDepth == 0 and parenDepth == 0 and bracketDepth == 0:
        return index
      if braceDepth > 0: dec braceDepth
    of ttBracketL:
      inc bracketDepth
    of ttBracketR:
      if bracketDepth > 0: dec bracketDepth
    of ttSemi:
      if parenDepth == 0 and braceDepth == 0 and bracketDepth == 0:
        return index
    of ttEof:
      return index
    else:
      discard
  max(0, tokens.len - 1)

proc tokenMatching(tokens: seq[JsToken], openIndex: int, openType, closeType: TokenType): int =
  var depth = 0
  for index in openIndex..<tokens.len:
    if tokens[index].typ == openType:
      inc depth
    elif tokens[index].typ == closeType:
      dec depth
      if depth == 0:
        return index
  -1

proc isTsModifierToken(token: JsToken): bool =
  token.typ in {ttPublic, ttPrivate, ttProtected, ttReadonly, ttOverride, ttDeclare, ttAbstract}

proc shouldRemoveDeclareStatement(tokens: seq[JsToken], index: int): bool =
  if tokens[index].typ != ttDeclare:
    return false
  let next = index + 1
  next < tokens.len and tokens[next].typ in {ttVar, ttLet, ttConst, ttFunction, ttClass, ttEnum, ttName}

proc shouldRemoveAbstractMember(tokens: seq[JsToken], index: int): bool =
  if tokens[index].typ != ttAbstract:
    return false
  let next = index + 1
  if next < tokens.len and tokens[next].typ == ttClass:
    return false
  true

proc tokenStripTypeScriptErasure(code: string): string =
  let parsed = parseJs(code)
  let tokens = parsed.tokens
  var processor = initTokenProcessor(code, tokens)
  var removeUntil = -1

  while not processor.isAtEnd():
    let index = processor.currentIndex()
    let token = processor.currentToken()

    if index <= removeUntil:
      processor.removeToken()
      continue

    if token.typ == ttEof:
      processor.copyToken()
      continue

    if shouldRemoveDeclareStatement(tokens, index):
      removeUntil = tokenStatementEnd(tokens, index)
      processor.removeToken()
      continue

    if shouldRemoveAbstractMember(tokens, index):
      removeUntil = tokenStatementEnd(tokens, index)
      processor.removeToken()
      continue

    if token.isType:
      processor.removeToken()
      continue

    if isTsModifierToken(token):
      processor.removeToken()
      continue

    if token.typ == ttBang:
      let next = index + 1
      if next >= tokens.len or tokens[next].typ in {ttDot, ttComma, ttParenR, ttBracketR, ttBraceR, ttSemi, ttEof, ttColon}:
        processor.removeToken()
        continue

    if token.typ == ttQuestion:
      let next = index + 1
      if next < tokens.len and tokens[next].typ == ttColon:
        processor.removeToken()
        continue

    processor.copyToken()

  processor.finish().code

proc stripAbstractMembers(code: string): string =
  var i = 0
  while i < code.len:
    if code[i] in {'\'', '"'}:
      result.add(copyQuoted(code, i, code[i]))
      continue
    if code[i] == '`':
      result.add(copyTemplateWithTransformedExpressions(code, i))
      continue
    if code[i] == '/' and i + 1 < code.len and code[i + 1] == '/':
      result.add(copyLineComment(code, i))
      continue
    if code[i] == '/' and i + 1 < code.len and code[i + 1] == '*':
      result.add(copyBlockComment(code, i))
      continue

    if startsWordAt(code, i, "abstract"):
      var j = i + "abstract".len
      skipSpaces(code, j)
      if startsWordAt(code, j, "class"):
        result.add(code[i])
        inc i
        continue
      let endStmt = findStatementEnd(code, i)
      var k = endStmt
      while k < code.len and code[k] in {' ', '\t'}:
        inc k
      if k >= code.len or code[k] in {'\n', '\r', ';', '}'}:
        i = endStmt
        continue

    result.add(code[i])
    inc i

proc stripTypeScript(code: string): string =
  result = code.lowerEnums()
  result = result.transformConstructorParameterProperties()
  result = result.stripTypeOnlyStatements()
  result = result.stripDeclareStatements()
  result = result.stripAbstractMembers()
  result = result.stripTypeScriptModifiers()
  result = result.stripTypeParametersAndArguments()
  result = result.stripFunctionAndArrowTypes()
  result = result.stripMethodAndMemberTypes()
  result = result.stripVarTypes()
  result = result.stripAsAssertions()
  result = result.transformTemplateLiteralTypes()
  result = result.tokenStripTypeScriptErasure()

proc shouldStartJsx(code: string, i: int): bool =
  if i + 1 >= code.len or code[i] != '<':
    return false
  if not (code[i + 1] == '>' or isIdentStart(code[i + 1])):
    return false
  var prev = i - 1
  while prev >= 0 and code[prev] in {' ', '\t', '\n', '\r'}:
    dec prev
  if prev < 0:
    return true
  if code[prev] in {'(', '[', '{', '=', ':', ',', ';', '!', '?', '>'}:
    return true
  if isIdentPart(code[prev]):
    var start = prev
    while start >= 0 and isIdentPart(code[start]):
      dec start
    let word = code[start + 1..prev]
    return word in ["return", "yield", "case", "throw"]
  false

proc readBalancedBrace(p: var JsxParser): string =
  if p.pos >= p.code.len or p.code[p.pos] != '{':
    return ""
  let start = p.pos + 1
  let close = findMatching(p.code, p.pos, '{', '}')
  if close < 0:
    raise newException(ValueError, "Unterminated JSX expression.")
  p.pos = close + 1
  p.code[start..<close]

proc transformJSX(code: string): string

proc transformExpression(code: string): string =
  transformJSX(stripTypeScript(code))

proc readJsxName(p: var JsxParser): string =
  let start = p.pos
  while p.pos < p.code.len and (isIdentPart(p.code[p.pos]) or p.code[p.pos] in {'-', ':', '.'}):
    inc p.pos
  p.code[start..<p.pos]

proc jsxTagCode(name: string): string =
  if name.len == 0:
    return "\"\""
  if name[0] in {'a'..'z'} or '-' in name or ':' in name:
    jsonQuote(name)
  else:
    name

proc normalizedJsxText(raw: string): string =
  let collapsed = raw.replace("\r", "\n").splitLines().mapIt(it.strip()).filterIt(it.len > 0).join(" ")
  decodeJsxEntities(collapsed)

proc parseJsxElement(p: var JsxParser): string

proc parseJsxChildren(p: var JsxParser, closingName: string): seq[string] =
  while p.pos < p.code.len:
    if p.code[p.pos] == '<' and p.pos + 1 < p.code.len and p.code[p.pos + 1] == '/':
      p.pos += 2
      if closingName.len > 0:
        let found = readJsxName(p)
        if found != closingName:
          raise newException(ValueError, "Mismatched JSX closing tag: " & found)
      skipSpaces(p.code, p.pos)
      if p.pos < p.code.len and p.code[p.pos] == '>':
        inc p.pos
      return
    if shouldStartJsx(p.code, p.pos):
      result.add(parseJsxElement(p))
      continue
    if p.code[p.pos] == '{':
      let expression = readBalancedBrace(p).strip()
      if expression.len > 0 and expression != "...":
        result.add(transformExpression(expression))
      continue
    let start = p.pos
    while p.pos < p.code.len and not (p.code[p.pos] == '{' or p.code[p.pos] == '<'):
      inc p.pos
    let text = normalizedJsxText(p.code[start..<p.pos])
    if text.len > 0:
      result.add(jsonQuote(text))

proc parseJsxProps(p: var JsxParser): string =
  var props: seq[string] = @[]
  while p.pos < p.code.len:
    skipSpaces(p.code, p.pos)
    if p.pos >= p.code.len or p.code[p.pos] == '>' or
        (p.code[p.pos] == '/' and p.pos + 1 < p.code.len and p.code[p.pos + 1] == '>'):
      break
    if p.code[p.pos] == '{':
      let expression = readBalancedBrace(p).strip()
      if expression.startsWith("..."):
        props.add("..." & transformExpression(expression[3..^1].strip()))
      continue
    let name = readJsxName(p)
    if name.len == 0:
      inc p.pos
      continue
    skipSpaces(p.code, p.pos)
    if p.pos >= p.code.len or p.code[p.pos] != '=':
      props.add(jsonQuote(name) & ": true")
      continue
    inc p.pos
    skipSpaces(p.code, p.pos)
    var value = "true"
    if p.pos < p.code.len and p.code[p.pos] in {'\'', '"'}:
      let raw = copyQuoted(p.code, p.pos, p.code[p.pos])
      value =
        if raw.len >= 2:
          jsonQuote(decodeJsxEntities(raw[1..^2]))
        else:
          raw
    elif p.pos < p.code.len and p.code[p.pos] == '{':
      value = transformExpression(readBalancedBrace(p))
    elif shouldStartJsx(p.code, p.pos):
      value = parseJsxElement(p)
    props.add(jsonQuote(name) & ": " & value)
  if props.len == 0:
    "null"
  else:
    "{" & props.join(", ") & "}"

proc parseJsxElement(p: var JsxParser): string =
  if p.pos >= p.code.len or p.code[p.pos] != '<':
    raise newException(ValueError, "Expected JSX tag.")
  p.pos += 1
  if p.pos < p.code.len and p.code[p.pos] == '>':
    inc p.pos
    let children = parseJsxChildren(p, "")
    var args = @["__frameosFragment", "null"]
    args.add(children)
    return "__frameosJsx(" & args.join(", ") & ")"

  let name = readJsxName(p)
  let props = parseJsxProps(p)
  if p.pos + 1 < p.code.len and p.code[p.pos] == '/' and p.code[p.pos + 1] == '>':
    p.pos += 2
    return "__frameosJsx(" & jsxTagCode(name) & ", " & props & ")"
  if p.pos < p.code.len and p.code[p.pos] == '>':
    inc p.pos
  let children = parseJsxChildren(p, name)
  var args = @[jsxTagCode(name), props]
  args.add(children)
  "__frameosJsx(" & args.join(", ") & ")"

proc transformJSX(code: string): string =
  let parsed = parseJs(code)
  let tokens = parsed.tokens
  var processor = initTokenProcessor(code, tokens)

  while not processor.isAtEnd():
    let token = processor.currentToken()
    if token.typ == ttEof:
      processor.copyToken()
      continue

    if token.typ == ttJsxTagStart:
      let next = processor.currentIndex() + 1
      if next < tokens.len and tokens[next].typ == ttSlash:
        processor.copyToken()
        continue

      var parser = JsxParser(code: code, pos: token.start)
      let lowered = parseJsxElement(parser)
      processor.replaceToken(lowered)
      while not processor.isAtEnd() and processor.currentToken().typ != ttEof and
          processor.currentToken().start < parser.pos:
        inc processor.tokenIndex
      continue

    processor.copyToken()

  processor.finish().code

proc parseExportNames(spec: string): seq[(string, string)] =
  for rawPart in spec.split(','):
    let part = rawPart.strip()
    if part.len == 0:
      continue
    let pieces = part.splitWhitespace()
    if pieces.len == 1:
      result.add((pieces[0], pieces[0]))
    elif pieces.len == 3 and pieces[1] == "as":
      result.add((pieces[0], pieces[2]))

proc sanitizeModuleIdentifier(path: string): string =
  result = "_"
  for ch in path:
    if ch.isAlphaNumeric:
      result.add(ch)
    else:
      result.add('_')
  if result.len == 1:
    result.add("module")

proc uniqueModuleIdentifier(path: string, counter: var int): string =
  inc counter
  sanitizeModuleIdentifier(path) & "_" & $counter

proc unquoteModulePath(raw: string): string =
  let value = raw.strip()
  if value.len >= 2 and value[0] in {'\'', '"'} and value[^1] == value[0]:
    value[1..^2]
  else:
    value

proc splitTopLevelCommaList(spec: string): seq[string] =
  var i = 0
  var partStart = 0
  var braceDepth = 0
  var bracketDepth = 0
  var parenDepth = 0
  while i < spec.len:
    case spec[i]
    of '\'', '"':
      skipQuoted(spec, i, spec[i])
      continue
    of '`':
      skipTemplate(spec, i)
      continue
    of '{':
      inc braceDepth
    of '}':
      if braceDepth > 0: dec braceDepth
    of '[':
      inc bracketDepth
    of ']':
      if bracketDepth > 0: dec bracketDepth
    of '(':
      inc parenDepth
    of ')':
      if parenDepth > 0: dec parenDepth
    of ',':
      if braceDepth == 0 and bracketDepth == 0 and parenDepth == 0:
        let part = spec[partStart..<i].strip()
        if part.len > 0:
          result.add(part)
        partStart = i + 1
    else:
      discard
    inc i
  let lastPart = spec[partStart..^1].strip()
  if lastPart.len > 0:
    result.add(lastPart)

proc parseImportExportSpecifiers(spec: string): seq[(string, string)] =
  for rawPart in splitTopLevelCommaList(spec):
    var part = rawPart.strip()
    if part.startsWith("type "):
      continue
    let pieces = part.splitWhitespace()
    if pieces.len == 1:
      result.add((pieces[0], pieces[0]))
    elif pieces.len == 3 and pieces[1] == "as":
      result.add((pieces[0], pieces[2]))

proc collectVarDeclarationNames(declaration: string): seq[string] =
  let trimmed = declaration.strip()
  var i = 0
  if startsWordAt(trimmed, i, "const"):
    i += "const".len
  elif startsWordAt(trimmed, i, "let"):
    i += "let".len
  elif startsWordAt(trimmed, i, "var"):
    i += "var".len
  else:
    return
  let declarators = trimmed[i..^1].strip().strip(chars = {';'})
  for part in splitTopLevelCommaList(declarators):
    var namePos = 0
    let name = readIdentifier(part, namePos)
    if name.len > 0:
      result.add(name)

proc emitImportDeclaration(stmt: string, moduleCounter: var int): string =
  let stripped = stmt.strip().strip(chars = {';'})
  if stripped.startsWith("import type"):
    return ""
  if stripped.startsWith("import("):
    return stmt
  if not stripped.startsWith("import"):
    return stmt

  var rest = stripped["import".len..^1].strip()
  if rest.len == 0:
    return ""

  let requireEquals = rest.find("= require")
  if requireEquals > 0:
    let localName = rest[0..<requireEquals].strip()
    let requireCall = rest[requireEquals + 1..^1].strip()
    if localName.len > 0:
      return "const " & localName & " = " & requireCall & ";"

  if rest[0] in {'\'', '"'}:
    return "require(" & rest & ");"

  let fromIndex = rest.rfind(" from ")
  if fromIndex < 0:
    return "throw new Error(\"Unsupported import declaration\");"
  let bindings = rest[0..<fromIndex].strip()
  let pathCode = rest[fromIndex + " from ".len..^1].strip()
  let path = unquoteModulePath(pathCode)
  let moduleName = uniqueModuleIdentifier(path, moduleCounter)
  result = "var " & moduleName & " = require(" & pathCode & ");"

  var remaining = bindings
  if remaining.len == 0:
    return

  if remaining.startsWith("*"):
    let pieces = remaining.splitWhitespace()
    if pieces.len >= 3 and pieces[1] == "as":
      result.add(" var " & pieces[2] & " = " & moduleName & ";")
    return

  if remaining.startsWith("{"):
    let close = remaining.rfind("}")
    if close >= 0:
      for (importedName, localName) in parseImportExportSpecifiers(remaining[1..<close]):
        result.add(" var " & localName & " = " & moduleName & "." & importedName & ";")
    return

  let commaIndex = remaining.find(',')
  if commaIndex >= 0:
    let defaultName = remaining[0..<commaIndex].strip()
    if defaultName.len > 0:
      result.add(" var " & defaultName & " = " & moduleName & ".default;")
    remaining = remaining[commaIndex + 1..^1].strip()
    if remaining.startsWith("*"):
      let pieces = remaining.splitWhitespace()
      if pieces.len >= 3 and pieces[1] == "as":
        result.add(" var " & pieces[2] & " = " & moduleName & ";")
    elif remaining.startsWith("{"):
      let close = remaining.rfind("}")
      if close >= 0:
        for (importedName, localName) in parseImportExportSpecifiers(remaining[1..<close]):
          result.add(" var " & localName & " = " & moduleName & "." & importedName & ";")
  else:
    result.add(" var " & remaining & " = " & moduleName & ".default;")

proc emitExportFromDeclaration(stmt: string, moduleCounter: var int): string =
  let stripped = stmt.strip().strip(chars = {';'})
  if not stripped.startsWith("export"):
    return stmt
  var rest = stripped["export".len..^1].strip()
  if rest.startsWith("type "):
    return ""
  if rest.startsWith("*"):
    let fromIndex = rest.rfind(" from ")
    if fromIndex < 0:
      return "throw new Error(\"Unsupported export star declaration\");"
    let pathCode = rest[fromIndex + " from ".len..^1].strip()
    let path = unquoteModulePath(pathCode)
    let moduleName = uniqueModuleIdentifier(path, moduleCounter)
    if rest.startsWith("* as "):
      let exportedName = rest["* as ".len..<fromIndex].strip()
      return "exports." & exportedName & " = require(" & pathCode & ");"
    return "var " & moduleName & " = require(" & pathCode & "); Object.keys(" & moduleName & ").forEach(function (key) { if (key !== \"default\" && key !== \"__esModule\") exports[key] = " & moduleName & "[key]; });"
  if rest.startsWith("{"):
    let close = rest.find('}')
    if close < 0:
      return "throw new Error(\"Unsupported export declaration\");"
    var after = close + 1
    skipSpaces(rest, after)
    if not startsWordAt(rest, after, "from"):
      return ""
    after += "from".len
    skipSpaces(rest, after)
    let pathCode = rest[after..^1].strip()
    let path = unquoteModulePath(pathCode)
    let moduleName = uniqueModuleIdentifier(path, moduleCounter)
    result = "var " & moduleName & " = require(" & pathCode & ");"
    for (importedName, exportedName) in parseImportExportSpecifiers(rest[1..<close]):
      result.add(" exports." & exportedName & " = " & moduleName & "." & importedName & ";")
    return
  stmt

proc tokenStatementSlice(code: string, tokens: seq[JsToken], startIndex, endIndex: int): string =
  if startIndex < 0 or startIndex >= tokens.len:
    return ""
  let startPos = tokens[startIndex].start
  let endPos =
    if endIndex >= 0 and endIndex < tokens.len and tokens[endIndex].typ != ttEof:
      tokens[endIndex].`end`
    elif endIndex > startIndex and endIndex - 1 < tokens.len:
      tokens[endIndex - 1].`end`
    else:
      tokens[startIndex].`end`
  if startPos >= 0 and endPos >= startPos and endPos <= code.len:
    code[startPos..<endPos]
  else:
    ""

proc skipProcessorThrough(processor: var TokenProcessor, endIndex: int) =
  while not processor.isAtEnd() and processor.currentIndex() <= endIndex and processor.currentToken().typ != ttEof:
    processor.removeToken()

proc exportDeclarationName(code: string, tokens: seq[JsToken], startIndex: int): string =
  var i = startIndex
  if i < tokens.len and tokens[i].typ == ttAsync:
    inc i
  if i < tokens.len and tokens[i].typ in {ttFunction, ttClass}:
    inc i
  if i < tokens.len and tokens[i].typ == ttStar:
    inc i
  if i < tokens.len and tokens[i].typ in {ttName, ttGet, ttSet}:
    tokenRaw(code, tokens[i])
  else:
    ""

proc transformImportsTokenDriven(code: string): string =
  let parsed = parseJs(code)
  let tokens = parsed.tokens
  var processor = initTokenProcessor(code, tokens)
  var moduleCounter = 0
  var imports: seq[string] = @[]
  var exports: seq[string] = @[]

  while not processor.isAtEnd():
    let index = processor.currentIndex()
    let token = processor.currentToken()

    if token.typ == ttEof:
      processor.copyToken()
      continue

    if token.typ == ttImport:
      let next = index + 1
      if next < tokens.len and tokens[next].typ notin {ttParenL, ttDot}:
        let endIndex = tokenStatementEnd(tokens, index)
        let stmt = tokenStatementSlice(code, tokens, index, endIndex).strip()
        if not stmt.startsWith("import("):
          let emitted = emitImportDeclaration(stmt, moduleCounter)
          if emitted.len > 0:
            imports.add(emitted)
          processor.skipProcessorThrough(endIndex)
          continue

    if token.typ == ttExport:
      let endIndex = tokenStatementEnd(tokens, index)
      var j = index + 1
      if j < tokens.len and tokens[j].typ == ttType:
        processor.skipProcessorThrough(endIndex)
        continue

      if j < tokens.len and tokens[j].typ == ttStar:
        let emitted = emitExportFromDeclaration(tokenStatementSlice(code, tokens, index, endIndex), moduleCounter)
        if emitted.len > 0:
          imports.add(emitted)
        processor.skipProcessorThrough(endIndex)
        continue

      if j < tokens.len and tokens[j].typ == ttBraceL:
        let close = tokenMatching(tokens, j, ttBraceL, ttBraceR)
        var after = close + 1
        if close >= 0 and after < tokens.len and tokens[after].typ == ttName and tokenRaw(code, tokens[after]) == "from":
          let emitted = emitExportFromDeclaration(tokenStatementSlice(code, tokens, index, endIndex), moduleCounter)
          if emitted.len > 0:
            imports.add(emitted)
          processor.skipProcessorThrough(endIndex)
          continue
        if close >= 0:
          for (localName, exportedName) in parseExportNames(code[tokens[j].`end`..<tokens[close].start]):
            exports.add("exports." & exportedName & " = " & localName & ";")
          processor.skipProcessorThrough(endIndex)
          continue

      if j < tokens.len and tokens[j].typ in {ttConst, ttLet, ttVar}:
        let declaration = tokenStatementSlice(code, tokens, j, endIndex)
        for name in collectVarDeclarationNames(declaration):
          exports.add("exports." & name & " = " & name & ";")
        processor.removeToken()
        continue

      if j < tokens.len and tokens[j].typ in {ttFunction, ttClass, ttAsync}:
        let name = exportDeclarationName(code, tokens, j)
        if name.len > 0:
          exports.add("exports." & name & " = " & name & ";")
        processor.removeToken()
        continue

      if j < tokens.len and tokens[j].typ == ttDefault:
        var declarationStart = j + 1
        if declarationStart < tokens.len and tokens[declarationStart].typ in {ttFunction, ttClass, ttAsync}:
          let name = exportDeclarationName(code, tokens, declarationStart)
          if name.len > 0:
            exports.add("exports.default = " & name & ";")
            processor.removeToken()
            if not processor.isAtEnd() and processor.currentIndex() == j:
              processor.removeToken()
            continue
        processor.replaceToken("exports.default =")
        if not processor.isAtEnd() and processor.currentIndex() == j:
          processor.removeToken()
        continue

    processor.copyToken()

  let body = processor.finish().code
  result = "\"use strict\";Object.defineProperty(exports, \"__esModule\", {value: true});"
  if imports.len > 0:
    result.add(imports.join(""))
  result.add(body)
  if exports.len > 0:
    result.add("\n")
    result.add(exports.join("\n"))

proc transformImports(code: string): string =
  return transformImportsTokenDriven(code)

proc transform*(code: string, options: TransformOptions): TransformResult =
  let originalCode = code
  let path = if options.filePath.len == 0: "<frameos>" else: options.filePath
  try:
    result.code = code
    if options.hasTransform("typescript"):
      result.code = stripTypeScript(result.code)
    if options.hasTransform("jsx"):
      result.code = transformJSX(result.code)
      if options.hasTransform("typescript"):
        result.code = stripTypeScript(result.code)
    if options.hasTransform("imports"):
      result.code = transformImports(result.code)
    result.sourceMap = lineBasedSourceLineMap(originalCode, result.code, path, path)
  except CatchableError as error:
    raise newException(ValueError, "Error transforming " & path & ": " & error.msg)

proc transformFrameosScript*(code: string, filePath: string = "<frameos>"): string =
  transform(code, TransformOptions(filePath: filePath, transforms: defaultTransforms)).code

proc transformFrameosModule*(code: string, filePath: string = "<frameos>"): string =
  transform(code, TransformOptions(filePath: filePath, transforms: moduleTransforms)).code
