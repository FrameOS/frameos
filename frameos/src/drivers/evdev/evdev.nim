{.passl: "-levdev".}
import json, posix, strformat, os, options

import ./libevdev
import ./linuxInput
import ./translate

import frameos/driver_context
import frameos/channels

type Driver* = ref object of FrameOSDriver

type DevState = object
  path: string
  evdev: ptr libevdev
  # Everything that decides what an input_event means lives in translate.nim,
  # where it is tested; this file only reads devices and sends what comes out.
  translator: DeviceTranslator

var thread: Thread[(int, int)]

proc getListener*(device: string): Option[ptr libevdev] =
  var evdev: ptr libevdev
  let deviceCString: cstring = device.cstring
  let fd = open(deviceCString, O_RDONLY or O_NONBLOCK)
  if fd < 0:
    raise newException(Exception, &"could not open {device}")

  let ret = libevdev_new_from_fd(fd, addr evdev)
  if ret < 0:
    discard close(fd)
    raise newException(Exception, &"could not create libevdev device for {device}")

  if libevdev_has_event_type(evdev, EV_REL):
    return some(evdev)
  elif libevdev_has_event_type(evdev, EV_KEY):
    return some(evdev)
  elif libevdev_has_event_type(evdev, EV_ABS):
    return some(evdev)
  else:
    libevdev_free(evdev)
    discard close(fd)
    return none(ptr libevdev)

proc closeDevice(evdev: ptr libevdev) =
  let fd = libevdev_get_fd(evdev)
  libevdev_free(evdev)
  if fd >= 0:
    discard close(fd)

proc send(event: InputEvent) =
  case event.kind
  of iekMouseMove:
    sendEvent("mouseMove", %*{"x": event.x, "y": event.y})
  of iekMouseDown:
    sendEvent("mouseDown", %*{"button": event.button})
  of iekMouseUp:
    sendEvent("mouseUp", %*{"button": event.button})
  of iekWheel:
    sendEvent("wheel", %*{"deltaX": event.deltaX, "deltaY": event.deltaY})
  of iekKeyDown, iekKeyUp:
    sendEvent(if event.kind == iekKeyDown: "keyDown" else: "keyUp", %*{
      "key": $libevdev_event_code_get_name(EV_KEY.cuint, event.code.cuint),
      "code": event.code
    })

proc startThread*(panel: (int, int)) {.thread.} =
  try:
    # The pointer a relative mouse moves, shared by every device this thread
    # reads. The panel size arrives as two ints: a thread gets values, never
    # the host's config ref.
    var cursor = initPointerCursor(panel[0], panel[1])
    var translated: seq[InputEvent] = @[]
    var openDevices: seq[DevState] = @[]
    for device in walkPattern("/dev/input/event*"):
      # One unreadable or malformed device must not disable the others.
      try:
        let listener = getListener(device)
        if listener.isNone:
          log(%*{"event": "driver:evdev",
            "device": device, "type": "unknown"})
        else:
          log(%*{"event": "driver:evdev", "device": device,
              "listening": true})
          let evdev = listener.get()
          openDevices.add(DevState(
            path: device,
            evdev: evdev,
            translator: initDeviceTranslator(
              minX = libevdev_get_abs_minimum(evdev, ABS_X).int,
              maxX = libevdev_get_abs_maximum(evdev, ABS_X).int,
              minY = libevdev_get_abs_minimum(evdev, ABS_Y).int,
              maxY = libevdev_get_abs_maximum(evdev, ABS_Y).int),
          ))
      except Exception as e:
        log(%*{"event": "driver:evdev", "device": device,
            "error": e.msg})

    if openDevices.len == 0:
      log(%*{"event": "driver:evdev",
          "info": "No input devices found, stopping evdev driver"})
      return

    log(%*{"event": "driver:evdev",
          "info": &"Listening to {openDevices.len} device" & (
              if openDevices.len > 1: "s" else: "")})

    var foundSome = false
    while true:
      foundSome = false
      var deadDevices: seq[int] = @[]
      for deviceIndex in 0 ..< openDevices.len:
        let device = openDevices[deviceIndex].path
        let evdev = openDevices[deviceIndex].evdev
        block nextdevice:
          # read all events for one device before going to the next
          while true:
            var ev: input_event
            var rc = libevdev_next_event(evdev, cuint(
                LIBEVDEV_READ_FLAG_NORMAL), addr ev)
            if rc == -EAGAIN:
              break nextdevice
            if rc == cint(LIBEVDEV_READ_STATUS_SYNC):
              # SYN_DROPPED: drain the sync delta and resume normal reads.
              while rc == cint(LIBEVDEV_READ_STATUS_SYNC):
                rc = libevdev_next_event(evdev, cuint(
                    LIBEVDEV_READ_FLAG_SYNC), addr ev)
              break nextdevice
            if rc != cint(LIBEVDEV_READ_STATUS_SUCCESS) and rc != -EAGAIN:
              # Any other error (-ENODEV after unplug, etc.) is permanent for
              # this device; previously this spun forever at 100% CPU and
              # starved all other input devices.
              log(%*{"event": "driver:evdev", "device": device,
                  "error": &"read error {rc}, closing device"})
              deadDevices.add(deviceIndex)
              break nextdevice
            if rc == cint(LIBEVDEV_READ_STATUS_SUCCESS):
              foundSome = true
              translated.setLen(0)
              let outcome = translate(openDevices[deviceIndex].translator, cursor,
                ev.ev_type.int, ev.code.int, ev.value.int, translated)
              for event in translated:
                send(event)
              if outcome == trUnknownType:
                # Once per device and type. This used to be a line per event,
                # and EV_REL landed here: a USB mouse wrote hundreds of log
                # lines a second into a log that is shipped to the backend.
                log(%*{"event": "driver:evdev", "device": device,
                    "info": "ignoring an event type this driver does not handle",
                    "eventType": $libevdev_event_type_get_name(ev.ev_type),
                    "firstCode": $libevdev_event_code_get_name(ev.ev_type, ev.code),
                    "type": ev.ev_type.int,
                    "code": ev.code.int})
      for removeIndex in countdown(deadDevices.len - 1, 0):
        let index = deadDevices[removeIndex]
        closeDevice(openDevices[index].evdev)
        openDevices.delete(index)
      if openDevices.len == 0:
        log(%*{"event": "driver:evdev",
            "error": "All input devices gone, stopping evdev driver"})
        return
      if not foundSome:
        sleep(10) # give the cpu some air

  except Exception as e:
    log(%*{"event": "driver:evdev",
        "error": "Failed to initialize driver", "exception": e.msg,
        "stack": e.getStackTrace()})

proc init*(frameOS: DriverContext): Driver =
  createThread(thread, startThread, (frameOS.frameConfig.width, frameOS.frameConfig.height))
  result = Driver(name: "evdev")
