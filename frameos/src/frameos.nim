import asyncdispatch
from ./frameos/frameos import startFrameOS

when isMainModule:
  waitFor startFrameOS() # blocks forever
