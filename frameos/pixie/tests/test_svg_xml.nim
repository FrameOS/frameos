import algorithm, os, parsexml, pixie/common, pixie/fileformats/svg, strutils, xmlparser

# parseSvgNodesFast must read exactly the elements std/xmlparser reads for
# what it accepts (text and comments it drops: nothing in a document without
# `<text>` reads them), and refuse (nil) what it does not reproduce, so that
# the full parser reads that — and reports its errors.

proc elements(node: SvgNode): string =
  ## The elements and attributes of a tree, which is all parseSvg reads of a
  ## document without text. Attributes sorted: std's table holds them in hash
  ## order, and an element reads them by name.
  if node.tag.len == 0 or node.tag == "&":
    return
  result = "<" & node.tag
  for (key, value) in node.attrs.sorted():
    result.add " " & key & "=" & value.escape
  result.add ">"
  for child in node.children:
    result.add child.elements
  result.add "</" & node.tag & ">"

proc stdTree(data: string): string =
  parseXml(data, {reportComments}).toSvgNode().elements

proc check(data: string, fast: bool) =
  let tree = parseSvgNodesFast(data)
  if fast:
    doAssert tree != nil, "refused: " & data
  if tree != nil:
    doAssert tree.elements == stdTree(data), "differs: " & data & "\n" &
      tree.elements & "\n" & stdTree(data)

var corpus, accepted: int
for dir in ["tests/fileformats/svg", "tests/fonts"]:
  for path in walkFiles(dir / "*.svg"):
    let data = readFile(path)
    inc corpus
    if parseSvgNodesFast(data) != nil:
      inc accepted
    check(data, fast = false)
doAssert accepted > 0

const svgOpen = """<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">"""

# What an app writes.
check(svgOpen & """<rect x="0" y="0" width="10" height="10" fill="#090b14"/><g transform="translate(1.50 2.25) scale(0.5)" opacity="0.32"><path d="M0 0L5 5Z"/></g></svg>""", true)
# Whitespace between tags, a declaration-free prolog, a processing instruction.
check("""<?xml version="1.0"?>""" & "\n" & svgOpen & "\n  <g>\n    <rect width='3' height=\"4\" />\n  </g>\n</svg>\n", true)
# Attribute values: runs of whitespace are one space, a trailing run goes,
# a leading one stays one space.
check(svgOpen & "<path d=\"M0 0\n  L5\t5   Z  \"/><path d=\"  M1 1\"/><path d=\" M2 2 \"/></svg>", true)
# Comments and text are read past.
check(svgOpen & "<!-- a -- b --> \n <g><title>Logo  x </title><!--c--><rect/></g></svg>", true)
check("<!-- before -->\n" & svgOpen & "<g/></svg>", true)
# Names with namespaces and dots, single-quoted values holding the other quote.
check("""<svg xmlns:xlink="x"><use xlink:href='#a"b' a.b-c="1"/></svg>""", true)
# A repeated attribute: the last one wins, as in std's table.
check(svgOpen & """<rect x="1" x="2"/></svg>""", true)
check("<svg><g ></g><g/><g\n/></svg>", true)
# Everything after the root element is ignored, as std ignores it.
check(svgOpen & "</svg><junk", true)

# Refused: the full parser reads these.
for data in [
  svgOpen & "<text>a &amp; b</text></svg>", # an entity
  svgOpen & "<rect\r\n/></svg>",            # a CR
  svgOpen & "<![CDATA[x]]></svg>",
  "<!DOCTYPE svg>" & svgOpen & "</svg>",
  svgOpen & "<rect x=1/></svg>",            # unquoted
  svgOpen & "<rect x/></svg>",              # empty
  svgOpen & "<g></h></svg>",                # mismatched
  svgOpen & "<g>",                          # unclosed
  "text" & svgOpen & "</svg>",              # text before the root
  svgOpen & "<rect x=\"1\"",                # cut off
  svgOpen & "< g/></svg>",                  # no name
]:
  doAssert parseSvgNodesFast(data) == nil, data

# parseSvgNodes gives the same elements either way, and the same errors.
doAssert parseSvgNodes(svgOpen & "<rect/></svg>").elements ==
  stdTree(svgOpen & "<rect/></svg>")
var raised = false
try:
  discard parseSvgNodes(svgOpen & "<g></h></svg>")
except PixieError:
  raised = true
doAssert raised

# A text document goes through std, with its whitespace and its entities.
block:
  let root = parseSvgNodes(svgOpen & "<text><tspan>a</tspan> &amp; &nbsp;b</text></svg>")
  var texts: seq[string]
  for child in root.children[0].children:
    texts.add child.tag & ":" & child.text
  doAssert texts == @["tspan:", ": ", ":&", ": ", "&: ", ":b"], $texts

echo "test_svg_xml: ", accepted, " of ", corpus, " corpus files read fast, ok"
