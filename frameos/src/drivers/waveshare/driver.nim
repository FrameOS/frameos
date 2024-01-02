import ePaper/DEV_Config as waveshareConfig
import ePaper/EPD_2in13_V3 as waveshareDisplay
from ./types import ColorOption

let width* = waveshareDisplay.WIDTH
let height* = waveshareDisplay.HEIGHT

let colorOption* = ColorOption.Black

proc init*() =
  let resp = waveshareConfig.DEV_Module_Init()
  if resp != 0: raise newException(Exception, "Failed to initialize waveshare display")
  waveshareDisplay.Init()

proc renderOne*(image: seq[uint8]) =
  waveshareDisplay.Display(addr image[0])

proc renderTwo*(image1: seq[uint8], image2: seq[uint8]) =
  discard
