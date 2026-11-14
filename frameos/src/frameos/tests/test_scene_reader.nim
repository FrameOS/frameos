## The scene reader (interpreter.nim, "Reading scenes.json") against the
## jsony parse it replaced (2026-11-14): every repo and e2e scene, and a few
## hand-made shapes, read both ways and compared field by field. The jsony
## hooks below are the ones the runtime used, kept here as the reference.

import std/[json, os, strutils, unittest]
import chroma
import jsony

import ../interpreter
import ../types

# ---- the reference: jsony and its hooks, as interpreter.nim had them ----

proc renameHook(v: var DiagramNode, fieldName: var string) =
  if fieldName == "type":
    fieldName = "nodeType"

proc renameHook(v: var DiagramEdge, fieldName: var string) =
  if fieldName == "type":
    fieldName = "edgeType"

proc renameHook(v: var StateField, fieldName: var string) =
  if fieldName == "type":
    fieldName = "fieldType"

var lastParsedNodeIdSource: tuple[source: string, id: NodeId]

proc parseHook(s: string, i: var int, v: var NodeId) =
  var str: string
  parseHook(s, i, str)
  v = mapSourceNodeId(str)
  lastParsedNodeIdSource = (str, v)

proc postHook(v: var DiagramNode) =
  if lastParsedNodeIdSource.id == v.id and lastParsedNodeIdSource.source.len > 0:
    if v.data.isNil or v.data.kind != JObject:
      v.data = newJObject()
    if not v.data.hasKey("__frameosSourceNodeId"):
      v.data["__frameosSourceNodeId"] = %lastParsedNodeIdSource.source

type RawStateFieldOption = object
  value: string
  label: string

proc parseHook(s: string, i: var int, v: var StateFieldOption) =
  eatSpace(s, i)
  if i < s.len and s[i] == '{':
    var raw: RawStateFieldOption
    parseHook(s, i, raw)
    v = StateFieldOption(value: raw.value, label: if raw.label != "": raw.label else: raw.value)
  elif i < s.len and s[i] == '"':
    var tmp: string
    parseHook(s, i, tmp)
    v = StateFieldOption(value: tmp, label: tmp)
  elif i < s.len and s[i] == '[':
    skipValue(s, i)
    v = StateFieldOption()
  else:
    let symbol = parseSymbol(s, i)
    let value = if symbol == "null": "" else: symbol
    v = StateFieldOption(value: value, label: value)

proc parseHook(s: string, i: var int, v: var SceneId) =
  var tmp: string
  parseHook(s, i, tmp)
  v = SceneId(tmp)

proc parseHook(s: string, i: var int, v: var SplitLayoutMarker) =
  eatSpace(s, i)
  v.present = i < s.len and s[i] == '{'
  skipValue(s, i)

proc parseHook(s: string, i: var int, v: var Color) =
  var tmp: string
  parseHook(s, i, tmp)
  v = parseHtmlColor(tmp)

proc jsonyRead(data: string): seq[FrameSceneInput] =
  data.fromJson(seq[FrameSceneInput])

# ---- the comparison ----

proc same(a, b: JsonNode, what: string): bool =
  if a.isNil or b.isNil:
    if a.isNil != b.isNil:
      echo what, ": one side is nil"
      return false
    return true
  if a != b or $a != $b:
    echo what, ": ", ($a)[0 ..< min(200, ($a).len)], " != ", ($b)[0 ..< min(200, ($b).len)]
    return false
  true

proc sameScenes(a, b: seq[FrameSceneInput], where: string): bool =
  result = true
  template differs(what: string, x, y: untyped) =
    if x != y:
      echo where, " ", what, ": ", x, " != ", y
      result = false
  differs("scene count", a.len, b.len)
  if a.len != b.len:
    return
  for s in 0 ..< a.len:
    let (x, y) = (a[s], b[s])
    let at = where & " scene " & $s
    differs(at & " id", x.id.string, y.id.string)
    differs(at & " name", x.name, y.name)
    differs(at & " nodes", x.nodes.len, y.nodes.len)
    differs(at & " edges", x.edges.len, y.edges.len)
    differs(at & " fields", x.fields.len, y.fields.len)
    if not result:
      return
    for n in 0 ..< x.nodes.len:
      differs(at & " node id", x.nodes[n].id.int, y.nodes[n].id.int)
      differs(at & " node type", x.nodes[n].nodeType, y.nodes[n].nodeType)
      result = same(x.nodes[n].data, y.nodes[n].data, at & " node data") and result
    for e in 0 ..< x.edges.len:
      let (p, q) = (x.edges[e], y.edges[e])
      differs(at & " edge id", p.id.int, q.id.int)
      differs(at & " edge source", p.source.int, q.source.int)
      differs(at & " edge target", p.target.int, q.target.int)
      differs(at & " edge sourceHandle", p.sourceHandle, q.sourceHandle)
      differs(at & " edge targetHandle", p.targetHandle, q.targetHandle)
      differs(at & " edge type", p.edgeType, q.edgeType)
      result = same(p.data, q.data, at & " edge data") and result
    for f in 0 ..< x.fields.len:
      let (p, q) = (x.fields[f], y.fields[f])
      differs(at & " field name", p.name, q.name)
      differs(at & " field label", p.label, q.label)
      differs(at & " field type", p.fieldType, q.fieldType)
      differs(at & " field options", $p.options, $q.options)
      differs(at & " field placeholder", p.placeholder, q.placeholder)
      differs(at & " field required", p.required, q.required)
      differs(at & " field secret", p.secret, q.secret)
      differs(at & " field persist", p.persist, q.persist)
      differs(at & " field access", p.access, q.access)
      differs(at & " field role", p.role, q.role)
      result = same(p.value, q.value, at & " field value") and result
      result = same(p.showIf, q.showIf, at & " field showIf") and result
    differs(at & " settings", x.settings.isNil, y.settings.isNil)
    if not x.settings.isNil and not y.settings.isNil:
      differs(at & " backgroundColor", x.settings.backgroundColor, y.settings.backgroundColor)
      differs(at & " refreshInterval", x.settings.refreshInterval, y.settings.refreshInterval)
      differs(at & " renderScale", x.settings.renderScale, y.settings.renderScale)
      differs(at & " splitScreenLayout", x.settings.splitScreenLayout.present,
        y.settings.splitScreenLayout.present)
      differs(at & " isLayout", x.settings.isLayout, y.settings.isLayout)
    result = same(x.apps, y.apps, at & " apps") and result
    result = same(x.origin, y.origin, at & " origin") and result
    result = same(x.customEvents, y.customEvents, at & " customEvents") and result
    result = same(x.eventMap, y.eventMap, at & " eventMap") and result
    result = same(x.layout, y.layout, at & " layout") and result

proc corpus(): seq[tuple[name, json: string]] =
  for path in walkDirRec("../repo/scenes"):
    if path.extractFilename == "scenes.json":
      result.add((path, readFile(path)))
  for path in walkDir("../e2e/scenes"):
    if path.path.endsWith(".json"):
      let text = readFile(path.path)
      result.add((path.path, if text.strip().startsWith("["): text else: "[" & text & "]"))

suite "scene reader":
  test "reads every repo and e2e scene as jsony did":
    let scenes = corpus()
    check scenes.len > 100
    var nodes = 0
    for (name, text) in scenes:
      # The reader first: it numbers the node ids, and jsony reads the same
      # names back to the same numbers only if both walk them in one order.
      let ours = parseInterpretedSceneInputs(text)
      let theirs = jsonyRead(text)
      check sameScenes(ours, theirs, name)
      for scene in ours:
        nodes += scene.nodes.len
    check nodes > 1000

  test "numbers node ids in document order":
    let text = """[{"id": "s", "nodes": [{"id": "order-b"}, {"id": "order-a"}],
      "edges": [{"target": "order-c", "id": "order-e", "source": "order-b"}]}]"""
    let scenes = parseInterpretedSceneInputs(text)
    let b = scenes[0].nodes[0].id.int
    check scenes[0].nodes[1].id.int == b + 1
    check scenes[0].edges[0].target.int == b + 2
    check scenes[0].edges[0].id.int == b + 3
    check scenes[0].edges[0].source.int == b

  test "same as jsony on the shapes it took":
    let shapes = [
      # snake_case keys, a repeated key, nulls where JSON is kept
      """[{"id": "a", "name": "first", "name": "second", "custom_events": [{"name": "x"}],
         "event_map": null, "layout": {"sceneId": "l"},
         "settings": {"background_color": "#ff0000", "refresh_interval": 2, "render_scale": 1.5,
           "split_screen_layout": {"x": 1}, "is_layout": true},
         "nodes": [{"id": "n1", "type": "app", "data": null}, {"id": "n2", "node_type": "code"},
           {"id": "n3", "data": {"__frameosSourceNodeId": "kept"}}, {"data": {"keyword": "x"}}],
         "edges": [{"id": "e1", "source": "n1", "target": "n2", "source_handle": "next",
           "target_handle": "prev", "edge_type": "appNodeEdge", "data": {"a": [1, 2.5, "3"]}}],
         "fields": [{"name": "f", "field_type": "select", "value": null, "show_if": [{"field": "g"}],
           "options": ["a", {"value": "b"}, {"value": "c", "label": "C"}, 12, true, null, ["x"]],
           "required": true, "secret": false}]}]""",
      # settings null, no lists
      """[{"id": "b", "settings": null}]""",
      "[]",
    ]
    for shape in shapes:
      check sameScenes(parseInterpretedSceneInputs(shape), jsonyRead(shape), shape[0 ..< min(20, shape.len)])

  test "takes the default where jsony refused the scene":
    let scenes = parseInterpretedSceneInputs(
      """[{"id": 5, "name": null, "nodes": null, "edges": [null, 3], "fields": {},
          "settings": {"refreshInterval": "10", "isLayout": 1}}]""")
    check scenes.len == 1
    check scenes[0].id.string == "5" # a number reads as it is written
    check scenes[0].name == ""
    check scenes[0].nodes.len == 0
    check scenes[0].edges.len == 0
    check scenes[0].fields.len == 0
    check scenes[0].settings.refreshInterval == 0.0
    check not scenes[0].settings.isLayout

  test "still refuses what jsony refused":
    expect CatchableError:
      discard parseInterpretedSceneInputs("""{"id": "not a list"}""")
    expect CatchableError:
      discard parseInterpretedSceneInputs("""null""")
    expect CatchableError:
      discard parseInterpretedSceneInputs("""[{"id": "x", "settings": {"backgroundColor": "nope"}}]""")

  test "raises on broken JSON instead of looping":
    for broken in ["""[{"id": "x", "nodes": [}]""", """[{"id": "x", "nodes": [{"id": "n"""",
        """[{"id": "x"""", """[{"id": "x"]""", """[{"id": "x", "fields": [{"options": [1, }]}]"""]:
      expect CatchableError:
        discard parseInterpretedSceneInputs(broken)
