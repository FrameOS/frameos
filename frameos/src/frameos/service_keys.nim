## Service keys on the frame (docs/service-keys.md "On the frame").
##
## Which key an app's `frameos.getSetting(service, field)` answers with, and
## the placeholders `frameos.secret` hands out, filled into a request on its
## way out. Pure: the keys typed on the frame come in as `typed` (the frame
## page's, frame_service_keys.serviceKeysTyped), so the fixture runner
## (tests/test_service_keys.nim) replays docs/service-keys-fixtures.json
## `runtime` and `inject` against it.
##
## For the app's own scene:
##   1. the config's `serviceKeys` (a plane's): `keys[scenes[sceneId][service]]`,
##      a `null` there refused (and nothing below changes that);
##   2. without `serviceKeys` (a frame with no plane, an older plane): the
##      config's `settings[service]`, as before;
##   3. over either, the keys typed on the frame (`typed[service]`), field by
##      field; an address typed there takes the group whole, so a plane's key
##      never goes to an address somebody at the frame typed.
## No list of services anywhere: any id matching the pattern is one.

import std/[json, strutils, tables]

const
  PlaneSettingsGroups* = ["buildEnvironment", "buildHost", "defaults", "modalSandbox", "personal",
    "posthog", "repositories", "serviceCredentials", "ssh_keys", "serviceKeys", "serviceSettings"]
    ## A plane's own settings groups, and the two names the wire keeps beside
    ## the groups: never a service (repo/services.json's generator keeps the
    ## same list).
  KeyHeaders = ["authorization", "proxy-authorization", "cookie", "x-api-key"]
    ## The headers a key may be put in: those the HTTP clients drop when a
    ## redirect leaves the origin (http_client.CrossOriginHeaders, the ESP32
    ## glue's s_cross_origin_headers), so a key never follows one elsewhere.
  Placeholder = "{{key:"

proc isNameChars(s: string, first, last: int): bool =
  if last < first or not (s[first] in {'A'..'Z', 'a'..'z'}):
    return false
  for i in first + 1 .. last:
    if s[i] notin {'A'..'Z', 'a'..'z', '0'..'9', '_'}:
      return false
  true

proc isFieldName*(s: string): bool =
  s.len in 1..41 and isNameChars(s, 0, s.high)

proc isCredentialId(s: string): bool =
  if s.len < 10 or s.len > 26 or not s.startsWith("k_"):
    return false
  for i in 2 ..< s.len:
    if s[i] notin {'a'..'z', '0'..'9'}:
      return false
  true

proc isServiceId*(s: string): bool =
  ## `^[A-Za-z][A-Za-z0-9_]{0,40}$`, never a credential id, never a plane's group.
  isFieldName(s) and not isCredentialId(s) and s notin PlaneSettingsGroups

proc obj(node: JsonNode, key: string): JsonNode {.inline.} =
  result = if node.isNil or node.kind != JObject: nil else: node.fields.getOrDefault(key)
  if not result.isNil and result.kind != JObject:
    result = nil

proc boundValues(settings, serviceKeys: JsonNode, sceneId, service: string): JsonNode =
  ## The values the plane bound to this scene for `service`; nil for none
  ## (a refused one). A key the plane names but has no value for falls back
  ## to the frame's own `settings[service]`: what a Pi's admin page keeps.
  let scene = serviceKeys.obj("scenes").obj(sceneId)
  if scene.isNil:
    return nil
  let id = scene.fields.getOrDefault(service)
  if id.isNil or id.kind != JString:
    return nil
  result = serviceKeys.obj("keys").obj(id.getStr()).obj("values")
  if result.isNil:
    result = settings.obj(service)

proc planeOwnsKeys*(serviceKeys: JsonNode): bool {.inline.} =
  ## The config came from a plane that says which scene gets which key.
  not serviceKeys.obj("scenes").isNil

proc addressField(serviceKeys: JsonNode, service: string): string =
  ## The service's field that holds where its keys go: the plane's
  ## `hostsFrom`, else `url`.
  let spec = serviceKeys.obj("services").obj(service)
  result = if spec.isNil: "" else: spec.fields.getOrDefault("hostsFrom").getStr()
  if result.len == 0:
    result = "url"

proc serviceGroup*(settings, serviceKeys, typed: JsonNode, sceneId, service: string): JsonNode =
  ## The scene's values for `service` (string fields only), what was typed on
  ## the frame over what the plane gave it; nil when it has none.
  var base: JsonNode
  if planeOwnsKeys(serviceKeys):
    let scene = serviceKeys.obj("scenes").obj(sceneId)
    let id = if scene.isNil: nil else: scene.fields.getOrDefault(service)
    if not id.isNil and id.kind == JNull:
      return nil # the owner refused it this scene: a key typed here does not change that
    base = boundValues(settings, serviceKeys, sceneId, service)
  else:
    base = settings.obj(service)
  let own = typed.obj(service)
  if not own.isNil and own.fields.getOrDefault(addressField(serviceKeys, service)).getStr().len > 0:
    base = nil
  if base.isNil and own.isNil:
    return nil
  result = newJObject()
  for source in [base, own]:
    if source.isNil:
      continue
    for name, value in source.fields:
      if value.kind == JString and value.getStr().len > 0:
        result.fields[name] = newJString(value.getStr())
  if result.len == 0:
    result = nil

proc serviceValue*(settings, serviceKeys, typed: JsonNode, sceneId, service, field: string): string =
  let group = serviceGroup(settings, serviceKeys, typed, sceneId, service)
  if not group.isNil:
    result = group.fields.getOrDefault(field).getStr()

proc settingValue*(settings, serviceKeys, typed: JsonNode, sceneId: string,
    declared: openArray[string], path: openArray[string]): JsonNode =
  ## `frameos.getSetting(...path)`: nil (undefined) unless the app declares
  ## the service and its scene has a value there.
  if path.len == 0 or path[0] notin declared:
    return nil
  result = serviceGroup(settings, serviceKeys, typed, sceneId, path[0])
  for i in 1 ..< path.len:
    if result.isNil or result.kind != JObject:
      return nil
    result = result.fields.getOrDefault(path[i])

# ---------------------------------------------------------------- frameos.secret

proc placeholder*(service, field: string): string =
  Placeholder & service & "." & field & "}}"

type
  Origin = tuple[scheme, host, port: string]
  KeyRequest* = object
    refused*: string ## "" when the request may go; else the reason
    url*: string
    headers*: seq[tuple[name, value: string]]

proc authorityEnd(url: string): int =
  ## Where the path (or query) starts: a placeholder before it is in the
  ## scheme or the authority.
  let scheme = url.find("://")
  if scheme < 0:
    return url.len
  result = scheme + 3
  while result < url.len and url[result] notin {'/', '?', '#'}:
    inc result

proc originOf(url: string): Origin =
  ## scheme, host (lowercase, user-info dropped) and port (the scheme's
  ## default when none is named) of an http(s) URL; an empty host for
  ## anything else. Read by hand: std/uri is 2 KB of an ESP32's flash.
  let scheme = url.find("://")
  if scheme <= 0:
    return
  result.scheme = url[0 ..< scheme].toLowerAscii()
  var authority = url[scheme + 3 ..< authorityEnd(url)]
  let at = authority.rfind('@')
  if at >= 0:
    authority = authority[at + 1 .. ^1]
  var colon = authority.rfind(':')
  if colon >= 0 and authority.rfind(']') > colon:
    colon = -1 # inside an IPv6 literal
  if colon >= 0:
    result.port = authority[colon + 1 .. ^1]
    authority.setLen(colon)
  result.host = authority.toLowerAscii()
  if result.port.len == 0:
    result.port = if result.scheme == "https": "443" elif result.scheme == "http": "80" else: ""
  if result.scheme notin ["http", "https"]:
    result.host = ""

proc originText*(url: string): string =
  ## `scheme://host[:port]`, what an error may name of a URL.
  let o = originOf(url)
  if o.host.len == 0: "" else: o.scheme & "://" & o.host & ":" & o.port

proc allowedFor(settings, serviceKeys, typed: JsonNode, sceneId, service: string,
    request: Origin): bool =
  ## A plane's `services[service]` `hosts` (https, the default port unless
  ## one is named) or the exact origin of its `hostsFrom` field's value. With
  ## no plane, any origin.
  if not planeOwnsKeys(serviceKeys):
    return true
  if request.host.len == 0:
    return false
  let spec = serviceKeys.obj("services").obj(service)
  if spec.isNil:
    return false
  let hosts = spec.fields.getOrDefault("hosts")
  if not hosts.isNil and hosts.kind == JArray and request.scheme == "https":
    for entry in hosts.elems:
      let text = entry.getStr().toLowerAscii()
      let colon = text.find(':')
      let (host, port) = if colon < 0: (text, "443") else: (text[0 ..< colon], text[colon + 1 .. ^1])
      if host.len > 0 and host == request.host and port == request.port:
        return true
  let fromField = spec.fields.getOrDefault("hostsFrom").getStr()
  if fromField.len > 0:
    let value = serviceValue(settings, serviceKeys, typed, sceneId, service, fromField)
    if value.len > 0:
      let own = originOf(value)
      if own.host.len > 0 and own == request:
        return true
  false

proc encodeComponent(value: string): string =
  ## Everything but RFC 3986's unreserved characters, percent-encoded.
  const hex = "0123456789ABCDEF"
  for c in value:
    if c in {'A'..'Z', 'a'..'z', '0'..'9', '-', '.', '_', '~'}:
      result.add c
    else:
      result.add '%'
      result.add hex[c.uint8 shr 4]
      result.add hex[c.uint8 and 15]

proc fill(text: string, inUrl: bool, settings, serviceKeys, typed: JsonNode, sceneId: string,
    declared: openArray[string], request: Origin, refused: var string, limit = -1): string =
  ## `text` with its placeholders filled. `limit`: in a URL, where the
  ## authority ends (a placeholder before it is refused).
  var i = 0
  while i < text.len:
    let at = text.find(Placeholder, i)
    if at < 0:
      result.add text[i .. ^1]
      break
    let close = text.find("}}", at + Placeholder.len)
    let dot = text.find('.', at + Placeholder.len)
    if close < 0 or dot < 0 or dot > close:
      result.add text[i .. ^1]
      break
    let
      service = text[at + Placeholder.len ..< dot]
      field = text[dot + 1 ..< close]
    if not isServiceId(service) or not isFieldName(field):
      # Not one of ours: left as it is.
      result.add text[i ..< close + 2]
      i = close + 2
      continue
    if service notin declared:
      refused = "undeclared"
    elif inUrl and at < limit:
      refused = "placement"
    else:
      let value = serviceValue(settings, serviceKeys, typed, sceneId, service, field)
      if value.len == 0:
        refused = "missing"
      elif not allowedFor(settings, serviceKeys, typed, sceneId, service, request):
        refused = "host"
      elif inUrl:
        result.add text[i ..< at]
        result.add encodeComponent(value)
      else:
        for c in value:
          if c.uint8 < 0x20 or c.uint8 == 0x7F:
            refused = "value"
        result.add text[i ..< at]
        result.add value
    if refused.len > 0:
      return ""
    i = close + 2

proc hasPlaceholder*(url: string, headers: openArray[tuple[name, value: string]]): bool =
  if url.contains(Placeholder):
    return true
  for header in headers:
    if header.value.contains(Placeholder):
      return true

proc fillKeys*(settings, serviceKeys, typed: JsonNode, sceneId: string, declared: openArray[string],
    url: string, headers: openArray[tuple[name, value: string]]): KeyRequest =
  ## A request with `frameos.secret` placeholders, filled for the app's
  ## scene; `refused` says why one may not go (docs/service-keys.md).
  result.url = url
  for header in headers:
    result.headers.add header
  if not hasPlaceholder(url, headers):
    return
  let request = originOf(url)
  result.url = fill(url, true, settings, serviceKeys, typed, sceneId, declared, request,
    result.refused, authorityEnd(url))
  if result.refused.len > 0:
    return
  for i in 0 ..< result.headers.len:
    if not result.headers[i].value.contains(Placeholder):
      continue
    let filled = fill(result.headers[i].value, false, settings, serviceKeys, typed, sceneId,
      declared, request, result.refused)
    if result.refused.len == 0 and result.headers[i].name.toLowerAscii() notin KeyHeaders:
      result.refused = "header"
    if result.refused.len > 0:
      result.url = ""
      result.headers.setLen(0)
      return
    result.headers[i].value = filled
