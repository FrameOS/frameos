import frameos/types
import std/[json, strtabs, strutils, xmlparser, xmltree]

proc xmlNodeToJson(node: XmlNode): JsonNode =
  case node.kind
  of xnElement:
    var element = newJObject()
    element["type"] = newJString("element")
    element["name"] = newJString(node.tag)

    var attributes = newJObject()
    let attrs = node.attrs
    if not attrs.isNil:
      for key, value in pairs(attrs):
        attributes[key] = newJString(value)
    element["attributes"] = attributes

    var children = newJArray()
    for child in items(node):
      let childJson = xmlNodeToJson(child)
      if childJson.kind != JNull:
        children.add(childJson)
    element["children"] = children

    result = element
  of xnText, xnVerbatimText:
    let textValue = node.text
    if textValue.strip.len == 0:
      result = newJNull()
    else:
      var textNode = newJObject()
      textNode["type"] = newJString("text")
      textNode["text"] = newJString(textValue)
      result = textNode
  of xnCData:
    var cdataNode = newJObject()
    cdataNode["type"] = newJString("cdata")
    cdataNode["text"] = newJString(node.text)
    result = cdataNode
  of xnComment:
    var commentNode = newJObject()
    commentNode["type"] = newJString("comment")
    commentNode["text"] = newJString(node.text)
    result = commentNode
  of xnEntity:
    var entityNode = newJObject()
    entityNode["type"] = newJString("entity")
    entityNode["text"] = newJString(node.text)
    result = entityNode

proc toJsonTree(xml: string): JsonNode =
  let document = parseXml(xml)
  if document.isNil:
    return newJNull()

  let jsonDoc = xmlNodeToJson(document)
  if jsonDoc.kind == JNull:
    return newJNull()

  result = newJObject()
  result["type"] = newJString("document")
  result["root"] = jsonDoc

type
  AppConfig* = object
    xml*: string

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc get*(self: App, context: ExecutionContext): JsonNode =
  try:
    result = toJsonTree(self.appConfig.xml)
  except XmlError as err:
    raise newException(ValueError, "Failed to parse XML: " & err.msg)
