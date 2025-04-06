import pixie
import frameos/apps
import frameos/types
import frameos/utils/image

import os, strformat, strutils, random, json, osproc

const DEFAULT_PLAYWRIGHT_SCRIPT_START = """
import time
from playwright.sync_api import sync_playwright

playwright = sync_playwright().start()
browser = playwright.chromium.launch()
page = browser.new_page()
page.goto(URL_TO_CAPTURE)
page.set_viewport_size({"width": WIDTH, "height": HEIGHT})
"""

const DEFAULT_PLAYWRIGHT_SCRIPT_END = """
page.screenshot(path=SCREENSHOT_PATH)
browser.close()
playwright.stop()
"""

type
  AppConfig* = object
    url*: string
    width*: int
    height*: int
    source*: string

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc init*(self: App) =
  ## (Initialization if needed)
  discard

# Ensure the virtual environment exists and is set up
proc ensureVenvExists(self: App): string =
  let venvPath = "/srv/frameos/venvs/screenshot"
  result = venvPath
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
  let width = if self.appConfig.width != 0:
                self.appConfig.width
              elif context.hasImage:
                context.image.width
              else:
                self.frameConfig.renderWidth()
  let height = if self.appConfig.height != 0:
                  self.appConfig.height
              elif context.hasImage:
                context.image.height
                else:
                  self.frameConfig.renderHeight()

  try:
    let screenshotFile = fmt"/tmp/frameos_screenshot_{rand(1000000)}_{rand(1000000)}.png"
    let scriptFile = fmt"/tmp/frameos_playwright_script_{rand(1000000)}.py"

    self.log &"Capturing URL `{self.appConfig.url}` at {width}x{height} in {screenshotFile}"

    if fileExists(screenshotFile):
      try: removeFile(screenshotFile)
      except: discard

    # Ensure the Python venv for Playwright exists and is set up.
    let venvRoot = self.ensureVenvExists()
    let venvPython = venvRoot & "/bin/python"

    # Write the playwright script to a temporary file
    let scripHead = DEFAULT_PLAYWRIGHT_SCRIPT_START.replace("URL_TO_CAPTURE", $(%*(self.appConfig.url)))
      .replace("WIDTH", $width).replace("HEIGHT", $height)
    let scriptTail = DEFAULT_PLAYWRIGHT_SCRIPT_END.replace("SCREENSHOT_PATH", $(%*(screenshotFile)))
    writeFile(scriptFile, scripHead & self.appConfig.source & "\n" & scriptTail)

    # Run the script
    var cmd = &"{venvPython} {scriptFile}"
    self.log "Running command: " & cmd
    try:
      let (output, response) = execCmdEx(cmd)
      if response != 0:
        self.logError &"Playwright command failed with response {response}: {output}"
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
      return renderError(width, height, "Error capturing screenshot")
