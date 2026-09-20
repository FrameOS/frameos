## The scene event contract, as the runtime reads it. docs/events-contract.json
## is the source; generate_events_contract.py turns it into events_gen.nim
## (data only) and this module is the handful of questions a host asks of it:
## may this origin say that, is it logged, does it coalesce. docs/events.md is
## the prose.
##
## Everything here is a `case` over string literals and a const array of plain
## objects — nothing allocated, nothing shared, so any thread may ask.

import ./events_gen
export events_gen

proc eventPolicy*(name: string): EventPolicy =
  ## The contract row of `name`; the custom-event policy for any other name.
  let index = contractEventIndex(name)
  if index < 0: CustomEventPolicy else: ContractEventPolicies[index]

proc isContractEvent*(name: string): bool =
  contractEventIndex(name) >= 0

proc originMayEmit*(origin: EventOrigin, name: string): bool =
  ## The allow-list. Until every producer stamps its origin (the dispatcher of
  ## docs/event-system-analysis.md §4.3) it is asked at the three places that
  ## know where an event came from: the HTTP routes, the scheduler and a
  ## scene's dispatch node.
  origin in eventPolicy(name).origins

proc isDeviceCommand*(name: string): bool =
  eventPolicy(name).class == ecDeviceCommand

proc eventIsLogged*(name: string): bool =
  eventPolicy(name).log != elNone

proc eventLogsPayload*(name: string): bool =
  eventPolicy(name).log == elFull

proc eventCoalescesLatest*(name: string): bool =
  eventPolicy(name).coalesceLatest

proc refusedEvents*(origin: EventOrigin): seq[string] =
  ## The contract events `origin` may not emit — what used to be a deny-list
  ## per origin. For messages and tests; the check itself is `originMayEmit`.
  for index, name in ContractEventNames:
    if origin notin ContractEventPolicies[index].origins:
      result.add(name)
