import pixie
import frameos/apps
import frameos/types
import frameos/utils/image

import os, strformat, random

type
  AppConfig* = object
    url*: string
    scaling_factor*: float
    width*: int
    height*: int

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc get*(self: App, context: ExecutionContext): Image =
  try:
    let scalingFactor = self.appConfig.scaling_factor
    let width = if self.appConfig.width != 0:
                  self.appConfig.width
                else:
                  self.frameConfig.renderWidth()
    let height = if self.appConfig.height != 0:
                   self.appConfig.height
                 else:
                   self.frameConfig.renderHeight()

    self.log &"Capturing URL `{self.appConfig.url}` at {width}x{height} (factor: {scalingFactor}x)"

    let screenshotFile = &"/tmp/frameos_screenshot_{rand(1000000.0)}_{rand(1000000)}.png"
    if fileExists(screenshotFile):
      try: removeFile(screenshotFile)
      except: discard

    var cmd = "chromium-browser --headless --disable-gpu --no-sandbox --disable-dev-shm-usage " &
              &"--window-size={width},{height} --screenshot={screenshotFile}"
    cmd &= &" --force-device-scale-factor={scalingFactor}"
    cmd &= " " & self.appConfig.url

    self.log("Running command: " & cmd)
    try:
      discard execShellCmd(cmd)
    except OSError as e:
      self.logError &"Error running chromium command: {e.msg}"
      # Return an error image or just pass the original
      if context.hasImage:
        return context.image
      else:
        return renderError(width, height, "Error running chromium")

    if fileExists(screenshotFile):
      let screenshotImage = readImage(screenshotFile)
      self.log &"Loaded screenshot from {screenshotFile}. Size: {screenshotImage.width}x{screenshotImage.height}"
      try: removeFile(screenshotFile)
      except OSError as e:
        self.logError &"Error removing screenshot file: {e.msg}"
      return screenshotImage
    else:
      self.logError("No screenshot file was found after chromium call.")
      if context.hasImage:
        return context.image
      else:
        return renderError(width, height, "Screenshot failed")

  except:
    self.logError("An error occurred while rendering the screenshot.")
    # Fallback: show an error image if no context image is present
    if context.hasImage:
      return context.image
    else:
      return renderError(self.frameConfig.renderWidth(),
                         self.frameConfig.renderHeight(),
                         "Error capturing screenshot")
