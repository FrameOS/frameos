## The scene's refresh interval as a state field.
##
## Every scene has one state key that holds "seconds between renders":
##
## - a field marked `role: "refreshInterval"` (the first one wins), else
## - a field literally named `refreshInterval`, else
## - an implicit public field `refreshInterval`, seeded from
##   `settings.refreshInterval` and appended to the scene's fields.
##
## Whichever it is, it is listed LAST among the public fields, so every
## control surface (the /c panel, the admin UI, the cloud) shows it as the
## final input. The runtime reads the interval back out of the scene's state
## after every run, so `state.refreshInterval = 60` from a code node, a
## setSceneState from a control panel and a schedule's state all do the same
## thing. The same rules live in `frontend/src/utils/refreshInterval.ts` and
## `backend/app/utils/refresh_interval.py`; keep them in step.

import std/[json, math, strutils]
import frameos/types

const
  RefreshIntervalRole* = "refreshInterval"
  RefreshIntervalFieldName* = "refreshInterval"
  RefreshIntervalLabel* = "Refresh interval (seconds)"
  DefaultRefreshIntervalSeconds* = 300.0

proc refreshIntervalFieldIndex*(fields: seq[StateField]): int =
  ## Index of the field that carries the refresh interval, -1 when the scene
  ## declares none. An explicit role beats the literal name.
  for i, field in fields:
    if not field.isNil and field.role == RefreshIntervalRole:
      return i
  for i, field in fields:
    if not field.isNil and field.name == RefreshIntervalFieldName:
      return i
  -1

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
  fields*: seq[StateField] ## every field, the refresh interval one last
  key*: string             ## the state key that holds the interval
  defaultSeconds*: float   ## what the scene ships with
  implicit*: bool          ## the field was added here, not declared by the scene

proc resolveRefreshInterval*(fields: seq[StateField], settingsSeconds: float): ResolvedRefreshInterval =
  let settingsDefault = if settingsSeconds > 0.0: settingsSeconds else: DefaultRefreshIntervalSeconds
  let index = refreshIntervalFieldIndex(fields)
  if index < 0:
    result.fields = fields & @[implicitRefreshIntervalField(settingsDefault)]
    result.key = RefreshIntervalFieldName
    result.defaultSeconds = settingsDefault
    result.implicit = true
    return
  let field = fields[index]
  for i, other in fields:
    if i != index:
      result.fields.add(other)
  result.fields.add(field)
  result.key = field.name
  let declared = parseRefreshSeconds(field.value)
  result.defaultSeconds = if declared > 0.0: declared else: settingsDefault
  result.implicit = false
