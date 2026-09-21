## The scene event contract, as the runtime reads it. docs/events-contract.json
## is the source; generate_events_contract.py turns it into events_gen.nim
## (data only) and this module is the handful of questions a host asks of it:
## may this origin say that, is it logged, does it coalesce. docs/events.md is
## the prose.
##
## The policy questions are a `case` over string literals and a const array of
## plain objects — nothing allocated, nothing shared, so any thread may ask.

import std/[json, options, tables]
import ./events_gen
export events_gen

proc eventPolicy*(name: string): EventPolicy =
  ## The contract row of `name`; the custom-event policy for any other name.
  let index = contractEventIndex(name)
  if index < 0: CustomEventPolicy else: ContractEventPolicies[index]

proc isContractEvent*(name: string): bool =
  contractEventIndex(name) >= 0

proc originMayEmit*(origin: EventOrigin, name: string): bool =
  ## The allow-list for a contract event. The dispatcher (event_loop.nim) asks
  ## it of every envelope; an edge that can answer sooner — an HTTP route's 401,
  ## a dispatch node's log line with its node id — asks the same question.
  origin in eventPolicy(name).origins

proc originMayEmit*(origin: EventOrigin, name: string, declared: set[EventOrigin]): bool =
  ## The allow-list for an event aimed at a scene. A custom event gets the
  ## contract's base, plus what the scene's declaration of it opted into
  ## (`declared`, from `declaredCustomEventOrigins`): a schedule or the cloud may
  ## fire `nextPage` only at a scene that says so.
  let policy = eventPolicy(name)
  origin in policy.origins or
    (policy.class == ecCustom and origin in declared * CustomEventDeclarableOrigins)

proc originMayQueue*(origin: EventOrigin, name: string): bool =
  ## What an edge that cannot see the scene asks before it queues an event (the
  ## scheduler, the hub client): the allow-list, except that a custom event from
  ## an origin a scene can opt into is let through — whether the scene showing
  ## declared it is the dispatcher's to say, on the thread that owns the scene.
  let policy = eventPolicy(name)
  origin in policy.origins or (policy.class == ecCustom and origin in CustomEventDeclarableOrigins)

proc declaredCustomEventOrigins*(customEvents: JsonNode): Table[string, set[EventOrigin]] =
  ## A scene's `customEvents` ([{name, origins: ["schedule"]}]) as the table the
  ## dispatcher asks. Only declarable origins count, only for names that are not
  ## the contract's, and an entry without `origins` adds nothing.
  result = initTable[string, set[EventOrigin]]()
  if customEvents.isNil or customEvents.kind != JArray:
    return
  for entry in customEvents:
    if entry.kind != JObject or entry{"origins"}.isNil or entry["origins"].kind != JArray:
      continue
    let name = entry{"name"}.getStr()
    if name.len == 0 or name.len > CustomEventMaxNameLength or isContractEvent(name):
      continue
    var declared: set[EventOrigin]
    for item in entry["origins"]:
      for origin in CustomEventDeclarableOrigins:
        if item.getStr() == $origin:
          declared.incl(origin)
    if declared != {}:
      result[name] = declared

proc runtimeCommandOf*(name: string): Option[RuntimeCommand] =
  ## The device command `name` is, if it is one.
  for command in RuntimeCommand:
    if $command == name:
      return some(command)
  none(RuntimeCommand)

proc isDeviceCommand*(name: string): bool =
  eventPolicy(name).class == ecDeviceCommand

proc eventIsLogged*(name: string): bool =
  eventPolicy(name).log != elNone

proc eventLogsPayload*(name: string): bool =
  eventPolicy(name).log == elFull

