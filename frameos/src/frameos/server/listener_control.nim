## Rebinding the frame's HTTP and HTTPS listeners while it serves.
##
## `server/listeners.nim` decides which sockets the config wants; at start-up
## `server.nim` opens them. An on-device settings save that changes the port,
## turns HTTPS on or off, flips `exposeOnlyPort` or replaces the certificate
## used to land in frame.json and do nothing until the next restart — the
## admin page then pointed at a port the frame would only answer on some day.
## The FrameOS/mummy fork can add and remove listeners from any thread while
## serving (accepted connections are unaffected), so the save applies the new
## plan right away, and it does so BEFORE the config is persisted: a port the
## runtime cannot bind, or a certificate it cannot load, is refused with the
## reason, and frame.json keeps the values the frame is actually serving on.
## That is also what keeps a bad value from taking the next boot down (the
## plain listener failing at start-up is fatal).
import std/[json, locks, os, strutils]
import mummy
from std/net import Port
import frameos/channels
import frameos/types
import ./listeners

type
  ActiveListener = object
    spec: ListenerSpec
    certPem: string
    keyPem: string
    listener: Listener

  ListenerApplyResult* = object
    ok*: bool
    error*: string
    changed*: bool ## a listener was added or removed
    listeners*: seq[ListenerSpec] ## what the server answers on afterwards

var controlLock: Lock
initLock(controlLock)
var controlledServer: mummy.Server = nil
var active: seq[ActiveListener] = @[]

proc listenerSpecsJson*(specs: seq[ListenerSpec]): JsonNode =
  result = newJArray()
  for spec in specs:
    result.add(%*{"address": spec.address, "port": spec.port, "tls": spec.tls})

proc registerControlledServer*(server: mummy.Server) {.gcsafe.} =
  ## The one server whose listeners a settings save may rebind. Forgets any
  ## listener registered for a previous server.
  withLock controlLock:
    {.cast(gcsafe).}:
      controlledServer = server
      active = @[]

proc registerActiveListener*(spec: ListenerSpec, listener: Listener, certPem = "", keyPem = "") {.gcsafe.} =
  ## A listener the server already answers on (opened at start-up).
  if listener == nil:
    return
  withLock controlLock:
    {.cast(gcsafe).}:
      active.add(ActiveListener(spec: spec, certPem: certPem, keyPem: keyPem, listener: listener))

proc activeListenerSpecsLocked(): seq[ListenerSpec] =
  for entry in active:
    result.add(entry.spec)

proc activeListenerSpecs*(): seq[ListenerSpec] {.gcsafe.} =
  withLock controlLock:
    {.cast(gcsafe).}:
      result = activeListenerSpecsLocked()

proc listenerMaterial(frameConfig: FrameConfig, spec: ListenerSpec): tuple[certPem, keyPem: string] =
  if spec.tls and frameConfig.httpsProxy != nil:
    (frameConfig.httpsProxy.serverCert, frameConfig.httpsProxy.serverKey)
  else:
    ("", "")

proc sameListener(entry: ActiveListener, spec: ListenerSpec, certPem, keyPem: string): bool =
  entry.spec == spec and entry.certPem == certPem and entry.keyPem == keyPem

proc describeSpec(spec: ListenerSpec): string =
  (if spec.tls: "HTTPS" else: "HTTP") & " on " & spec.address & ":" & $spec.port

proc openListener(server: mummy.Server, spec: ListenerSpec, certPem, keyPem: string): Listener =
  ## Binds the socket now; raises MummyError with the reason when it cannot.
  if spec.tls:
    when defined(ssl):
      let tls = newTlsConfig(certPem, keyPem)
      server.addListener(Port(spec.port), spec.address, tls)
    else:
      raise newException(MummyError, "this build has no OpenSSL support, HTTPS is not available")
  else:
    server.addListener(Port(spec.port), spec.address)

proc openListenerAfterRemoval(server: mummy.Server, spec: ListenerSpec, certPem, keyPem: string): Listener =
  ## `removeListener` only queues the close: the serving thread applies it at
  ## the end of its current loop iteration. A rebind of the SAME port right
  ## after (loopback instead of every interface, a replaced certificate) sees
  ## the old socket still bound for a moment, so retry briefly before
  ## calling it a failure.
  var attempts = 0
  while true:
    try:
      return openListener(server, spec, certPem, keyPem)
    except MummyError:
      inc attempts
      if attempts >= 100:
        raise
      sleep(20)

proc applyListenerPlan*(frameConfig: FrameConfig): ListenerApplyResult {.gcsafe.} =
  ## Makes the server answer on exactly what `planListeners(frameConfig)`
  ## asks for. New listeners are bound first and the ones no longer wanted
  ## removed after, so a failure leaves the frame reachable where it was —
  ## unless the new and the old listener share a port (loopback instead of
  ## every interface for `exposeOnlyPort`), where the old one has to go
  ## first and comes back if the new one cannot be bound. Without a
  ## registered server (unit tests, a runtime that never started serving)
  ## the plan is reported but nothing is bound.
  withLock controlLock:
    {.cast(gcsafe).}:
      var desired: seq[ActiveListener] = @[]
      for spec in planListeners(frameConfig):
        let (certPem, keyPem) = listenerMaterial(frameConfig, spec)
        desired.add(ActiveListener(spec: spec, certPem: certPem, keyPem: keyPem))
      result.ok = true
      if controlledServer == nil:
        for entry in desired:
          result.listeners.add(entry.spec)
        return

      var keep: seq[ActiveListener] = @[]
      var toRemove: seq[ActiveListener] = @[]
      var toAdd: seq[ActiveListener] = @[]
      for entry in active:
        var wanted = false
        for want in desired:
          if sameListener(entry, want.spec, want.certPem, want.keyPem):
            wanted = true
            break
        if wanted: keep.add(entry) else: toRemove.add(entry)
      for want in desired:
        var have = false
        for entry in active:
          if sameListener(entry, want.spec, want.certPem, want.keyPem):
            have = true
            break
        if not have: toAdd.add(want)

      if toAdd.len == 0 and toRemove.len == 0:
        for entry in active:
          result.listeners.add(entry.spec)
        return

      var added: seq[ActiveListener] = @[]
      var removedEarly: seq[ActiveListener] = @[]

      proc rollBack() =
        for entry in added:
          controlledServer.removeListener(entry.listener)
        for entry in removedEarly:
          try:
            let restored = openListenerAfterRemoval(controlledServer, entry.spec, entry.certPem, entry.keyPem)
            keep.add(ActiveListener(spec: entry.spec, certPem: entry.certPem, keyPem: entry.keyPem,
              listener: restored))
          except MummyError as e:
            log(%*{"event": "http:listeners:restore_error", "listener": describeSpec(entry.spec), "error": e.msg})
        active = keep & toRemove

      for want in toAdd:
        var opened: Listener = nil
        try:
          opened = openListener(controlledServer, want.spec, want.certPem, want.keyPem)
        except MummyError as first:
          # The same port is held by a listener that is on its way out.
          var conflicts: seq[ActiveListener] = @[]
          var remaining: seq[ActiveListener] = @[]
          for entry in toRemove:
            if entry.spec.port == want.spec.port: conflicts.add(entry) else: remaining.add(entry)
          if conflicts.len == 0:
            rollBack()
            return ListenerApplyResult(ok: false, error: "Could not open " & describeSpec(want.spec) & ": " & first.msg,
              listeners: activeListenerSpecsLocked())
          for entry in conflicts:
            controlledServer.removeListener(entry.listener)
            removedEarly.add(entry)
          toRemove = remaining
          try:
            opened = openListenerAfterRemoval(controlledServer, want.spec, want.certPem, want.keyPem)
          except MummyError as second:
            rollBack()
            return ListenerApplyResult(ok: false, error: "Could not open " & describeSpec(want.spec) & ": " & second.msg,
              listeners: activeListenerSpecsLocked())
        added.add(ActiveListener(spec: want.spec, certPem: want.certPem, keyPem: want.keyPem, listener: opened))

      for entry in toRemove:
        controlledServer.removeListener(entry.listener)
      active = keep & added
      result.changed = true
      for entry in active:
        result.listeners.add(entry.spec)
      log(%*{"event": "http:listeners", "message": "Listeners changed by a settings save",
        "listeners": listenerSpecsJson(result.listeners)})
