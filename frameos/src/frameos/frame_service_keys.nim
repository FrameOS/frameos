## Service keys typed on the frame itself, on the frame page's Service keys
## (system/sceneSettings, docs/scene-settings.md "Service keys"). They are
## the frame's own: the host keeps them (a Pi's state/service_keys.json, an
## ESP32's NVS) and no control plane is told. Field by field they win over
## the keys a plane sends, an address with its group whole, for every scene
## the owner did not refuse that key: service_keys.nim `serviceGroup`, which
## `frameos.getSetting` and `frameos.secret` read through (docs/service-keys.md
## "Typing a key on the frame").

import std/[json, tables]

const MaxServiceKeysBytes* = 4096
  ## The most a host keeps: eight keys of a few hundred bytes each.

var
  serviceKeysLoad*: proc(): string {.nimcall, gcsafe, raises: [].}
    ## The keys as the host kept them, `{group: {field: value}}` as JSON text,
    ## "" for none. nil where the host keeps none (the browser, a plane's
    ## render of a board): there the frame page offers no Service keys.
  serviceKeysSave*: proc(text: string): bool {.nimcall, gcsafe, raises: [].}
    ## Keeps them; false when the host could not.
  typed {.threadvar.}: JsonNode
    ## Read from the host once, on the thread that renders: the apps and the
    ## page that types them both run there.

proc forgetServiceKeys*() =
  ## The next read asks the host again.
  typed = nil

proc serviceKeysTyped*(): JsonNode =
  ## The keys typed on the frame, an empty object for none.
  if typed.isNil:
    if not serviceKeysLoad.isNil:
      try:
        typed = parseJson(serviceKeysLoad())
      except CatchableError:
        discard
    if typed.isNil or typed.kind != JObject:
      typed = newJObject()
  typed

proc typeServiceKey*(group, field, value: string) =
  ## One key as it was typed; "" takes it away.
  let keys = serviceKeysTyped()
  var own = keys{group}
  if own.isNil or own.kind != JObject:
    if value.len == 0:
      return
    own = newJObject()
    keys.fields[group] = own
  if value.len > 0:
    own.fields[field] = newJString(value)
  else:
    own.fields.del(field)
    if own.fields.len == 0:
      keys.fields.del(group)

proc keepServiceKeys*(): bool =
  ## What `typeServiceKey` changed, to the host. False where it keeps none, for too
  ## much, or when it failed: what it does keep is read again.
  let text = $serviceKeysTyped()
  result = text.len <= MaxServiceKeysBytes and not serviceKeysSave.isNil and serviceKeysSave(text)
  if not result:
    typed = nil
