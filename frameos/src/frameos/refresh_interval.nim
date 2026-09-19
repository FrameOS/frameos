## The scene's refresh interval as a state field.
##
## Every scene has one state key that holds "seconds between renders":
##
## - a field marked `role: "refreshInterval"` (the first one wins), else
## - a float or integer field literally named `refreshInterval`, else
## - an implicit public field `refreshInterval`, seeded from
##   `settings.refreshInterval` and appended after the scene's own fields, so
##   every control surface (the /c panel, the admin UI, the cloud) ends with
##   "Refresh interval (seconds)".
##
## A field the scene declares stays where the scene put it: declaring it is
## how an author decides where the control goes, what it is called, and — with
## `access: "private"` — that people do not get one. (A `refreshInterval`
## field of any other type is the scene using the name for something else:
## it is left alone and no implicit field is added over it.)
##
## The runtime reads the interval back out of the scene's state after every
## run, so `frameos.setState("refreshInterval", 60)`, a logic/setAsState node,
## logic/nextSleepDuration, a setSceneState from a control panel and a
## schedule's state all do the same thing. The same rules live in
## `frontend/src/utils/refreshInterval.ts`, `frameos/wasm/src/refreshInterval.ts`
## and `backend/app/utils/refresh_interval.py`; keep them in step.

import std/[json, math, strutils]
import frameos/types

const
  RefreshIntervalRole* = "refreshInterval"
  RefreshIntervalFieldName* = "refreshInterval"
  RefreshIntervalLabel* = "Refresh interval (seconds)"
  DefaultRefreshIntervalSeconds* = 300.0

proc isNumericFieldType(fieldType: string): bool =
  fieldType == "float" or fieldType == "integer"

proc refreshIntervalFieldIndex*(fields: seq[StateField]): int =
  ## Index of the field that carries the refresh interval, -1 when the scene
  ## declares none. An explicit role beats the literal name, and the name only
  ## counts on a numeric field.
  for i, field in fields:
    if not field.isNil and field.role == RefreshIntervalRole:
      return i
  for i, field in fields:
    if not field.isNil and field.name == RefreshIntervalFieldName and isNumericFieldType(field.fieldType):
      return i
  -1

proc refreshIntervalNameTaken*(fields: seq[StateField]): bool =
  ## The scene has a `refreshInterval` field (of whatever type), so an
  ## implicit one cannot be added next to it.
  for field in fields:
    if not field.isNil and field.name == RefreshIntervalFieldName:
      return true
  false

proc parseRefreshSeconds*(value: JsonNode): float =
  ## Lenient on purpose: control forms deliver numbers as strings. Returns 0
  ## for anything that is not a positive, finite number of seconds.
  if value.isNil:
    return 0.0
  var seconds = 0.0
  case value.kind
  of JInt: seconds = value.getInt().float
  of JFloat: seconds = value.getFloat()
  of JString:
    try:
      seconds = parseFloat(value.getStr().strip())
    except ValueError:
      return 0.0
  else:
    return 0.0
  if seconds > 0.0 and seconds.classify notin {fcNan, fcInf, fcNegInf}: seconds else: 0.0

proc refreshIntervalFromState*(state: JsonNode, key: string, fallback: float): float =
  if key.len > 0 and not state.isNil and state.kind == JObject and state.hasKey(key):
    let seconds = parseRefreshSeconds(state[key])
    if seconds > 0.0:
      return seconds
  fallback

proc implicitRefreshIntervalField*(defaultSeconds: float): StateField =
  StateField(
    name: RefreshIntervalFieldName,
    label: RefreshIntervalLabel,
    fieldType: "float",
    value: %defaultSeconds,
    persist: "disk",
    access: "public",
    role: RefreshIntervalRole,
  )

type ResolvedRefreshInterval* = object
  fields*: seq[StateField] ## the scene's fields in their own order, plus the implicit one last
  key*: string             ## the state key that holds the interval ("" = settings only)
  defaultSeconds*: float   ## what the scene ships with
  implicit*: bool          ## the field was added here, not declared by the scene

proc resolveRefreshInterval*(fields: seq[StateField], settingsSeconds: float): ResolvedRefreshInterval =
  let settingsDefault = if settingsSeconds > 0.0: settingsSeconds else: DefaultRefreshIntervalSeconds
  result.fields = fields
  result.defaultSeconds = settingsDefault
  let index = refreshIntervalFieldIndex(fields)
  if index >= 0:
    let field = fields[index]
    result.key = field.name
    let declared = parseRefreshSeconds(field.value)
    if declared > 0.0:
      result.defaultSeconds = declared
  elif not refreshIntervalNameTaken(fields):
    result.fields.add(implicitRefreshIntervalField(settingsDefault))
    result.key = RefreshIntervalFieldName
    result.implicit = true

proc syncRefreshInterval*(scene: FrameScene) =
  ## `FrameScene.refreshInterval` is what every host's render loop reads; the
  ## scene's state is where it is set. Copy one into the other.
  if scene.isNil or scene.refreshIntervalKey.len == 0:
    return
  scene.refreshInterval = refreshIntervalFromState(
    scene.state, scene.refreshIntervalKey, scene.refreshIntervalDefault)

proc setRefreshInterval*(scene: FrameScene, seconds: float): bool =
  ## Set the scene's interval the way a control panel would: through its state
  ## field, so every surface shows the new number. False for a value that is
  ## not a positive number of seconds (nothing changes then).
  if scene.isNil or parseRefreshSeconds(%seconds) <= 0.0:
    return false
  if scene.refreshIntervalKey.len > 0:
    if scene.state.isNil or scene.state.kind != JObject:
      scene.state = %*{}
    scene.state[scene.refreshIntervalKey] = %seconds
  scene.refreshInterval = seconds
  true
