## The same work compiled by Nim 2 and by Nimony, to compare what each puts
## in an image (docs/nimony.md). The shapes are the runtime's everyday ones:
## a ref object graph, strings built and split, a seq, a string-keyed Table,
## a parse that fails, and one exported entry the firmware's C calls.
## No FrameOS import: the dependency stack does not compile under Nimony yet.

import std/[strutils, tables]

when defined(nimony):
  import std/[syncio, parseutils]
  {.feature: "lenientnils".}

type
  NodeKind = enum nkText, nkNumber, nkGroup
  Node = ref object
    kind: NodeKind
    name: string
    number: float
    children: seq[Node]

proc newNode(kind: NodeKind, name: string): Node =
  Node(kind: kind, name: name, number: 0.0, children: @[])

proc parseNumber(text: string, ok: var bool): float =
  ## Both compilers' error path: Nim 2 raises an exception object with a
  ## message, Nimony an ErrorCode.
  result = 0.0
  ok = false
  when defined(nimony):
    var value = 0.0
    if parseFloat(text, value) == text.len and text.len > 0:
      ok = true
      result = value
  else:
    try:
      result = parseFloat(text)
      ok = true
    except ValueError:
      ok = false

proc build(spec: string): Node =
  result = newNode(nkGroup, "root")
  for part in spec.split(';'):
    let pieces = part.split('=')
    if pieces.len != 2:
      continue
    var ok = false
    let number = parseNumber(pieces[1].strip(), ok)
    if ok:
      let child = newNode(nkNumber, pieces[0].strip())
      child.number = number
      result.children.add child
    else:
      result.children.add newNode(nkText, pieces[0].strip() & ":" & pieces[1])

proc render(node: Node, counts: var Table[string, int]): string =
  result = ""
  # Nimony refuses `for child in node.children` through a ref (an alias
  # could change the seq during the loop): by index on both compilers.
  for i in 0 ..< node.children.len:
    let child = node.children[i]
    counts[child.name] = counts.getOrDefault(child.name, 0) + 1
    case child.kind
    of nkNumber: result.add child.name & "=" & $child.number & "\n"
    of nkText: result.add child.name.toUpperAscii() & "\n"
    of nkGroup: result.add render(child, counts)

proc probeRun(spec: cstring): cint {.exportc: "fos_probe_run", cdecl.} =
  var counts = initTable[string, int]()
  let root = build($spec)
  let text = render(root, counts)
  result = cint(text.len + counts.len)

when isMainModule:
  echo probeRun("width=800; height=480; name=frame; scale=1.5; width=640")
