import os
import pixie/fileformats/png, pixie/images

const
  imageTestSuiteOutputDir* = "tmp" / "image test suite"
  pngSuiteOutputDir* = "tmp" / "png suite"

proc resetOutputDir*(dir: string) =
  when defined(writeImages):
    if dirExists(dir):
      removeDir(dir)
    createDir(dir)

proc writeOutputImage*(image: Image, dir, sourcePath: string) =
  when defined(writeImages):
    createDir(dir)
    writeFile(dir / (sourcePath.splitPath.tail & ".png"), image.encodePng())
