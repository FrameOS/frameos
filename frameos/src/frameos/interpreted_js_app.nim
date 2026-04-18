import std/strutils
import json

import frameos/js_app_runtime
import frameos/types
import frameos/values

type
  InterpretedJsApp* = ref object of AppRoot
    keyword*: string
    configJson*: JsonNode
    runtime*: JsAppRuntime

proc sourcesNode(node: DiagramNode): JsonNode =
  if node.data.isNil or node.data.kind != JObject:
    return nil
  if not node.data.hasKey("sources") or node.data["sources"].kind != JObject:
    return nil
  node.data["sources"]

proc sourceText(sources: JsonNode, filename: string): string =
  if sources.isNil or sources.kind != JObject or not sources.hasKey(filename):
    return ""
  if sources[filename].kind != JString:
    return ""
  sources[filename].getStr()

proc parseAppDefinition(node: DiagramNode): JsonNode =
  let configSource = sourceText(sourcesNode(node), "config.json")
  if configSource.len == 0:
    return %*{}
  try:
    return parseJson(configSource)
  except CatchableError:
    return %*{}

proc categoryFromKeyword(keyword: string): string =
  if keyword.contains("/"):
    return keyword.split("/", maxsplit = 1)[0].toLowerAscii()
  return ""

proc getCategory(configJson: JsonNode, keyword: string): string =
  let category = configJson{"category"}.getStr()
  if category.len > 0:
    return category.toLowerAscii()
  return categoryFromKeyword(keyword)

proc getOutputType(configJson: JsonNode, category: string): string =
  if category == "render":
    return "image"
  if configJson.hasKey("output") and configJson["output"].kind == JArray and configJson["output"].len > 0:
    let first = configJson["output"][0]
    if first.kind == JObject:
      return first{"type"}.getStr()
  return ""

proc buildInitialConfig(node: DiagramNode, appDefinition: JsonNode): JsonNode =
  result = %*{}
  if appDefinition.kind == JObject and appDefinition.hasKey("fields") and appDefinition["fields"].kind == JArray:
    for field in appDefinition["fields"].items:
      if field.kind != JObject:
        continue
      let name = field{"name"}.getStr()
      if name.len == 0 or not field.hasKey("value"):
        continue
      result[name] = copy(field["value"])

  if node.data.hasKey("config") and node.data["config"].kind == JObject:
    for key in node.data["config"].keys:
      result[key] = copy(node.data["config"][key])

proc getJsSource(node: DiagramNode): string =
  let sources = sourcesNode(node)
  for filename in ["app.compiled.js", "app.js", "app.ts"]:
    let source = sourceText(sources, filename)
    if source.len > 0:
      return source
  return ""

proc hasInterpretedJsSources*(node: DiagramNode): bool =
  getJsSource(node).len > 0

proc initInterpretedJsApp*(node: DiagramNode, scene: FrameScene): AppRoot =
  let keyword = node.data{"keyword"}.getStr()
  let source = getJsSource(node)
  if source.len == 0:
    raise newException(ValueError, "Forked JS app is missing source code")

  let appDefinition = parseAppDefinition(node)
  let category = getCategory(appDefinition, keyword)
  let outputType = getOutputType(appDefinition, category)

  InterpretedJsApp(
    nodeId: node.id,
    nodeName: node.data{"name"}.getStr(keyword),
    scene: scene,
    frameConfig: scene.frameConfig,
    keyword: keyword,
    configJson: buildInitialConfig(node, appDefinition),
    runtime: newJsAppRuntime(category = category, outputType = outputType, source = source),
  )

proc setInterpretedJsAppField*(app: AppRoot, field: string, value: Value) =
  let jsApp = InterpretedJsApp(app)
  if jsApp.configJson.isNil or jsApp.configJson.kind != JObject:
    jsApp.configJson = %*{}
  jsApp.configJson[field] = valueToJson(value)

proc getInterpretedJsApp*(app: AppRoot, context: ExecutionContext): Value =
  let jsApp = InterpretedJsApp(app)
  jsApp.runtime.get(jsApp, jsApp.configJson, context)

proc runInterpretedJsApp*(app: AppRoot, context: ExecutionContext) =
  let jsApp = InterpretedJsApp(app)
  jsApp.runtime.run(jsApp, jsApp.configJson, context)
