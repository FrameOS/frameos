## Service keys on the frame (docs/service-keys.md "On the frame").
##
## Which key an app's `frameos.getSetting(service, field)` answers with, and
## the placeholders `frameos.secret` hands out, filled into a request on its
## way out. Pure apart from the keys typed on the frame (`localKeys`, kept by
## a host hook): the fixture runner (tests/test_service_keys.nim) replays
## docs/service-keys-fixtures.json `runtime` and `inject` against it.
##
## Three sources, for the app's own scene:
##   1. `localKeys[sceneId][service][field]`: typed on this frame, per field;
##   2. the config's `serviceKeys` (a plane's): `keys[scenes[sceneId][service]]`;
##   3. without `serviceKeys` (a frame with no plane, an older plane): the
##      config's `settings[service]`, as before.
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
  LocalKeysMaxBytes* = 8 * 1024
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

proc serviceGroup*(settings, serviceKeys, localKeys: JsonNode, sceneId, service: string): JsonNode =
  ## The scene's values for `service` (string fields only), what it typed on
  ## the frame over what it was given; nil when it has none.
  let base =
    if planeOwnsKeys(serviceKeys): boundValues(settings, serviceKeys, sceneId, service)
    else: settings.obj(service)
  let local = localKeys.obj(sceneId).obj(service)
  if base.isNil and local.isNil:
    return nil
  result = newJObject()
  for source in [base, local]:
    if source.isNil:
      continue
    for name, value in source.fields:
      if value.kind == JString and value.getStr().len > 0:
        result.fields[name] = newJString(value.getStr())
  if result.len == 0:
    result = nil

proc serviceValue*(settings, serviceKeys, localKeys: JsonNode, sceneId, service, field: string): string =
  let group = serviceGroup(settings, serviceKeys, localKeys, sceneId, service)
  if not group.isNil:
    result = group.fields.getOrDefault(field).getStr()

proc settingValue*(settings, serviceKeys, localKeys: JsonNode, sceneId: string,
    declared: openArray[string], path: openArray[string]): JsonNode =
  ## `frameos.getSetting(...path)`: nil (undefined) unless the app declares
  ## the service and its scene has a value there.
  if path.len == 0 or path[0] notin declared:
    return nil
  result = serviceGroup(settings, serviceKeys, localKeys, sceneId, path[0])
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

proc allowedFor(settings, serviceKeys, localKeys: JsonNode, sceneId, service: string,
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
    let value = serviceValue(settings, serviceKeys, localKeys, sceneId, service, fromField)
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

proc fill(text: string, inUrl: bool, settings, serviceKeys, localKeys: JsonNode, sceneId: string,
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
      let value = serviceValue(settings, serviceKeys, localKeys, sceneId, service, field)
      if value.len == 0:
        refused = "missing"
      elif not allowedFor(settings, serviceKeys, localKeys, sceneId, service, request):
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

proc fillKeys*(settings, serviceKeys, localKeys: JsonNode, sceneId: string, declared: openArray[string],
    url: string, headers: openArray[tuple[name, value: string]]): KeyRequest =
  ## A request with `frameos.secret` placeholders, filled for the app's
  ## scene; `refused` says why one may not go (docs/service-keys.md).
  result.url = url
  for header in headers:
    result.headers.add header
  if not hasPlaceholder(url, headers):
    return
  let request = originOf(url)
  result.url = fill(url, true, settings, serviceKeys, localKeys, sceneId, declared, request,
    result.refused, authorityEnd(url))
  if result.refused.len > 0:
    return
  for i in 0 ..< result.headers.len:
    if not result.headers[i].value.contains(Placeholder):
      continue
    let filled = fill(result.headers[i].value, false, settings, serviceKeys, localKeys, sceneId,
      declared, request, result.refused)
    if result.refused.len == 0 and result.headers[i].name.toLowerAscii() notin KeyHeaders:
      result.refused = "header"
    if result.refused.len > 0:
      result.url = ""
      result.headers.setLen(0)
      return
    result.headers[i].value = filled

# ------------------------------------------------------------ keys typed here

type
  LocalKeysLoad* = proc (): string {.nimcall, gcsafe.}
  LocalKeysSave* = proc (text: string): bool {.nimcall, gcsafe.}

var
  localKeysLoadHook*: LocalKeysLoad
  localKeysSaveHook*: LocalKeysSave
    ## Where a host keeps the keys typed on the frame: `state/local_keys.json`
    ## on a Pi (local_keys_linux below), the scene-state store on an ESP32
    ## (embedded_runtime.nim). None (the browser preview): nothing is kept.
  localKeysGeneration: int ## bumped by every save; a thread's copy reloads when it moves
  localKeysCache {.threadvar.}: JsonNode
  localKeysCacheGeneration {.threadvar.}: int

proc readLocalKeys(text: string): JsonNode =
  ## `{sceneId: {service: {field: value}}}`. Read as it is: every reader
  ## takes string values only (serviceGroup), and anything else is no key.
  if text.len > 0 and text.len <= LocalKeysMaxBytes:
    try:
      result = parseJson(text)
    except CatchableError:
      discard
  if result.isNil or result.kind != JObject:
    result = newJObject()

proc localKeys*(): JsonNode =
  ## The keys typed on this frame, as this thread last read them.
  {.cast(gcsafe).}:
    let generation = localKeysGeneration
    if localKeysCache.isNil or localKeysCacheGeneration != generation:
      localKeysCache = readLocalKeys(if localKeysLoadHook.isNil: "" else: localKeysLoadHook())
      localKeysCacheGeneration = generation
    localKeysCache

proc setLocalKey*(sceneId, service, field, value: string): bool =
  ## Keeps (or with "" forgets) one typed value; with no field, forgets
  ## every one typed for the service. False when it would not fit or the
  ## host could not keep it.
  if sceneId.len == 0 or not isServiceId(service) or (field.len > 0 and not isFieldName(field)):
    return false
  let all = copy(localKeys())
  var scene = all.obj(sceneId)
  if scene.isNil:
    scene = newJObject()
    all.fields[sceneId] = scene
  var group = scene.obj(service)
  if group.isNil:
    group = newJObject()
    scene.fields[service] = group
  if field.len == 0: group.fields.clear()
  elif value.len == 0: group.delete(field)
  else: group.fields[field] = newJString(value)
  if group.len == 0: scene.delete(service)
  if scene.len == 0: all.delete(sceneId)
  let text = $all
  if text.len > LocalKeysMaxBytes:
    return false
  {.cast(gcsafe).}:
    if localKeysSaveHook.isNil or not localKeysSaveHook(text):
      return false
    inc localKeysGeneration
  true

proc forgetLocalKeysCache*() =
  ## Read the host's store again (a test that swapped the hooks).
  {.cast(gcsafe).}:
    inc localKeysGeneration

when not defined(frameosEmbedded) and not defined(frameosWasm):
  import std/[os, posix]

  const LocalKeysPath* = "./state/local_keys.json"

  proc loadLocalKeysFile(): string {.nimcall, gcsafe.} =
    try:
      if fileExists(LocalKeysPath) and getFileSize(LocalKeysPath) <= LocalKeysMaxBytes:
        result = readFile(LocalKeysPath)
    except CatchableError:
      discard

  proc saveLocalKeysFile(text: string): bool {.nimcall, gcsafe.} =
    ## Born 0600 and renamed into place: the owner's keys.
    try:
      createDir(parentDir(LocalKeysPath))
      let temp = LocalKeysPath & ".tmp"
      let fd = posix.open(temp.cstring, O_WRONLY or O_CREAT or O_TRUNC, 0o600)
      if fd < 0:
        return false
      discard fchmod(fd, 0o600)
      var written = 0
      while written < text.len:
        let n = posix.write(fd, unsafeAddr text[written], text.len - written)
        if n <= 0:
          discard posix.close(fd)
          return false
        written += n
      discard posix.close(fd)
      moveFile(temp, LocalKeysPath)
      true
    except CatchableError:
      false

  localKeysLoadHook = loadLocalKeysFile
  localKeysSaveHook = saveLocalKeysFile

# ------------------------------------------------------------- the Keys page

proc keyRows*(settings, serviceKeys: JsonNode, sceneId: string, declared: openArray[string]): JsonNode =
  ## What the scene settings' Keys section shows for a scene: each service its
  ## apps declare, with its title, whether something was typed for it here,
  ## and each field (the plane's list of them, else those it holds, else an
  ## `apiKey`) with its label, whether it is secret, and what it holds now —
  ## never a whole secret: its last four characters.
  result = newJArray()
  let local = localKeys()
  for service in declared:
    if not isServiceId(service):
      continue
    let
      spec = serviceKeys.obj("services").obj(service)
      group = serviceGroup(settings, serviceKeys, local, sceneId, service)
      row = newJObject()
      fields = newJArray()
    row.fields["service"] = newJString(service)
    row.fields["title"] = newJString(if spec.isNil: service else: spec{"title"}.getStr(service))
    row.fields["typed"] = newJBool(not local.obj(sceneId).obj(service).isNil)
    var names: seq[string]
    let listed = if spec.isNil: nil else: spec.fields.getOrDefault("fields")
    if not listed.isNil and listed.kind == JArray:
      for f in listed.elems:
        names.add f{"name"}.getStr()
    elif not group.isNil:
      for name in group.fields.keys:
        names.add name
    if names.len == 0:
      names.add "apiKey"
    for i, name in names:
      let
        spec = if listed.isNil or listed.kind != JArray: nil else: listed.elems[i]
        secret = spec.isNil or spec{"secret"}.getBool(true)
        value = if group.isNil: "" else: group{name}.getStr()
        f = newJObject()
      f.fields["name"] = newJString(name)
      f.fields["label"] = newJString(if spec.isNil: name else: spec{"label"}.getStr(name))
      f.fields["secret"] = newJBool(secret)
      f.fields["value"] = newJString(
        if value.len == 0 or not secret: value
        elif value.len > 8: "\xe2\x80\xa2\xe2\x80\xa2\xe2\x80\xa2\xe2\x80\xa2" & value[^4 .. ^1]
        else: "\xe2\x80\xa2\xe2\x80\xa2\xe2\x80\xa2\xe2\x80\xa2")
      fields.elems.add f
    row.fields["fields"] = fields
    result.elems.add row
