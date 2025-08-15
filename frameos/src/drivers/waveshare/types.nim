import pixie, options
import frameos/types

type ColorOption* = enum
  Black = "Black"
  BlackWhiteRed = "BlackWhiteRed"
  BlackWhiteYellow = "BlackWhiteYellow"
  BlackWhiteYellowRed = "BlackWhiteYellowRed"
  FourGray = "FourGray"
  SixteenGray = "SixteenGray"
  SevenColor = "SevenColor"
  SpectraSixColor = "SpectraSixColor"

type Driver* = ref object of FrameOSDriver
  logger*: Logger
  width*: int
  height*: int
  lastImageData*: seq[ColorRGBX]
  lastRenderAt*: float
  palette*: Option[seq[(int, int, int)]]
  vcom*: float # used for the 10.3" display
