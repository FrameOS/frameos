# Sucrase-compatible JavaScript/TypeScript/JSX token model for FrameOS.
#
# This is intentionally shaped after Sucrase 3.35.1's parser/tokenizer layer so
# the native transpiler can move from string-scanner passes to token-driven
# transforms incrementally. Sucrase is MIT licensed; see transpiler.nim for
# attribution context.

import std/[strutils]

type
  TokenType* = enum
    ttNum,
    ttBigint,
    ttDecimal,
    ttRegexp,
    ttString,
    ttName,
    ttEof,
    ttBracketL,
    ttBracketR,
    ttBraceL,
    ttBraceBarL,
    ttBraceR,
    ttBraceBarR,
    ttParenL,
    ttParenR,
    ttComma,
    ttSemi,
    ttColon,
    ttDoubleColon,
    ttDot,
    ttQuestion,
    ttQuestionDot,
    ttArrow,
    ttTemplate,
    ttEllipsis,
    ttBackQuote,
    ttDollarBraceL,
    ttAt,
    ttHash,
    ttEq,
    ttAssign,
    ttPreIncDec,
    ttPostIncDec,
    ttBang,
    ttTilde,
    ttPipeline,
    ttNullishCoalescing,
    ttLogicalOR,
    ttLogicalAND,
    ttBitwiseOR,
    ttBitwiseXOR,
    ttBitwiseAND,
    ttEquality,
    ttLessThan,
    ttGreaterThan,
    ttRelationalOrEqual,
    ttBitShiftL,
    ttBitShiftR,
    ttPlus,
    ttMinus,
    ttModulo,
    ttStar,
    ttSlash,
    ttExponent,
    ttJsxName,
    ttJsxText,
    ttJsxEmptyText,
    ttJsxTagStart,
    ttJsxTagEnd,
    ttTypeParameterStart,
    ttNonNullAssertion,
    ttBreak,
    ttCase,
    ttCatch,
    ttContinue,
    ttDebugger,
    ttDefault,
    ttDo,
    ttElse,
    ttFinally,
    ttFor,
    ttFunction,
    ttIf,
    ttReturn,
    ttSwitch,
    ttThrow,
    ttTry,
    ttVar,
    ttLet,
    ttConst,
    ttWhile,
    ttWith,
    ttNew,
    ttThis,
    ttSuper,
    ttClass,
    ttExtends,
    ttExport,
    ttImport,
    ttYield,
    ttNull,
    ttTrue,
    ttFalse,
    ttIn,
    ttInstanceof,
    ttTypeof,
    ttVoid,
    ttDelete,
    ttAsync,
    ttGet,
    ttSet,
    ttDeclare,
    ttReadonly,
    ttAbstract,
    ttStatic,
    ttPublic,
    ttPrivate,
    ttProtected,
    ttOverride,
    ttAs,
    ttEnum,
    ttType,
    ttImplements

  ContextualKeyword* = enum
    ckNone,
    ckAbstract,
    ckAccessor,
    ckAs,
    ckAssert,
    ckAsserts,
    ckAsync,
    ckAwait,
    ckChecks,
    ckConstructor,
    ckDeclare,
    ckEnum,
    ckExports,
    ckFrom,
    ckGet,
    ckGlobal,
    ckImplements,
    ckInfer,
    ckInterface,
    ckIs,
    ckKeyof,
    ckMixins,
    ckModule,
    ckNamespace,
    ckOf,
    ckOpaque,
    ckOut,
    ckOverride,
    ckPrivate,
    ckProtected,
    ckProto,
    ckPublic,
    ckReadonly,
    ckRequire,
    ckSatisfies,
    ckSet,
    ckStatic,
    ckSymbol,
    ckType,
    ckUnique,
    ckUsing

  IdentifierRole* = enum
    irNone,
    irAccess,
    irExportAccess,
    irTopLevelDeclaration,
    irFunctionScopedDeclaration,
    irBlockScopedDeclaration,
    irObjectShorthandTopLevelDeclaration,
    irObjectShorthandFunctionScopedDeclaration,
    irObjectShorthandBlockScopedDeclaration,
    irObjectShorthand,
    irImportDeclaration,
    irObjectKey,
    irImportAccess

  JSXRole* = enum
    jsxRoleNone,
    jsxNoChildren,
    jsxOneChild,
    jsxStaticChildren,
    jsxKeyAfterPropSpread

  Scope* = object
    startTokenIndex*: int
    endTokenIndex*: int
    isFunctionScope*: bool

  JsToken* = object
    typ*: TokenType
    contextualKeyword*: ContextualKeyword
    start*: int
    `end`*: int
    scopeDepth*: int
    isType*: bool
    identifierRole*: IdentifierRole
    jsxRole*: JSXRole
    shadowsGlobal*: bool
    isAsyncOperation*: bool
    contextId*: int
    rhsEndIndex*: int
    isExpression*: bool
    numNullishCoalesceStarts*: int
    numNullishCoalesceEnds*: int
    isOptionalChainStart*: bool
    isOptionalChainEnd*: bool
    subscriptStartIndex*: int
    nullishStartIndex*: int

  TokenizeOptions* = object
    jsx*: bool
    typescript*: bool

  Mode = enum
    modeNormal,
    modeJsxTag,
    modeJsxText,
    modeTemplate

const
  keywordTypes = {
    "break": ttBreak,
    "case": ttCase,
    "catch": ttCatch,
    "continue": ttContinue,
    "debugger": ttDebugger,
    "default": ttDefault,
    "do": ttDo,
    "else": ttElse,
    "finally": ttFinally,
    "for": ttFor,
    "function": ttFunction,
    "if": ttIf,
    "return": ttReturn,
    "switch": ttSwitch,
    "throw": ttThrow,
    "try": ttTry,
    "var": ttVar,
    "let": ttLet,
    "const": ttConst,
    "while": ttWhile,
    "with": ttWith,
    "new": ttNew,
    "this": ttThis,
    "super": ttSuper,
    "class": ttClass,
    "extends": ttExtends,
    "export": ttExport,
    "import": ttImport,
    "yield": ttYield,
    "null": ttNull,
    "true": ttTrue,
    "false": ttFalse,
    "in": ttIn,
    "instanceof": ttInstanceof,
    "typeof": ttTypeof,
    "void": ttVoid,
    "delete": ttDelete,
    "async": ttAsync,
    "get": ttGet,
    "set": ttSet,
    "declare": ttDeclare,
    "readonly": ttReadonly,
    "abstract": ttAbstract,
    "static": ttStatic,
    "public": ttPublic,
    "private": ttPrivate,
    "protected": ttProtected,
    "override": ttOverride,
    "as": ttAs,
    "enum": ttEnum,
    "type": ttType,
    "implements": ttImplements,
  }
  contextualKeywords = {
    "abstract": ckAbstract,
    "accessor": ckAccessor,
    "as": ckAs,
    "assert": ckAssert,
    "asserts": ckAsserts,
    "async": ckAsync,
    "await": ckAwait,
    "checks": ckChecks,
    "constructor": ckConstructor,
    "declare": ckDeclare,
    "enum": ckEnum,
    "exports": ckExports,
    "from": ckFrom,
    "get": ckGet,
    "global": ckGlobal,
    "implements": ckImplements,
    "infer": ckInfer,
    "interface": ckInterface,
    "is": ckIs,
    "keyof": ckKeyof,
    "mixins": ckMixins,
    "module": ckModule,
    "namespace": ckNamespace,
    "of": ckOf,
    "opaque": ckOpaque,
    "out": ckOut,
    "override": ckOverride,
    "private": ckPrivate,
    "protected": ckProtected,
    "proto": ckProto,
    "public": ckPublic,
    "readonly": ckReadonly,
    "require": ckRequire,
    "satisfies": ckSatisfies,
    "set": ckSet,
    "static": ckStatic,
    "symbol": ckSymbol,
    "type": ckType,
    "unique": ckUnique,
    "using": ckUsing,
  }

proc defaultTokenizeOptions*(): TokenizeOptions =
  TokenizeOptions(jsx: true, typescript: true)

proc formatTokenType*(typ: TokenType): string =
  case typ
  of ttNum: "num"
  of ttBigint: "bigint"
  of ttDecimal: "decimal"
  of ttRegexp: "regexp"
  of ttString: "string"
  of ttName: "name"
  of ttEof: "eof"
  of ttBracketL: "["
  of ttBracketR: "]"
  of ttBraceL: "{"
  of ttBraceBarL: "{|"
  of ttBraceR: "}"
  of ttBraceBarR: "|}"
  of ttParenL: "("
  of ttParenR: ")"
  of ttComma: ","
  of ttSemi: ";"
  of ttColon: ":"
  of ttDoubleColon: "::"
  of ttDot: "."
  of ttQuestion: "?"
  of ttQuestionDot: "?."
  of ttArrow: "=>"
  of ttTemplate: "template"
  of ttEllipsis: "..."
  of ttBackQuote: "`"
  of ttDollarBraceL: "${"
  of ttAt: "@"
  of ttHash: "#"
  of ttEq: "="
  of ttAssign: "_="
  of ttPreIncDec, ttPostIncDec: "++/--"
  of ttBang: "!"
  of ttTilde: "~"
  of ttPipeline: "|>"
  of ttNullishCoalescing: "??"
  of ttLogicalOR: "||"
  of ttLogicalAND: "&&"
  of ttBitwiseOR: "|"
  of ttBitwiseXOR: "^"
  of ttBitwiseAND: "&"
  of ttEquality: "==/!="
  of ttLessThan: "<"
  of ttGreaterThan: ">"
  of ttRelationalOrEqual: "<=/>="
  of ttBitShiftL: "<<"
  of ttBitShiftR: ">>/>>>"
  of ttPlus: "+"
  of ttMinus: "-"
  of ttModulo: "%"
  of ttStar: "*"
  of ttSlash: "/"
  of ttExponent: "**"
  of ttJsxName: "jsxName"
  of ttJsxText: "jsxText"
  of ttJsxEmptyText: "jsxEmptyText"
  of ttJsxTagStart: "jsxTagStart"
  of ttJsxTagEnd: "jsxTagEnd"
  of ttTypeParameterStart: "typeParameterStart"
  of ttNonNullAssertion: "nonNullAssertion"
  of ttBreak: "break"
  of ttCase: "case"
  of ttCatch: "catch"
  of ttContinue: "continue"
  of ttDebugger: "debugger"
  of ttDefault: "default"
  of ttDo: "do"
  of ttElse: "else"
  of ttFinally: "finally"
  of ttFor: "for"
  of ttFunction: "function"
  of ttIf: "if"
  of ttReturn: "return"
  of ttSwitch: "switch"
  of ttThrow: "throw"
  of ttTry: "try"
  of ttVar: "var"
  of ttLet: "let"
  of ttConst: "const"
  of ttWhile: "while"
  of ttWith: "with"
  of ttNew: "new"
  of ttThis: "this"
  of ttSuper: "super"
  of ttClass: "class"
  of ttExtends: "extends"
  of ttExport: "export"
  of ttImport: "import"
  of ttYield: "yield"
  of ttNull: "null"
  of ttTrue: "true"
  of ttFalse: "false"
  of ttIn: "in"
  of ttInstanceof: "instanceof"
  of ttTypeof: "typeof"
  of ttVoid: "void"
  of ttDelete: "delete"
  of ttAsync: "async"
  of ttGet: "get"
  of ttSet: "set"
  of ttDeclare: "declare"
  of ttReadonly: "readonly"
  of ttAbstract: "abstract"
  of ttStatic: "static"
  of ttPublic: "public"
  of ttPrivate: "private"
  of ttProtected: "protected"
  of ttOverride: "override"
  of ttAs: "as"
  of ttEnum: "enum"
  of ttType: "type"
  of ttImplements: "implements"

proc formatContextualKeyword*(keyword: ContextualKeyword): string =
  case keyword
  of ckNone: "NONE"
  of ckAbstract: "abstract"
  of ckAccessor: "accessor"
  of ckAs: "as"
  of ckAssert: "assert"
  of ckAsserts: "asserts"
  of ckAsync: "async"
  of ckAwait: "await"
  of ckChecks: "checks"
  of ckConstructor: "constructor"
  of ckDeclare: "declare"
  of ckEnum: "enum"
  of ckExports: "exports"
  of ckFrom: "from"
  of ckGet: "get"
  of ckGlobal: "global"
  of ckImplements: "implements"
  of ckInfer: "infer"
  of ckInterface: "interface"
  of ckIs: "is"
  of ckKeyof: "keyof"
  of ckMixins: "mixins"
  of ckModule: "module"
  of ckNamespace: "namespace"
  of ckOf: "of"
  of ckOpaque: "opaque"
  of ckOut: "out"
  of ckOverride: "override"
  of ckPrivate: "private"
  of ckProtected: "protected"
  of ckProto: "proto"
  of ckPublic: "public"
  of ckReadonly: "readonly"
  of ckRequire: "require"
  of ckSatisfies: "satisfies"
  of ckSet: "set"
  of ckStatic: "static"
  of ckSymbol: "symbol"
  of ckType: "type"
  of ckUnique: "unique"
  of ckUsing: "using"

proc formatIdentifierRole*(role: IdentifierRole): string =
  case role
  of irNone: "none"
  of irAccess: "access"
  of irExportAccess: "exportAccess"
  of irTopLevelDeclaration: "topLevelDeclaration"
  of irFunctionScopedDeclaration: "functionScopedDeclaration"
  of irBlockScopedDeclaration: "blockScopedDeclaration"
  of irObjectShorthandTopLevelDeclaration: "objectShorthandTopLevelDeclaration"
  of irObjectShorthandFunctionScopedDeclaration: "objectShorthandFunctionScopedDeclaration"
  of irObjectShorthandBlockScopedDeclaration: "objectShorthandBlockScopedDeclaration"
  of irObjectShorthand: "objectShorthand"
  of irImportDeclaration: "importDeclaration"
  of irObjectKey: "objectKey"
  of irImportAccess: "importAccess"

proc formatJSXRole*(role: JSXRole): string =
  case role
  of jsxRoleNone: "none"
  of jsxNoChildren: "noChildren"
  of jsxOneChild: "oneChild"
  of jsxStaticChildren: "staticChildren"
  of jsxKeyAfterPropSpread: "keyAfterPropSpread"

proc isIdentStart(c: char): bool =
  c in {'a'..'z', 'A'..'Z', '_', '$'} or ord(c) >= 128

proc isIdentPart(c: char): bool =
  isIdentStart(c) or c in {'0'..'9'}

proc isWhitespace(c: char): bool =
  c in {' ', '\t', '\n', '\r', '\v', '\f'}

proc tokenCanEndExpression(typ: TokenType): bool =
  typ in {
    ttNum, ttBigint, ttDecimal, ttRegexp, ttString, ttName, ttBracketR,
    ttBraceR, ttParenR, ttTemplate, ttBackQuote, ttPostIncDec, ttJsxTagEnd,
    ttNull, ttTrue, ttFalse, ttThis, ttSuper
  }

proc shouldReadRegex(prev: TokenType): bool =
  prev == ttEof or not tokenCanEndExpression(prev) or prev in {
    ttReturn, ttThrow, ttCase, ttDelete, ttTypeof, ttVoid, ttNew, ttIn,
    ttInstanceof
  }

proc skipSpace(code: string, pos: var int): bool =
  while pos < code.len:
    case code[pos]
    of ' ', '\t', '\v', '\f':
      inc pos
    of '\n':
      result = true
      inc pos
    of '\r':
      result = true
      inc pos
      if pos < code.len and code[pos] == '\n':
        inc pos
    of '/':
      if pos + 1 < code.len and code[pos + 1] == '/':
        pos += 2
        while pos < code.len and code[pos] notin {'\n', '\r'}:
          inc pos
      elif pos + 1 < code.len and code[pos + 1] == '*':
        pos += 2
        while pos + 1 < code.len and not (code[pos] == '*' and code[pos + 1] == '/'):
          if code[pos] in {'\n', '\r'}:
            result = true
          inc pos
        if pos + 1 >= code.len:
          raise newException(ValueError, "Unterminated comment")
        pos += 2
      else:
        break
    else:
      if isWhitespace(code[pos]):
        inc pos
      else:
        break

proc makeToken(typ: TokenType, start, finish: int, contextualKeyword = ckNone): JsToken =
  JsToken(
    typ: typ,
    contextualKeyword: contextualKeyword,
    start: start,
    `end`: finish,
    contextId: -1,
    rhsEndIndex: -1,
    subscriptStartIndex: -1,
    nullishStartIndex: -1,
  )

proc readWordToken(code: string, pos: var int, jsxName = false): JsToken =
  let start = pos
  while pos < code.len:
    if isIdentPart(code[pos]) or code[pos] == '-':
      inc pos
    elif code[pos] == '\\':
      pos += 2
      if pos < code.len and code[pos] == '{':
        while pos < code.len and code[pos] != '}':
          inc pos
        if pos < code.len:
          inc pos
    else:
      break
  let word = code[start..<pos]
  if jsxName:
    return makeToken(ttJsxName, start, pos)
  var after = pos
  while after < code.len and code[after] in {' ', '\t', '\n', '\r'}:
    inc after
  for pair in contextualKeywords:
    if pair[0] == word and after < code.len and code[after] in {':', '?', '!'}:
      return makeToken(ttName, start, pos, pair[1])
  if word == "import" and after < code.len and code[after] == '.':
    return makeToken(ttName, start, pos)
  for pair in keywordTypes:
    if pair[0] == word:
      return makeToken(pair[1], start, pos)
  for pair in contextualKeywords:
    if pair[0] == word:
      return makeToken(ttName, start, pos, pair[1])
  makeToken(ttName, start, pos)

proc readNumberToken(code: string, pos: var int, startsWithDot: bool): JsToken =
  let start = pos
  var isBigInt = false
  var isDecimal = false

  template readInt() =
    while pos < code.len and (code[pos] in {'0'..'9'} or code[pos] == '_'):
      inc pos

  if startsWithDot:
    inc pos
    readInt()
  elif pos + 1 < code.len and code[pos] == '0' and code[pos + 1] in {'x', 'X', 'o', 'O', 'b', 'B'}:
    pos += 2
    while pos < code.len and (code[pos] in {'0'..'9', 'a'..'f', 'A'..'F'} or code[pos] == '_'):
      inc pos
  else:
    readInt()
    if pos < code.len and code[pos] == '.':
      inc pos
      readInt()
    if pos < code.len and code[pos] in {'e', 'E'}:
      inc pos
      if pos < code.len and code[pos] in {'+', '-'}:
        inc pos
      readInt()

  if pos < code.len and code[pos] == 'n':
    isBigInt = true
    inc pos
  elif pos < code.len and code[pos] == 'm':
    isDecimal = true
    inc pos

  makeToken(if isBigInt: ttBigint elif isDecimal: ttDecimal else: ttNum, start, pos)

proc readStringToken(code: string, pos: var int): JsToken =
  let start = pos
  let quote = code[pos]
  inc pos
  while pos < code.len:
    if code[pos] == '\\':
      pos += min(2, code.len - pos)
    elif code[pos] == quote:
      inc pos
      return makeToken(ttString, start, pos)
    else:
      inc pos
  raise newException(ValueError, "Unterminated string constant")

proc readRegexToken(code: string, pos: var int): JsToken =
  let start = pos
  var escaped = false
  var inClass = false
  inc pos
  while pos < code.len:
    let ch = code[pos]
    if escaped:
      escaped = false
    else:
      if ch == '[':
        inClass = true
      elif ch == ']' and inClass:
        inClass = false
      elif ch == '/' and not inClass:
        inc pos
        while pos < code.len and isIdentPart(code[pos]):
          inc pos
        return makeToken(ttRegexp, start, pos)
      escaped = ch == '\\'
    inc pos
  raise newException(ValueError, "Unterminated regular expression")

proc readTemplatePart(code: string, pos: var int, prev: TokenType): JsToken =
  let start = pos
  while pos < code.len:
    if code[pos] == '\\':
      pos += min(2, code.len - pos)
      continue
    if code[pos] == '`':
      if pos == start and prev != ttTemplate:
        return makeToken(ttTemplate, start, pos)
      if pos == start:
        inc pos
        return makeToken(ttBackQuote, start, pos)
      return makeToken(ttTemplate, start, pos)
    if code[pos] == '$' and pos + 1 < code.len and code[pos + 1] == '{':
      if pos == start and prev != ttTemplate:
        return makeToken(ttTemplate, start, pos)
      if pos == start:
        pos += 2
        return makeToken(ttDollarBraceL, start, pos)
      return makeToken(ttTemplate, start, pos)
    inc pos
  raise newException(ValueError, "Unterminated template")

proc readJsxText(code: string, pos: var int): JsToken =
  let start = pos
  while pos < code.len and code[pos] notin {'<', '{'}:
    inc pos
  if pos == start:
    return makeToken(ttJsxEmptyText, start, pos)
  if code[start..<pos].strip().len == 0:
    return makeToken(ttJsxEmptyText, start, pos)
  makeToken(ttJsxText, start, pos)

proc looksLikeGenericArrowStart(code: string, pos: int): bool =
  var i = pos + 1
  while i < code.len and code[i] in {' ', '\t'}:
    inc i
  if i >= code.len or not isIdentStart(code[i]):
    return false
  while i < code.len and (isIdentPart(code[i]) or code[i] in {' ', '\t', ',', '?'}) :
    inc i
  if i >= code.len or code[i] != '>':
    return false
  inc i
  while i < code.len and code[i] in {' ', '\t', '\n', '\r'}:
    inc i
  if i >= code.len or code[i] != '(':
    return false
  var depth = 0
  while i < code.len:
    if code[i] == '(':
      inc depth
    elif code[i] == ')':
      dec depth
      if depth == 0:
        inc i
        break
    inc i
  while i < code.len and code[i] in {' ', '\t', '\n', '\r'}:
    inc i
  i + 1 < code.len and code[i] == '=' and code[i + 1] == '>'

proc looksLikeJsxStart(code: string, pos: int, prev: TokenType): bool =
  if pos >= code.len or code[pos] != '<':
    return false
  if looksLikeGenericArrowStart(code, pos):
    return false
  if prev != ttEof and tokenCanEndExpression(prev):
    return false
  var next = pos + 1
  while next < code.len and code[next] in {' ', '\t'}:
    inc next
  next < code.len and (isIdentStart(code[next]) or code[next] in {'/', '>'})

proc punctToken(code: string, pos: var int, prev: TokenType, hadNewline: bool): JsToken =
  let start = pos
  template finish(kind: TokenType, width: int): JsToken =
    pos += width
    makeToken(kind, start, pos)

  case code[pos]
  of '#': finish(ttHash, 1)
  of '.':
    if pos + 1 < code.len and code[pos + 1] in {'0'..'9'}:
      readNumberToken(code, pos, true)
    elif pos + 2 < code.len and code[pos + 1] == '.' and code[pos + 2] == '.':
      finish(ttEllipsis, 3)
    else:
      finish(ttDot, 1)
  of '(':
    finish(ttParenL, 1)
  of ')':
    finish(ttParenR, 1)
  of ';':
    finish(ttSemi, 1)
  of ',':
    finish(ttComma, 1)
  of '[':
    finish(ttBracketL, 1)
  of ']':
    finish(ttBracketR, 1)
  of '{':
    finish(ttBraceL, 1)
  of '}':
    finish(ttBraceR, 1)
  of ':':
    if pos + 1 < code.len and code[pos + 1] == ':': finish(ttDoubleColon, 2)
    else: finish(ttColon, 1)
  of '?':
    if pos + 2 < code.len and code[pos + 1] == '?' and code[pos + 2] == '=':
      finish(ttAssign, 3)
    elif pos + 1 < code.len and code[pos + 1] == '?':
      finish(ttNullishCoalescing, 2)
    elif pos + 1 < code.len and code[pos + 1] == '.' and not (pos + 2 < code.len and code[pos + 2] in {'0'..'9'}):
      finish(ttQuestionDot, 2)
    else:
      finish(ttQuestion, 1)
  of '@':
    finish(ttAt, 1)
  of '`':
    finish(ttBackQuote, 1)
  of '/':
    if shouldReadRegex(prev):
      readRegexToken(code, pos)
    elif pos + 1 < code.len and code[pos + 1] == '=':
      finish(ttAssign, 2)
    else:
      finish(ttSlash, 1)
  of '%':
    if pos + 1 < code.len and code[pos + 1] == '=': finish(ttAssign, 2)
    else: finish(ttModulo, 1)
  of '*':
    if pos + 2 < code.len and code[pos + 1] == '*' and code[pos + 2] == '=':
      finish(ttAssign, 3)
    elif pos + 1 < code.len and code[pos + 1] == '*':
      finish(ttExponent, 2)
    elif pos + 1 < code.len and code[pos + 1] == '=':
      finish(ttAssign, 2)
    else:
      finish(ttStar, 1)
  of '|':
    if pos + 2 < code.len and code[pos + 1] == '|' and code[pos + 2] == '=':
      finish(ttAssign, 3)
    elif pos + 1 < code.len and code[pos + 1] == '|':
      finish(ttLogicalOR, 2)
    elif pos + 1 < code.len and code[pos + 1] == '>':
      finish(ttPipeline, 2)
    elif pos + 1 < code.len and code[pos + 1] == '=':
      finish(ttAssign, 2)
    else:
      finish(ttBitwiseOR, 1)
  of '&':
    if pos + 2 < code.len and code[pos + 1] == '&' and code[pos + 2] == '=':
      finish(ttAssign, 3)
    elif pos + 1 < code.len and code[pos + 1] == '&':
      finish(ttLogicalAND, 2)
    elif pos + 1 < code.len and code[pos + 1] == '=':
      finish(ttAssign, 2)
    else:
      finish(ttBitwiseAND, 1)
  of '^':
    if pos + 1 < code.len and code[pos + 1] == '=': finish(ttAssign, 2)
    else: finish(ttBitwiseXOR, 1)
  of '+':
    if pos + 1 < code.len and code[pos + 1] == '+':
      finish(if tokenCanEndExpression(prev) and not hadNewline: ttPostIncDec else: ttPreIncDec, 2)
    elif pos + 1 < code.len and code[pos + 1] == '=':
      finish(ttAssign, 2)
    else:
      finish(ttPlus, 1)
  of '-':
    if pos + 1 < code.len and code[pos + 1] == '-':
      finish(if tokenCanEndExpression(prev) and not hadNewline: ttPostIncDec else: ttPreIncDec, 2)
    elif pos + 1 < code.len and code[pos + 1] == '=':
      finish(ttAssign, 2)
    else:
      finish(ttMinus, 1)
  of '<':
    if pos + 2 < code.len and code[pos + 1] == '<' and code[pos + 2] == '=':
      finish(ttAssign, 3)
    elif pos + 1 < code.len and code[pos + 1] == '<':
      finish(ttBitShiftL, 2)
    elif pos + 1 < code.len and code[pos + 1] == '=':
      finish(ttRelationalOrEqual, 2)
    else:
      finish(ttLessThan, 1)
  of '>':
    if pos + 3 < code.len and code[pos + 1] == '>' and code[pos + 2] == '>' and code[pos + 3] == '=':
      finish(ttAssign, 4)
    elif pos + 2 < code.len and code[pos + 1] == '>' and code[pos + 2] == '=':
      finish(ttAssign, 3)
    elif pos + 1 < code.len and code[pos + 1] == '>':
      finish(if pos + 2 < code.len and code[pos + 2] == '>': ttBitShiftR else: ttBitShiftR, if pos + 2 < code.len and code[pos + 2] == '>': 3 else: 2)
    elif pos + 1 < code.len and code[pos + 1] == '=':
      finish(ttRelationalOrEqual, 2)
    else:
      finish(ttGreaterThan, 1)
  of '=':
    if pos + 1 < code.len and code[pos + 1] == '>':
      finish(ttArrow, 2)
    elif pos + 1 < code.len and code[pos + 1] == '=':
      finish(ttEquality, if pos + 2 < code.len and code[pos + 2] == '=': 3 else: 2)
    else:
      finish(ttEq, 1)
  of '!':
    if pos + 1 < code.len and code[pos + 1] == '=':
      finish(ttEquality, if pos + 2 < code.len and code[pos + 2] == '=': 3 else: 2)
    else:
      finish(ttBang, 1)
  of '~':
    finish(ttTilde, 1)
  else:
    raise newException(ValueError, "Unexpected character '" & $code[pos] & "'")

proc tokenizeJs*(code: string, options = defaultTokenizeOptions()): seq[JsToken] =
  var pos = 0
  var prev = ttEof
  var mode = modeNormal
  var modeStack: seq[Mode] = @[]
  var braceModeStack: seq[Mode] = @[]
  var jsxDepth = 0
  var jsxTagClosing = false
  var jsxSelfClosing = false
  var tokens: seq[JsToken] = @[]

  proc pushToken(token: JsToken) =
    tokens.add(token)
    prev = token.typ

  while true:
    if mode == modeTemplate:
      let token = readTemplatePart(code, pos, prev)
      pushToken(token)
      if token.typ == ttDollarBraceL:
        braceModeStack.add(modeTemplate)
        mode = modeNormal
      elif token.typ == ttBackQuote:
        if modeStack.len > 0:
          mode = modeStack.pop()
        else:
          mode = modeNormal
      continue

    if mode == modeJsxText:
      if pos >= code.len:
        pushToken(makeToken(ttEof, pos, pos))
        break
      if code[pos] == '<':
        let start = pos
        inc pos
        pushToken(makeToken(ttJsxTagStart, start, pos))
        mode = modeJsxTag
        var look = pos
        while look < code.len and code[look] in {' ', '\t'}:
          inc look
        jsxTagClosing = look < code.len and code[look] == '/'
        jsxSelfClosing = false
        continue
      if code[pos] == '{':
        let start = pos
        inc pos
        pushToken(makeToken(ttBraceL, start, pos))
        braceModeStack.add(modeJsxText)
        mode = modeNormal
        continue
      let token = readJsxText(code, pos)
      pushToken(token)
      continue

    let hadNewline = skipSpace(code, pos)
    if pos >= code.len:
      pushToken(makeToken(ttEof, pos, pos))
      break

    if mode == modeJsxTag:
      let start = pos
      case code[pos]
      of '>':
        inc pos
        pushToken(makeToken(ttJsxTagEnd, start, pos))
        if jsxSelfClosing:
          if jsxDepth == 0:
            mode = modeNormal
          else:
            mode = modeJsxText
        elif jsxTagClosing:
          if jsxDepth > 0:
            dec jsxDepth
          mode = if jsxDepth == 0: modeNormal else: modeJsxText
        else:
          inc jsxDepth
          mode = modeJsxText
        continue
      of '/':
        inc pos
        if not jsxTagClosing:
          jsxSelfClosing = true
        pushToken(makeToken(ttSlash, start, pos))
        continue
      of '{':
        inc pos
        pushToken(makeToken(ttBraceL, start, pos))
        braceModeStack.add(modeJsxTag)
        mode = modeNormal
        continue
      of '=', ':', '.', '-':
        pushToken(punctToken(code, pos, prev, hadNewline))
        continue
      of '\'', '"':
        pushToken(readStringToken(code, pos))
        continue
      else:
        if isIdentStart(code[pos]):
          pushToken(readWordToken(code, pos, jsxName = true))
          continue
        pushToken(punctToken(code, pos, prev, hadNewline))
        continue

    if options.jsx and looksLikeJsxStart(code, pos, prev):
      let start = pos
      inc pos
      pushToken(makeToken(ttJsxTagStart, start, pos))
      mode = modeJsxTag
      var look = pos
      while look < code.len and code[look] in {' ', '\t'}:
        inc look
      jsxTagClosing = look < code.len and code[look] == '/'
      jsxSelfClosing = false
      continue

    if code[pos] == '`':
      let start = pos
      inc pos
      pushToken(makeToken(ttBackQuote, start, pos))
      modeStack.add(mode)
      mode = modeTemplate
      continue

    if code[pos] in {'\'', '"'}:
      pushToken(readStringToken(code, pos))
      continue

    if code[pos] in {'0'..'9'}:
      pushToken(readNumberToken(code, pos, startsWithDot = false))
      continue

    if isIdentStart(code[pos]) or code[pos] == '\\':
      pushToken(readWordToken(code, pos))
      continue

    let token = punctToken(code, pos, prev, hadNewline)
    pushToken(token)
    if token.typ == ttBraceR and braceModeStack.len > 0:
      mode = braceModeStack.pop()

  tokens

proc formatToken*(code: string, token: JsToken): string =
  let raw = if token.start >= 0 and token.`end` <= code.len and token.start <= token.`end`: code[token.start..<token.`end`] else: ""
  var parts = @[formatTokenType(token.typ) & "(" & $token.start & "," & $token.`end` & ")"]
  if token.contextualKeyword != ckNone:
    parts.add("contextual=" & formatContextualKeyword(token.contextualKeyword))
  if raw.len > 0:
    parts.add(raw.multiReplace(("\n", "\\n"), ("\r", "\\r"), ("\t", "\\t")))
  parts.join(" ")

proc formatTokens*(code: string, tokens: seq[JsToken]): string =
  for token in tokens:
    if result.len > 0:
      result.add("\n")
    result.add(formatToken(code, token))
