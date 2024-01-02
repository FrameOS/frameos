{.passl: "-levdev".}
import pixie, json, posix, strformat, os, options

import ./libevdev
import ./linuxInput

from frameos/types import FrameOS, Logger, FrameOSDriver

var thread: Thread[Logger]

type Driver* = ref object of FrameOSDriver
  logger: Logger

proc safeLog*(logger: Logger, event: JsonNode) =
  # TODO: write to the channel directly from here
  {.gcsafe.}:
    logger.log(event)

proc getListener*(device: string): Option[ptr libevdev] =
  var evdev: ptr libevdev
  let deviceCString: cstring = device.cstring
  let fd = open(deviceCString, O_RDONLY or O_NONBLOCK)
  if fd < 0:
    raise newException(Exception, &"could not open {device}")

  let ret = libevdev_new_from_fd(fd, addr evdev)
  if ret < 0:
    raise newException(Exception, &"could not create libevdev device for {device}")

  if libevdev_has_event_type(evdev, EV_REL):
    return some(evdev)
  elif libevdev_has_event_type(evdev, EV_KEY):
    return some(evdev)
  elif libevdev_has_event_type(evdev, EV_ABS):
    return some(evdev)
  else:
    discard close(fd)
    return none(ptr libevdev)

proc startThread*(logger: Logger) = #{.thread.} =
  try:
    var openDevices: seq[(string, ptr libevdev)] = @[]
    for device in walkPattern("/dev/input/event*"):
      let listener = getListener(device)
      if listener.isNone:
        logger.safeLog(%*{"event": "driver:evdev",
          "device": device, "type": "unknown"})
      else:
        logger.safeLog(%*{"event": "driver:evdev", "device": device,
            "listening": true})
        openDevices.add((device, listener.get()))

    if openDevices.len == 0:
      raise newException(Exception, &"No devices found")

    logger.safeLog(%*{"event": "driver:evdev",
          "info": &"Listening to {openDevices.len} device" & (
              if openDevices.len > 1: "s" else: "")})

    var foundSome = false
    var otherValue = -1
    while true:
      foundSome = false
      for (device, evdev) in openDevices:
        block nextdevice:
          # read all events for one device before going to the next
          while true:
            var ev: input_event
            let rc = libevdev_next_event(evdev, cuint(
                LIBEVDEV_READ_FLAG_NORMAL), addr ev)
            if rc == -EAGAIN:
              break nextdevice
            if rc == cint(LIBEVDEV_READ_STATUS_SUCCESS):
              foundSome = true
              if ev.ev_type == EV_SYN:
                otherValue = -1
                continue
              if ev.ev_type == EV_MSC:
                continue
              if ev.ev_type == EV_KEY:
                if ev.code >= BTN_MISC and ev.code <= BTN_GEAR_UP:
                  logger.safeLog(%*{
                    "event": if ev.value ==
                    1: "ev:mousedown" else: "ev:mouseup",
                    "key": $libevdev_event_code_get_name(ev.ev_type, ev.code),
                    "keyCode": ev.code,
                  })
                else:
                  logger.safeLog(%*{
                    "event": if ev.value == 1: "ev:keydown" else: "ev:keyup",
                    "key": $libevdev_event_code_get_name(ev.ev_type, ev.code),
                    "keyCode": ev.code,
                  })
              elif ev.ev_type == EV_ABS:
                if otherValue == -1:
                  otherValue = ev.value
                else:
                  if ev.code == ABS_X:
                    logger.safeLog(%*{
                      "event": "ev:mousemove",
                      "x": ev.value,
                      "y": otherValue,
                    })
                  elif ev.code == ABS_Y:
                    logger.safeLog(%*{
                      "event": "ev:mousemove",
                      "x": otherValue,
                      "y": ev.value,
                    })
              else:
                logger.safeLog(%*{"event": "driver:evdev",
                    "eventName": $libevdev_event_type_get_name(ev.ev_type),
                    "eventCode": $libevdev_event_code_get_name(ev.ev_type,
                        ev.code),
                    "eventValue": $ev.value,
                    "type": ev.ev_type,
                    "code": ev.code,
                    "value": ev.value,
                })
      if not foundSome:
        sleep(10) # give the cpu some air

  except Exception as e:
    logger.safeLog(%*{"event": "driver:evdev",
        "error": "Failed to initialize driver", "exception": e.msg,
        "stack": e.getStackTrace()})

proc init*(frameOS: FrameOS): Driver =
  let logger = frameOS.logger
  createThread(thread, startThread, logger)
  result = Driver(
    name: "evdev",
    logger: logger,
  )
