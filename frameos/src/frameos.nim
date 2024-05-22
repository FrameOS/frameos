import asyncdispatch
import std/segfaults
from ./frameos/frameos import startFrameOS

when isMainModule:
  waitFor startFrameOS() # blocks forever
