{.passl: "-levdev".}
## The evdev I/O shell: opens every input device, reads them with `poll()`,
## watches /dev/input for devices coming and going, and sends what
## translate.nim makes of the events as structs (frameos/driver_abi). What an
## input_event means is translate.nim's, where it is tested; what a scene hears
## of it is the host's (frameos/input_state.nim).
##
## Keyboards are grabbed (EVIOCGRAB) while the runtime runs, so the console
## never sees a key meant for a scene — Ctrl+Alt+Del included — and released
## when this thread ends, so a rescue console still works. A frame setting
## (`inputSettings.grabKeyboard`, default on) turns that off.

import json, posix, strformat, strutils, os, options, times
import std/inotify

import ./libevdev
import ./linuxInput
import ./translate

import frameos/driver_context
import frameos/channels

type Driver* = ref object of FrameOSDriver

type DevState = object
  path: string
  evdev: ptr libevdev
  fd: cint
  grabbed: bool
  translator: DeviceTranslator

type ThreadArgs = (int, int, bool)
  ## panel width, panel height, grab keyboards. Values, never the host's config ref.

const
  ## A device that just appeared may not be readable yet (udev is still
  ## setting its mode): wait this long before opening it.
  HotplugSettleMs = 250
  PollTimeoutMs = 1000

var thread: Thread[ThreadArgs]

proc isKeyboard(evdev: ptr libevdev): bool =
  ## Something with letter keys is a keyboard; a mouse with a couple of
  ## BTN_* codes is not, and neither is a gamepad.
  libevdev_has_event_type(evdev, EV_KEY) and
    libevdev_has_event_code(evdev, EV_KEY.cuint, KEY_A.cuint) and
    libevdev_has_event_code(evdev, EV_KEY.cuint, KEY_Z.cuint)

proc pointerTypeOf(evdev: ptr libevdev): DriverPointerType =
  if libevdev_has_event_code(evdev, EV_KEY.cuint, BTN_TOOL_PEN.cuint) or
      libevdev_has_event_code(evdev, EV_KEY.cuint, BTN_STYLUS.cuint):
    return dptPen
  if libevdev_has_event_code(evdev, EV_KEY.cuint, BTN_TOUCH.cuint) or
      libevdev_has_property(evdev, INPUT_PROP_DIRECT.cuint) != 0:
    return dptTouch
  dptMouse

proc openDevice(device: string, deviceId: int, grabKeyboards: bool): Option[DevState] =
  ## One device, if it is an input device at all. Raises when it cannot be
  ## opened; returns none when it has nothing this driver reads.
  let deviceCString: cstring = device.cstring
  let fd = open(deviceCString, O_RDONLY or O_NONBLOCK)
  if fd < 0:
    raise newException(Exception, &"could not open {device}")
  var evdev: ptr libevdev
  let ret = libevdev_new_from_fd(fd, addr evdev)
  if ret < 0:
    discard close(fd)
    raise newException(Exception, &"could not create libevdev device for {device}")
  if not (libevdev_has_event_type(evdev, EV_REL) or libevdev_has_event_type(evdev, EV_KEY) or
      libevdev_has_event_type(evdev, EV_ABS)):
    libevdev_free(evdev)
    discard close(fd)
    return none(DevState)
  var state = DevState(path: device, evdev: evdev, fd: fd)
  state.translator = initDeviceTranslator(
    minX = libevdev_get_abs_minimum(evdev, ABS_X).int,
    maxX = libevdev_get_abs_maximum(evdev, ABS_X).int,
    minY = libevdev_get_abs_minimum(evdev, ABS_Y).int,
    maxY = libevdev_get_abs_maximum(evdev, ABS_Y).int,
    deviceId = deviceId,
    pointerType = pointerTypeOf(evdev),
    multitouch = libevdev_has_event_code(evdev, EV_ABS.cuint, ABS_MT_SLOT.cuint))
  if grabKeyboards and isKeyboard(evdev):
    state.grabbed = libevdev_grab(evdev, LIBEVDEV_GRAB) == 0
  some(state)

proc closeDevice(state: var DevState) =
  if state.grabbed:
    discard libevdev_grab(state.evdev, LIBEVDEV_UNGRAB)
    state.grabbed = false
  libevdev_free(state.evdev)
  if state.fd >= 0:
    discard close(state.fd)
  state.fd = -1

proc logDevice(state: DevState, name: string) =
  log(%*{"event": "driver:evdev", "device": state.path, "name": name, "listening": true,
    "pointerType": (case DriverPointerType(state.translator.pointerType.int)
      of dptTouch: "touch"
      of dptPen: "pen"
      else: "mouse"),
    "keyboard": isKeyboard(state.evdev), "grabbed": state.grabbed})

proc addDevice(openDevices: var seq[DevState], device: string, nextDeviceId: var int, grabKeyboards: bool) =
  for existing in openDevices:
    if existing.path == device:
      return
  # One unreadable or malformed device must not disable the others.
  try:
    let opened = openDevice(device, nextDeviceId, grabKeyboards)
    if opened.isNone:
      log(%*{"event": "driver:evdev", "device": device, "type": "unknown"})
    else:
      inc nextDeviceId
      openDevices.add(opened.get())
      logDevice(opened.get(), $libevdev_get_name(opened.get().evdev))
  except Exception as e:
    log(%*{"event": "driver:evdev", "device": device, "error": e.msg})

proc removeDevice(openDevices: var seq[DevState], index: int, why: string) =
  ## The device is gone: whatever it held lets go, then it is closed.
  log(%*{"event": "driver:evdev", "device": openDevices[index].path, "info": why})
  sendInputEvent(openDevices[index].translator.cancelEvent())
  closeDevice(openDevices[index])
  openDevices.delete(index)

proc readDevice(state: var DevState, translated: var seq[DriverInputEvent]): bool =
  ## Everything the device has for us. False when the device is gone.
  while true:
    var ev: input_event
    var rc = libevdev_next_event(state.evdev, cuint(LIBEVDEV_READ_FLAG_NORMAL), addr ev)
    if rc == -EAGAIN:
      return true
    if rc == cint(LIBEVDEV_READ_STATUS_SYNC):
      # SYN_DROPPED: the kernel lost events. Drain the sync delta, and let go
      # of what this device holds — a release may have been among the lost.
      while rc == cint(LIBEVDEV_READ_STATUS_SYNC):
        rc = libevdev_next_event(state.evdev, cuint(LIBEVDEV_READ_FLAG_SYNC), addr ev)
      sendInputEvent(state.translator.cancelEvent())
      return true
    if rc != cint(LIBEVDEV_READ_STATUS_SUCCESS):
      # Any other error (-ENODEV after unplug, etc.) is permanent for this
      # device; previously this spun forever at 100% CPU and starved all
      # other input devices.
      return false
    translated.setLen(0)
    let outcome = translate(state.translator, ev.ev_type.int, ev.code.int, ev.value.int, translated)
    for event in translated:
      sendInputEvent(event)
    if outcome == trUnknownType:
      # Once per device and type. This used to be a line per event, and EV_REL
      # landed here: a USB mouse wrote hundreds of log lines a second into a
      # log that is shipped to the backend.
      log(%*{"event": "driver:evdev", "device": state.path,
          "info": "ignoring an event type this driver does not handle",
          "eventType": $libevdev_event_type_get_name(ev.ev_type),
          "firstCode": $libevdev_event_code_get_name(ev.ev_type, ev.code),
          "type": ev.ev_type.int,
          "code": ev.code.int})

proc startThread*(args: ThreadArgs) {.thread.} =
  let grabKeyboards = args[2]
  var openDevices: seq[DevState] = @[]
  var nextDeviceId = 1
  var translated: seq[DriverInputEvent] = @[]
  # New devices are opened a moment after they appear; the paths wait here.
  var pendingPaths: seq[(string, float)] = @[]
  var inotifyFd: cint = -1
  try:
    for device in walkPattern("/dev/input/event*"):
      addDevice(openDevices, device, nextDeviceId, grabKeyboards)

    # Hotplug without udev: the directory tells us when a device node comes or
    # goes. A frame that boots without a keyboard used to never see one.
    inotifyFd = inotify_init1(O_NONBLOCK)
    if inotifyFd >= 0:
      if inotify_add_watch(inotifyFd, "/dev/input", IN_CREATE or IN_DELETE or IN_ATTRIB) < 0:
        log(%*{"event": "driver:evdev", "error": "inotify watch on /dev/input failed; no hotplug"})
        discard close(inotifyFd)
        inotifyFd = -1
    else:
      log(%*{"event": "driver:evdev", "error": "inotify_init failed; no hotplug"})

    log(%*{"event": "driver:evdev",
      "info": &"Listening to {openDevices.len} device" & (if openDevices.len == 1: "" else: "s"),
      "hotplug": inotifyFd >= 0})

    while true:
      # Wait for something to read instead of polling every 10 ms: the idle
      # cost on a Pi Zero was measurable, and a keypress waits no longer.
      var fds: seq[TPollfd]
      for state in openDevices:
        fds.add(TPollfd(fd: state.fd, events: POLLIN))
      if inotifyFd >= 0:
        fds.add(TPollfd(fd: inotifyFd, events: POLLIN))
      if fds.len == 0 and inotifyFd < 0:
        log(%*{"event": "driver:evdev", "error": "All input devices gone and no hotplug, stopping evdev driver"})
        return
      let timeout = if pendingPaths.len > 0: HotplugSettleMs.cint else: PollTimeoutMs.cint
      if fds.len > 0:
        discard poll(addr fds[0], Tnfds(fds.len), timeout)
      else:
        os.sleep(timeout.int)

      var deadDevices: seq[int] = @[]
      for index in 0 ..< openDevices.len:
        let ready = (fds[index].revents and (POLLIN or POLLHUP or POLLERR)) != 0
        if not ready:
          continue
        if (fds[index].revents and (POLLHUP or POLLERR)) != 0 and (fds[index].revents and POLLIN) == 0:
          deadDevices.add(index)
          continue
        if not readDevice(openDevices[index], translated):
          deadDevices.add(index)
      for removeIndex in countdown(deadDevices.len - 1, 0):
        removeDevice(openDevices, deadDevices[removeIndex], "device gone, closing")

      if inotifyFd >= 0 and (fds[^1].revents and POLLIN) != 0:
        var buffer: array[4096, char]
        while true:
          let n = read(inotifyFd, addr buffer[0], buffer.len)
          if n <= 0:
            break
          var offset = 0
          while offset < n:
            let event = cast[ptr InotifyEvent](addr buffer[offset])
            let nameLen = event.len.int
            if nameLen > 0:
              let name = $cast[cstring](addr buffer[offset + sizeof(InotifyEvent)])
              if name.startsWith("event"):
                let path = "/dev/input/" & name
                if (event.mask and IN_DELETE) != 0:
                  for index in countdown(openDevices.len - 1, 0):
                    if openDevices[index].path == path:
                      removeDevice(openDevices, index, "device removed")
                elif (event.mask and (IN_CREATE or IN_ATTRIB)) != 0:
                  var known = false
                  for pending in pendingPaths:
                    if pending[0] == path:
                      known = true
                  if not known:
                    pendingPaths.add((path, epochTime()))
            offset += sizeof(InotifyEvent) + nameLen

      if pendingPaths.len > 0:
        let now = epochTime()
        var still: seq[(string, float)] = @[]
        for pending in pendingPaths:
          if now - pending[1] >= HotplugSettleMs / 1000:
            if fileExists(pending[0]):
              addDevice(openDevices, pending[0], nextDeviceId, grabKeyboards)
          else:
            still.add(pending)
        pendingPaths = still
  except Exception as e:
    log(%*{"event": "driver:evdev",
        "error": "Failed to initialize driver", "exception": e.msg,
        "stack": e.getStackTrace()})
  finally:
    # Let the console have its keyboards back.
    for state in openDevices.mitems:
      closeDevice(state)
    if inotifyFd >= 0:
      discard close(inotifyFd)

proc init*(frameOS: DriverContext): Driver =
  createThread(thread, startThread, (frameOS.frameConfig.width, frameOS.frameConfig.height,
    frameOS.frameConfig.grabKeyboard))
  result = Driver(name: "evdev")
