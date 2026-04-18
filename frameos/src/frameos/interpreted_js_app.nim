import std/strutils
import json

import frameos/js_app_runtime
import frameos/types
import frameos/values

type
  InterpretedJsApp* = ref object of AppRoot
    keyword*: string
    configJson*: JsonNode
    appDefinition*: JsonNode
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

proc configNode(node: DiagramNode): JsonNode =
  if node.data.isNil or node.data.kind != JObject:
    return nil
  if not node.data.hasKey("config") or node.data["config"].kind != JObject:
    return nil
  node.data["config"]

proc appFields(appDefinition: JsonNode): JsonNode =
  if appDefinition.kind != JObject:
    return nil
  if not appDefinition.hasKey("fields") or appDefinition["fields"].kind != JArray:
    return nil
  appDefinition["fields"]

proc fieldName(field: JsonNode): string =
  if field.kind != JObject:
    return ""
  field{"name"}.getStr()

proc fieldType(field: JsonNode): string =
  if field.kind != JObject:
    return ""
  field{"type"}.getStr()

proc fieldValueNode(field: JsonNode): JsonNode =
  if field.kind == JObject and field.hasKey("value"):
    return field["value"]
  nil

proc findFieldByName(appDefinition: JsonNode, name: string): JsonNode =
  let fields = appFields(appDefinition)
  if fields.isNil:
    return nil
  for field in fields.items:
    if field.kind == JObject and fieldName(field) == name:
      return field
  nil

proc fieldSeq(field: JsonNode): JsonNode =
  if field.kind != JObject:
    return nil
  if not field.hasKey("seq") or field["seq"].kind != JArray or field["seq"].len == 0:
    return nil
  field["seq"]

proc parseBoolLoose(value: JsonNode, defaultValue = false): bool =
  if value.isNil:
    return defaultValue
  case value.kind
  of JBool:
    return value.getBool()
  of JString:
    let normalized = value.getStr().strip().toLowerAscii()
    return normalized in ["1", "true", "yes", "y"]
  else:
    return defaultValue

proc parseIntLoose(value: JsonNode, defaultValue = 0): int =
  if value.isNil:
    return defaultValue
  case value.kind
  of JInt:
    return value.getInt().int
  of JFloat:
    return int(value.getFloat())
  of JString:
    let normalized = value.getStr().strip()
    if normalized.len == 0:
      return defaultValue
    try:
      return parseInt(normalized)
    except CatchableError:
      try:
        return int(parseFloat(normalized))
      except CatchableError:
        return defaultValue
  else:
    return defaultValue

proc parseFloatLoose(value: JsonNode, defaultValue = 0.0): float =
  if value.isNil:
    return defaultValue
  case value.kind
  of JFloat:
    return value.getFloat()
  of JInt:
    return value.getInt().float
  of JString:
    let normalized = value.getStr().strip()
    if normalized.len == 0:
      return defaultValue
    try:
      return parseFloat(normalized)
    except CatchableError:
      return defaultValue
  else:
    return defaultValue

proc fieldDefaultValue(field: JsonNode): JsonNode =
  let rawValue = fieldValueNode(field)
  case fieldType(field)
  of "string", "text", "select", "font", "date", "scene":
    if not rawValue.isNil and rawValue.kind == JString:
      return %* rawValue.getStr()
    return %* ""
  of "integer", "node":
    return %* parseIntLoose(rawValue, 0)
  of "float":
    return %* parseFloatLoose(rawValue, 0.0)
  of "boolean":
    return %* parseBoolLoose(rawValue, false)
  of "image":
    return newJNull()
  of "json":
    return newJObject()
  of "color":
    if not rawValue.isNil and rawValue.kind == JString and rawValue.getStr().len > 0:
      return %* rawValue.getStr()
    return %* "#000000"
  else:
    if rawValue.isNil:
      return newJNull()
    return copy(rawValue)

proc fieldValueFromNode(field: JsonNode, rawValue: JsonNode): JsonNode =
  let defaultValue = fieldDefaultValue(field)
  case fieldType(field)
  of "string", "text", "select", "font", "date", "scene":
    if not rawValue.isNil and rawValue.kind == JString:
      return %* rawValue.getStr()
    return copy(defaultValue)
  of "integer", "node":
    return %* parseIntLoose(rawValue, parseIntLoose(defaultValue, 0))
  of "float":
    return %* parseFloatLoose(rawValue, parseFloatLoose(defaultValue, 0.0))
  of "boolean":
    return %* parseBoolLoose(rawValue, parseBoolLoose(defaultValue, false))
  of "image":
    return newJNull()
  of "json":
    if rawValue.isNil:
      return copy(defaultValue)
    return copy(rawValue)
  of "color":
    if not rawValue.isNil and rawValue.kind == JString and rawValue.getStr().len > 0:
      return %* rawValue.getStr()
    return copy(defaultValue)
  else:
    return copy(defaultValue)

proc seqBoundValue(bound: JsonNode, params: JsonNode, appDefinition: JsonNode, defaultIfRef: int): int =
  if bound.isNil:
    return defaultIfRef
  case bound.kind
  of JInt:
    return bound.getInt().int
  of JFloat:
    return int(bound.getFloat())
  of JString:
    let refName = bound.getStr()
    let refField = findFieldByName(appDefinition, refName)
    let defaultValue =
      if refField.isNil:
        defaultIfRef
      else:
        parseIntLoose(fieldValueNode(refField), defaultIfRef)
    if params.isNil or params.kind != JObject or not params.hasKey(refName):
      return defaultValue
    return parseIntLoose(params[refName], defaultValue)
  else:
    return defaultIfRef

proc seqStartsAndStops(field: JsonNode, params: JsonNode, appDefinition: JsonNode): tuple[starts: seq[int], stops: seq[int]] =
  let seqSpec = fieldSeq(field)
  if seqSpec.isNil:
    return (@[], @[])

  result.starts = @[]
  result.stops = @[]
  for dimension in seqSpec.items:
    if dimension.kind != JArray or dimension.len < 3:
      result.starts.add(1)
      result.stops.add(0)
      continue
    result.starts.add(seqBoundValue(dimension[1], params, appDefinition, 1))
    result.stops.add(seqBoundValue(dimension[2], params, appDefinition, 0))

proc buildSeqArray(field: JsonNode, starts: seq[int], stops: seq[int], level = 0): JsonNode =
  result = newJArray()
  if level >= starts.len or level >= stops.len:
    return result

  let size = max(0, stops[level] - starts[level] + 1)
  for _ in 0 ..< size:
    if level == starts.high:
      result.add(copy(fieldDefaultValue(field)))
    else:
      result.add(buildSeqArray(field, starts, stops, level + 1))

proc parseSeqIndexes(key: string, baseName: string, dims: int): seq[int] =
  if not key.startsWith(baseName):
    return @[]

  var idx = baseName.len
  while idx < key.len:
    if key[idx] != '[':
      return @[]
    inc idx
    let startIdx = idx
    while idx < key.len and key[idx] != ']':
      inc idx
    if idx >= key.len or idx == startIdx:
      return @[]
    try:
      result.add(parseInt(key[startIdx ..< idx]))
    except CatchableError:
      return @[]
    inc idx

  if result.len != dims:
    return @[]

proc setNestedValue(node: JsonNode, offsets: seq[int], level: int, value: JsonNode) =
  if level > offsets.high:
    return
  if level == offsets.high:
    node.elems[offsets[level]] = copy(value)
    return
  setNestedValue(node.elems[offsets[level]], offsets, level + 1, value)

proc buildSeqFieldConfig(field: JsonNode, params: JsonNode, appDefinition: JsonNode): JsonNode =
  let bounds = seqStartsAndStops(field, params, appDefinition)
  result = buildSeqArray(field, bounds.starts, bounds.stops)

  if params.isNil or params.kind != JObject:
    return result

  let baseName = fieldName(field)
  for key in params.keys:
    let indexes = parseSeqIndexes(key, baseName, bounds.starts.len)
    if indexes.len != bounds.starts.len:
      continue

    var offsets: seq[int] = @[]
    var valid = true
    for level, actualIndex in indexes:
      let size = max(0, bounds.stops[level] - bounds.starts[level] + 1)
      let offset = actualIndex - bounds.starts[level]
      if offset < 0 or offset >= size:
        valid = false
        break
      offsets.add(offset)

    if valid and offsets.len > 0:
      setNestedValue(result, offsets, 0, fieldValueFromNode(field, params[key]))

proc fieldBaseName(name: string): string =
  let bracketIdx = name.find('[')
  if bracketIdx < 0:
    return name
  name[0 ..< bracketIdx]

proc applyConfigValue(configJson: JsonNode, appDefinition: JsonNode, field: string, value: JsonNode) =
  let baseName = fieldBaseName(field)
  let fieldDefinition = findFieldByName(appDefinition, baseName)
  if fieldDefinition.isNil:
    configJson[field] = copy(value)
    return

  let seqSpec = fieldSeq(fieldDefinition)
  if seqSpec.isNil or field == baseName:
    configJson[baseName] = copy(value)
    return

  let indexes = parseSeqIndexes(field, baseName, seqSpec.len)
  if indexes.len != seqSpec.len:
    configJson[field] = copy(value)
    return

  let bounds = seqStartsAndStops(fieldDefinition, configJson, appDefinition)
  var offsets: seq[int] = @[]
  for level, actualIndex in indexes:
    let size = max(0, bounds.stops[level] - bounds.starts[level] + 1)
    let offset = actualIndex - bounds.starts[level]
    if offset < 0 or offset >= size:
      return
    offsets.add(offset)

  var seqValue =
    if configJson.hasKey(baseName) and configJson[baseName].kind == JArray:
      configJson[baseName]
    else:
      buildSeqFieldConfig(fieldDefinition, configJson, appDefinition)
  setNestedValue(seqValue, offsets, 0, value)
  configJson[baseName] = seqValue

proc buildInitialConfig(node: DiagramNode, appDefinition: JsonNode): JsonNode =
  let params = configNode(node)
  result = %*{}

  let fields = appFields(appDefinition)
  if not fields.isNil:
    for field in fields.items:
      if field.kind != JObject:
        continue
      let name = fieldName(field)
      if name.len == 0:
        continue
      let seqSpec = fieldSeq(field)
      if not seqSpec.isNil:
        result[name] = buildSeqFieldConfig(field, params, appDefinition)
      elif not params.isNil and params.hasKey(name):
        result[name] = fieldValueFromNode(field, params[name])
      else:
        result[name] = fieldDefaultValue(field)

  if not params.isNil:
    for key in params.keys:
      if result.hasKey(key) or '[' in key or ']' in key:
        continue
      result[key] = copy(params[key])

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
    appDefinition: appDefinition,
    runtime: newJsAppRuntime(category = category, outputType = outputType, source = source),
  )

proc setInterpretedJsAppField*(app: AppRoot, field: string, value: Value) =
  let jsApp = InterpretedJsApp(app)
  if jsApp.configJson.isNil or jsApp.configJson.kind != JObject:
    jsApp.configJson = %*{}
  applyConfigValue(jsApp.configJson, jsApp.appDefinition, field, jsApp.runtime.jsAppFieldToJson(value))

proc getInterpretedJsApp*(app: AppRoot, context: ExecutionContext): Value =
  let jsApp = InterpretedJsApp(app)
  jsApp.runtime.get(jsApp, jsApp.configJson, context)

proc runInterpretedJsApp*(app: AppRoot, context: ExecutionContext) =
  let jsApp = InterpretedJsApp(app)
  jsApp.runtime.run(jsApp, jsApp.configJson, context)
