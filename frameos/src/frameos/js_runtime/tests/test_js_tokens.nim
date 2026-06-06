import std/[sequtils, unittest]

import frameos/js_runtime/tokens

proc tokenNames(code: string): seq[string] =
  tokenizeJs(code).mapIt(formatTokenType(it.typ))

suite "native js tokenizer":
  test "recognizes plain expressions, division, regex, and modern operators":
    check tokenNames("5/3/1") == @["num", "/", "num", "/", "num", "eof"]
    check tokenNames("5 + /3/") == @["num", "+", "regexp", "eof"]
    check tokenNames("a?.b ?? c && d || e") == @["name", "?.", "name", "??", "name", "&&", "name", "||", "name", "eof"]
    check tokenNames("value ||= 1; count &&= 2; n ??= 3") == @["name", "_=", "num", ";", "name", "_=", "num", ";", "name", "_=", "num", "eof"]

  test "distinguishes JSX from relational operators":
    check tokenNames("x<Hello>2") == @["name", "<", "name", ">", "num", "eof"]
    check tokenNames("x + < Hello / >") == @["name", "+", "jsxTagStart", "jsxName", "/", "jsxTagEnd", "eof"]

  test "recognizes nested JSX content":
    let names = tokenNames("""
<div className="foo">
  Hello, world!
  <span className={bar} />
</div>
""")
    check names == @[
      "jsxTagStart", "jsxName", "jsxName", "=", "string", "jsxTagEnd",
      "jsxText", "jsxTagStart", "jsxName", "jsxName", "=", "{", "name",
      "}", "/", "jsxTagEnd", "jsxEmptyText", "jsxTagStart", "/", "jsxName",
      "jsxTagEnd", "eof",
    ]

  test "recognizes template string boundaries and expressions":
    check tokenNames("`Hello, ${name} ${surname}`") == @[
      "`", "template", "${", "name", "}", "template", "${", "name", "}",
      "template", "`", "eof",
    ]

  test "distinguishes pre-increment and post-increment":
    check tokenNames("""
a = b
++c
d++
e = f++
g = ++h
""") == @[
      "name", "=", "name", "++/--", "name", "name", "++/--", "name", "=",
      "name", "++/--", "name", "=", "++/--", "name", "eof",
    ]

  test "tracks contextual keywords":
    let tokens = tokenizeJs("""import foo from "./foo.json" with {type: "json"};""")
    check tokens.mapIt(formatTokenType(it.typ)) == @[
      "import", "name", "name", "string", "with", "{", "name", ":", "string",
      "}", ";", "eof",
    ]
    check tokens[2].contextualKeyword == ckFrom
    check tokens[6].contextualKeyword == ckType

  test "recognizes private-property punctuation":
    check tokenNames("""
class {
  #x = 3
}
this.#x = 3
delete this?.#x
if (#x in obj) { }
""") == @[
      "class", "{", "#", "name", "=", "num", "}", "this", ".", "#", "name",
      "=", "num", "delete", "this", "?.", "#", "name", "if", "(", "#",
      "name", "in", "name", ")", "{", "}", "eof",
    ]
