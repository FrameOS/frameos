import pixie
import frameos/types
import drivers/plugin_runtime

# Called before the runner is created
proc init*(frameOS: FrameOS) =
  initCompiledDrivers(frameOS)

# Called after the frame's image is rendered
proc render*(image: Image) =
  renderCompiledDrivers(image)

# Convert the rendered pixels to a PNG image. For accurate colors on the web.
proc toPng*(rotate: int): string =
  result = compiledDriversToPng(rotate)

# Turn on the device, if supported
proc turnOn*() =
  turnOnCompiledDrivers()

# Turn off the device, if supported
proc turnOff*() =
  turnOffCompiledDrivers()
