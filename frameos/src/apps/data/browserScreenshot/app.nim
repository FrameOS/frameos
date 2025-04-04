import pixie
import frameos/apps
import frameos/types
import frameos/utils/image

import os, strformat, strutils, random, osproc

type
  AppConfig* = object
    url*: string
    scaling_factor*: float
    width*: int
    height*: int
    source*: string

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc init*(self: App) =
  ## (Initialization if needed)
  discard

# Ensure the virtual environment exists and is set up
proc ensureVenvExists(self: App) =
  let venvPath = "/srv/frameos/venvs/browserScreenshot"
  let venvPython = venvPath & "/bin/python"
  if not fileExists(venvPython):
    self.log "Virtual environment not found. Creating venv at " & venvPath
    try:
      discard execShellCmd("python3 -m venv " & venvPath)
    except OSError as e:
      self.logError &"Error creating venv: {e.msg}"
      return
    self.log "Installing playwright package..."
    try:
      discard execShellCmd(venvPython & " -m pip install playwright")
    except OSError as e:
      self.logError &"Error installing playwright: {e.msg}"
      return
    self.log "Installing Playwright browsers..."
    try:
      discard execShellCmd(venvPython & " -m playwright install")
    except OSError as e:
      self.logError &"Error installing playwright browsers: {e.msg}"
      return

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

    # Define temporary file for screens≥hot
    let screenshotFile = fmt"/tmp/frameos_screenshot_{rand(1000000)}_{rand(1000000)}.png"
    if fileExists(screenshotFile):
      try: removeFile(screenshotFile)
      except: discard

    # Ensure the Python venv for Playwright exists and is set up.
    self.ensureVenvExists()
    let venvPython = "/srv/frameos/venvs/browserScreenshot/bin/python"

    # Write the playwright script to a temporary file
    let scriptFile = fmt"/tmp/frameos_playwright_script_{rand(1000000)}.py"
    # TODO: sanitize URL_TO_CAPTURE
    writeFile(scriptFile, self.appConfig.source.replace("SCREENSHOT_PATH", &"\"{screenshotFile}\"").replace(
        "URL_TO_CAPTURE", &"\"{self.appConfig.url}\""))

    # Build the command:
    # We pass: url, screenshotFile, width, height, scalingFactor as arguments.
    var cmd = &"{venvPython} {scriptFile} \"{self.appConfig.url}\" \"{screenshotFile}\" {width} {height} {scalingFactor}"
    self.log "Running command: " & cmd

    try:
      let response = execShellCmd(cmd)
      if response != 0:
        self.logError &"Playwright command failed with response: {response}"
        return renderError(width, height, "Playwright command failed")
    except OSError as e:
      self.logError &"Error running playwright command: {e.msg}"
      if context.hasImage:
        return context.image
      else:
        return renderError(width, height, "Error running playwright command")

    # Clean up the temporary script file
    try: removeFile(scriptFile)
    except OSError as e:
      self.logError &"Error removing temporary playwright script: {e.msg}"

    if fileExists(screenshotFile):
      let screenshotImage = readImage(screenshotFile)
      self.log &"Loaded screenshot from {screenshotFile}. Size: {screenshotImage.width}x{screenshotImage.height}"
      try: removeFile(screenshotFile)
      except OSError as e:
        self.logError &"Error removing screenshot file: {e.msg}"
      return screenshotImage
    else:
      self.logError "No screenshot file was found after running playwright script."
      if context.hasImage:
        return context.image
      else:
        return renderError(width, height, "Screenshot failed")
  except:
    self.logError "An error occurred while capturing the screenshot."
    if context.hasImage:
      return context.image
    else:
      return renderError(self.frameConfig.renderWidth(),
                         self.frameConfig.renderHeight(),
                         "Error capturing screenshot")
