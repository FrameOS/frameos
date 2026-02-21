import pixie
import frameos/apps
import frameos/types
import frameos/utils/image

import os, strformat, strutils, random, json, osproc, net

const DEFAULT_PLAYWRIGHT_SCRIPT_START = """
import time
from playwright.sync_api import sync_playwright

playwright = sync_playwright().start()
browser = playwright.chromium.connect_over_cdp("http://127.0.0.1:BROWSER_DEBUG_PORT")
context = browser.contexts[0] if browser.contexts else browser.new_context()
page = context.new_page()
page.set_viewport_size({"width": WIDTH, "height": HEIGHT})
page.goto(URL_TO_CAPTURE)
"""

const DEFAULT_PLAYWRIGHT_SCRIPT_END = """
page.screenshot(path=SCREENSHOT_PATH, timeout=120000)
page.close()
playwright.stop()
"""

const CHROMIUM_DEBUG_PORT = 9222
const CHROMIUM_STARTUP_ATTEMPTS = 20
const CHROMIUM_STARTUP_SLEEP_MS = 250

type
  AppConfig* = object
    url*: string
    width*: int
    height*: int

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc ensureVenvExists(self: App): string
proc ensureBackgroundBrowser(self: App): bool

proc isBrowserDebugPortReady(port: int): bool =
  var socket = newSocket()
  try:
    socket.connect("127.0.0.1", Port(port))
    result = true
  except CatchableError:
    result = false
  finally:
    socket.close()

proc ensureSystemDependencies(self: App) =
  let requiredCommands = @["python3", "chromium-browser"]
  var missingCommands: seq[string] = @[]
  for command in requiredCommands:
    let (_, response) = execCmdEx("command -v " & command)
    if response != 0:
      missingCommands.add(command)
  if missingCommands.len == 0:
    return
  self.log "Installing Browser Snapshot system dependencies..."
  try:
    discard execShellCmd("sudo apt-get update")
    discard execShellCmd("sudo apt-get install -y python3 python3-pip python3-venv chromium-browser")
  except OSError as e:
    self.logError &"Error installing system dependencies: {e.msg}"

proc init*(self: App) =
  ## (Initialization if needed)
  self.ensureSystemDependencies()
  discard self.ensureVenvExists()
  discard self.ensureBackgroundBrowser()

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

proc ensureBackgroundBrowser(self: App): bool =
  if isBrowserDebugPortReady(CHROMIUM_DEBUG_PORT):
    return true

  let (chromiumPath, binaryResponse) = execCmdEx("command -v chromium-browser || command -v chromium")
  if binaryResponse != 0:
    self.logError "Could not find chromium-browser or chromium in PATH"
    return false

  let chromiumBinary = chromiumPath.strip()

  self.log "Starting background Chromium process for Browser Snapshot..."
  try:
    var browserProcess = startProcess(
      chromiumBinary,
      args = @[
        "--headless",
        "--disable-gpu",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=" & $CHROMIUM_DEBUG_PORT,
        "--user-data-dir=/tmp/frameos_browser_snapshot_profile",
        "about:blank"
      ],
      options = {poUsePath, poDaemon}
    )
    browserProcess.close()
  except OSError as e:
    self.logError &"Error starting background Chromium process: {e.msg}"
    return false

  for _ in 0 ..< CHROMIUM_STARTUP_ATTEMPTS:
    if isBrowserDebugPortReady(CHROMIUM_DEBUG_PORT):
      return true
    sleep(CHROMIUM_STARTUP_SLEEP_MS)

  self.logError &"Chromium debug port {CHROMIUM_DEBUG_PORT} did not become ready"
  return false

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
    if not self.ensureBackgroundBrowser():
      if context.hasImage:
        return context.image
      else:
        return renderError(width, height, "Chromium browser is not available")

    # Write the playwright script to a temporary file
    let scripHead = DEFAULT_PLAYWRIGHT_SCRIPT_START.replace("URL_TO_CAPTURE", $(%*(self.appConfig.url)))
      .replace("BROWSER_DEBUG_PORT", $CHROMIUM_DEBUG_PORT)
      .replace("WIDTH", $width).replace("HEIGHT", $height)
    # TODO: make this configurable... but also compatible with a background browser process
    let scriptBody = "page.wait_for_load_state(\"networkidle\")\n"
    let scriptTail = DEFAULT_PLAYWRIGHT_SCRIPT_END.replace("SCREENSHOT_PATH", $(%*(screenshotFile)))

    writeFile(scriptFile, scripHead & scriptBody & "\n" & scriptTail)

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
