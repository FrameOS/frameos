import std/[sequtils, strutils, unittest]

import frameos/js_runtime/parser
import frameos/js_runtime/token_processor
import frameos/js_runtime/tokens

proc tokensOf(code: string): seq[JsToken] =
  parseJs(code).tokens

proc tokenText(code: string, token: JsToken): string =
  if token.start >= 0 and token.`end` <= code.len and token.start <= token.`end`:
    code[token.start..<token.`end`]
  else:
    ""

proc firstToken(code: string, text: string): JsToken =
  for token in tokensOf(code):
    if tokenText(code, token) == text:
      return token
  raise newException(ValueError, "Token not found: " & text)

suite "native js parser annotations":
  test "marks declarations and scopes":
    let code = """
function outer(a: number) {
  const x: string = "x";
  var y = 1;
  class Inner {}
}
"""
    let tokens = tokensOf(code)
    let outer = firstToken(code, "outer")
    let arg = firstToken(code, "a")
    let x = firstToken(code, "x")
    let y = firstToken(code, "y")
    let inner = firstToken(code, "Inner")

    check outer.identifierRole == irTopLevelDeclaration
    check arg.identifierRole == irFunctionScopedDeclaration
    check x.identifierRole == irBlockScopedDeclaration
    check y.identifierRole == irFunctionScopedDeclaration
    check inner.identifierRole == irBlockScopedDeclaration
    check tokens.anyIt(it.scopeDepth > 0)

  test "marks import/export binding roles":
    let code = """
import DefaultThing, { value as renamed, other } from "pkg";
export { renamed as publicName };
export const answer = 42;
"""
    check firstToken(code, "DefaultThing").identifierRole == irImportDeclaration
    check firstToken(code, "value").identifierRole == irImportAccess
    check firstToken(code, "renamed").identifierRole == irImportDeclaration
    check firstToken(code, "other").identifierRole == irImportDeclaration

    let exportedRenamed = tokensOf(code).filterIt(tokenText(code, it) == "renamed" and it.identifierRole == irExportAccess)
    check exportedRenamed.len == 1
    check firstToken(code, "answer").identifierRole == irTopLevelDeclaration

  test "marks TypeScript type spans":
    let code = """
type Alias<T> = { value: T };
interface Input { value?: string }
const answer: number = 42;
const label = answer as number satisfies number;
"""
    let tokens = tokensOf(code)
    for text in ["Alias", "Input"]:
      check tokens.anyIt(tokenText(code, it) == text and it.isType)
    check tokens.anyIt(tokenText(code, it) == ":" and it.isType)
    check tokens.anyIt(tokenText(code, it) == "number" and it.isType)
    check tokens.anyIt(tokenText(code, it) == "as" and it.isType)
    check tokens.anyIt(tokenText(code, it) == "satisfies" and it.isType)

  test "marks JSX roles":
    let code = """
const empty = <div />;
const one = <div>{child}</div>;
const many = <div><span />{child}</div>;
const keyed = <div {...props} key={1} />;
"""
    let allTokens = tokensOf(code)
    var jsxStarts: seq[JsToken] = @[]
    for index, token in allTokens:
      if token.typ == ttJsxTagStart and (index + 1 >= allTokens.len or allTokens[index + 1].typ != ttSlash):
        jsxStarts.add(token)
    check jsxStarts[0].jsxRole == jsxNoChildren
    check jsxStarts[1].jsxRole == jsxOneChild
    check jsxStarts[2].jsxRole == jsxStaticChildren
    check jsxStarts[^1].jsxRole == jsxKeyAfterPropSpread

  test "marks optional chain and nullish boundaries":
    let code = "const result = app.config?.nested?.count ?? 1;"
    let tokens = tokensOf(code)
    check tokens.anyIt(it.isOptionalChainStart)
    check tokens.anyIt(it.isOptionalChainEnd)
    check tokens.anyIt(it.numNullishCoalesceStarts > 0)
    check tokens.anyIt(it.numNullishCoalesceEnds > 0)

suite "native js token processor":
  test "copies all tokens while preserving source":
    let code = "const value = 1;\n// trailing\n"
    var processor = initTokenProcessor(code, tokenizeJs(code))
    check processor.copyAll().code == code

  test "removes annotated type tokens while preserving runtime whitespace":
    let code = "const value: number = 1;\n"
    let parsed = parseJs(code)
    var processor = initTokenProcessor(code, parsed.tokens)
    while not processor.isAtEnd():
      if processor.currentToken().isType:
        processor.removeToken()
      else:
        processor.copyToken()
    let output = processor.finish().code
    check "value: number" notin output
    check "const value = 1;" in output

  test "replaces tokens and records mappings":
    let code = "const value = 1;"
    var processor = initTokenProcessor(code, tokenizeJs(code))
    while not processor.isAtEnd():
      if processor.currentTokenCode() == "value":
        processor.replaceToken("renamed")
      else:
        processor.copyToken()
    let result = processor.finish()
    check result.code == "const renamed = 1;"
    var valueIndex = -1
    for index, token in tokenizeJs(code):
      if tokenText(code, token) == "value":
        valueIndex = index
        break
    check result.mappings[valueIndex] == "const ".len

  test "supports snapshots for lookahead-style rewrites":
    let code = "const value = 1;"
    var processor = initTokenProcessor(code, tokenizeJs(code))
    let snapshot = processor.snapshot()
    processor.copyToken()
    processor.copyToken()
    let removed = processor.dangerouslyGetAndRemoveCodeSinceSnapshot(snapshot)
    check removed == "const value"
    processor.restoreToSnapshot(snapshot)
    processor.replaceToken("let")
    while not processor.isAtEnd():
      processor.copyToken()
    check processor.finish().code == "let value = 1;"
