import pixie
import frameos/apps
import frameos/types
import frameos/utils/image

import os, strformat, strutils, random, json, osproc

const IMGKIT_TIMEOUT_SECONDS = 45
const IMGKIT_JAVASCRIPT_DELAY_MS = 1200

type
  AppConfig* = object
    url*: string
    width*: int
    height*: int

  App* = ref object of AppRoot
    appConfig*: AppConfig
    systemDepsChecked: bool

proc ensureVenvExists(self: App): string
proc captureWithImgkit(self: App, width: int, height: int, screenshotFile: string): tuple[success: bool, timeout: bool, error: string]

proc ensureSystemDependencies(self: App) =
  let (_, pythonResponse) = execCmdEx("command -v python3")
  let (_, wkhtmltoimageResponse) = execCmdEx("command -v wkhtmltoimage")

  if pythonResponse == 0 and wkhtmltoimageResponse == 0:
    return

  self.log "Installing Browser Snapshot system dependencies..."
  let updateResponse = execShellCmd("sudo apt-get update")
  if updateResponse != 0:
    self.logError &"Error running apt-get update (response {updateResponse})"
    return

  let pythonInstallResponse = execShellCmd("sudo apt-get install -y python3 python3-pip python3-venv")
  if pythonInstallResponse != 0:
    self.logError &"Error installing Python dependencies (response {pythonInstallResponse})"
    return

  if wkhtmltoimageResponse != 0:
    let wkhtmlInstallResponse = execShellCmd("sudo apt-get install -y wkhtmltopdf")
    if wkhtmlInstallResponse != 0:
      self.logError &"Error installing wkhtmltoimage dependency from wkhtmltopdf package (response {wkhtmlInstallResponse})"

proc init*(self: App) =
  ## (Initialization if needed)
  self.ensureSystemDependencies()
  self.systemDepsChecked = true
  discard self.ensureVenvExists()

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

  let (_, imgkitImportResponse) = execCmdEx(venvPython & " -c \"import imgkit\"")
  if imgkitImportResponse != 0:
    self.log "Installing imgkit package..."
    try:
      discard execShellCmd(venvPython & " -m pip install imgkit")
    except OSError as e:
      self.logError &"Error installing imgkit: {e.msg}"
      return

proc captureWithImgkit(self: App, width: int, height: int, screenshotFile: string): tuple[success: bool, timeout: bool, error: string] =
  let venvRoot = self.ensureVenvExists()
  let venvPython = venvRoot & "/bin/python"
  let scriptFile = fmt"/tmp/frameos_imgkit_script_{rand(1000000)}.py"

  let script = ("""
import imgkit

options = {
    "quiet": "",
    "width": WIDTH,
    "height": HEIGHT,
    "javascript-delay": JS_DELAY,
    "enable-local-file-access": "",
}

imgkit.from_url(URL_TO_CAPTURE, SCREENSHOT_PATH, options=options)
""".replace("URL_TO_CAPTURE", $(%*(self.appConfig.url)))
  .replace("SCREENSHOT_PATH", $(%*(screenshotFile)))
  .replace("WIDTH", $width)
  .replace("HEIGHT", $height)
  .replace("JS_DELAY", $IMGKIT_JAVASCRIPT_DELAY_MS))

  writeFile(scriptFile, script)

  let cmd = &"timeout {IMGKIT_TIMEOUT_SECONDS}s {venvPython} {scriptFile}"
  self.log "Running Browser Snapshot renderer (imgkit/wkhtmltoimage): " & cmd
  let (output, response) = execCmdEx(cmd)

  try: removeFile(scriptFile)
  except CatchableError: discard

  if response == 0 and fileExists(screenshotFile):
    return (true, false, "")

  let timedOut = response == 124
  return (false, timedOut, output)

proc get*(self: App, context: ExecutionContext): Image =
  if not self.systemDepsChecked:
    self.init()

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

    self.log &"Capturing URL `{self.appConfig.url}` at {width}x{height} in {screenshotFile}"

    if fileExists(screenshotFile):
      try: removeFile(screenshotFile)
      except: discard

    let imgkitResult = self.captureWithImgkit(width, height, screenshotFile)
    if not imgkitResult.success:
      if imgkitResult.timeout:
        self.logError &"imgkit/wkhtmltoimage timed out after {IMGKIT_TIMEOUT_SECONDS}s while loading {self.appConfig.url}."
        return renderError(width, height, "Browser snapshot timed out while loading the page")

      if imgkitResult.error.len > 0:
        self.logError &"imgkit/wkhtmltoimage failed: {imgkitResult.error}"
      else:
        self.logError "imgkit/wkhtmltoimage did not produce an image."

      if context.hasImage:
        return context.image
      return renderError(width, height, "Browser snapshot failed")

    if fileExists(screenshotFile):
      let screenshotImage = readImage(screenshotFile)
      self.log &"Loaded screenshot from {screenshotFile}. Size: {screenshotImage.width}x{screenshotImage.height}"
      try: removeFile(screenshotFile)
      except OSError as e:
        self.logError &"Error removing screenshot file: {e.msg}"
      return screenshotImage

    self.logError "No screenshot file was found after running imgkit script."
    if context.hasImage:
      return context.image
    return renderError(width, height, "Screenshot failed")
  except:
    self.logError "An error occurred while capturing the screenshot."
    if context.hasImage:
      return context.image
    return renderError(width, height, "Error capturing screenshot")
