## Themes for the UIs built in Nim (ui/theme.nim): an element's look gives way
## to its role's in the layout's theme, its place and its layout stay, and a list
## is boxes inside each other, the outermost in its place and taking its presses.

import std/[algorithm, json, strutils]
import pixie/fileformats/svg
import frameos/ui/theme
import frameos/ui/tree

var given: JsonNode
themeSource = proc(): JsonNode {.nimcall, gcsafe, raises: [].} =
  {.cast(gcsafe).}:
    result = given

proc classOf(n: SvgNode): string = n.attrs[0][1]

proc button(): SvgNode =
  result = el("div", "shrink-0 flex items-center rounded-full font-bold h-[36px] px-[16px] text-[14px] " &
    "bg-zinc-800 active:bg-zinc-600", SvgNode(text: "Save"))
  result.attrs.add(("on-click", "2"))

block no_theme:
  given = nil
  let b = button()
  doAssert b.role("button") == b
  doAssert b.classOf.contains("bg-zinc-800")
  given = %*{"field": "bg-white"}
  doAssert b.role("button").classOf.contains("bg-zinc-800"), "a role the theme does not give keeps its look"
  echo "no theme ok"

block one_box:
  given = %*{"button": "bg-[#c0c0c0] text-black"}
  let b = button()
  let r = b.role("button")
  doAssert r == b
  let c = r.classOf
  for kept in ["shrink-0", "h-[36px]", "flex", "items-center", "px-[16px]", "text-[14px]", "bg-[#c0c0c0]", "text-black"]:
    doAssert kept in c.splitWhitespace(), kept & " in " & c
  for gone in ["rounded-full", "font-bold", "bg-zinc-800", "active:bg-zinc-600"]:
    doAssert gone notin c.splitWhitespace(), gone & " in " & c
  echo "one box ok"

block boxes_inside_each_other:
  given = %*{"button": ["bg-[#c0c0c0] border-t-1 border-l-1 border-white", "border-b-1 border-r-1 border-black"]}
  let b = button()
  let outer = b.role("button")
  doAssert outer != b and outer.children.len == 1 and outer.children[0] == b
  let o = outer.classOf.splitWhitespace()
  for kept in ["shrink-0", "h-[36px]", "text-[14px]", "flex", "bg-[#c0c0c0]", "border-white"]:
    doAssert kept in o, kept & " outside: " & outer.classOf
  doAssert "px-[16px]" notin o and "items-center" notin o, "the content's layout is inside: " & outer.classOf
  let i = b.classOf.splitWhitespace()
  for kept in ["flex-1", "items-center", "px-[16px]", "border-black"]:
    doAssert kept in i, kept & " inside: " & b.classOf
  doAssert "h-[36px]" notin i
  # The whole bevel takes the press, the text stays where it was.
  doAssert ("on-click", "2") in outer.attrs and ("on-click", "2") notin b.attrs
  doAssert b.children.len == 1 and b.children[0].text == "Save"
  echo "boxes ok"

block one_box_roles:
  # A page holds the rest and text is text: never boxes around them.
  given = %*{"page": ["border-2 border-white", "bg-black text-white"], "muted": ["x", "text-white"]}
  let page = el("div", "flex flex-col h-full text-[16px] bg-zinc-950 text-white")
  doAssert page.role("page") == page
  doAssert page.classOf.splitWhitespace().sorted() == @["bg-black", "flex", "flex-col", "h-full", "text-[16px]", "text-white"],
    page.classOf
  let span = el("span", "shrink-0 text-zinc-400")
  doAssert span.role("muted") == span and span.classOf == "shrink-0 text-white", span.classOf
  echo "one-box roles ok"

themeSource = nil
echo "theme: ok"
