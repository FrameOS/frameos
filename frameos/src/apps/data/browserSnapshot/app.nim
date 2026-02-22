import pixie
import frameos/apps
import frameos/types
import frameos/utils/image

import os, strformat, strutils, random, json, osproc, net, sequtils

const DEFAULT_PLAYWRIGHT_SCRIPT_START = """
import time
from playwright.sync_api import sync_playwright

playwright = sync_playwright().start()
browser = playwright.chromium.connect_over_cdp("http://127.0.0.1:BROWSER_DEBUG_PORT")
context = browser.contexts[0] if browser.contexts else browser.new_context()
page = context.new_page()
page.set_viewport_size({"width": WIDTH, "height": HEIGHT})
page.goto(URL_TO_CAPTURE, timeout=NAVIGATION_TIMEOUT_MS, wait_until="domcontentloaded")
"""

const DEFAULT_PLAYWRIGHT_SCRIPT_END = """
page.screenshot(path=SCREENSHOT_PATH, timeout=120000)
page.close()
playwright.stop()
"""

const CHROMIUM_DEBUG_PORT = 9222
const CHROMIUM_STARTUP_ATTEMPTS = 240
const CHROMIUM_STARTUP_SLEEP_MS = 500
const CHROMIUM_MIN_RAM_KB = 1024 * 1024
const CHROMIUM_STARTUP_SETTLE_MS = 2500
const PLAYWRIGHT_NAVIGATION_TIMEOUT_MS = 90000
const CHROMIUM_PID_FILE = "/tmp/frameos_browser_snapshot_chromium.pid"
const CHROMIUM_LOG_FILE = "/tmp/frameos_browser_snapshot_chromium.log"
const CHROMIUM_USER_DATA_DIR = "/tmp/frameos_browser_snapshot_profile"
const LOW_RAM_ERROR = "Error: Can't take a browser snapshot.\n\nModern browsers need at least 1GB of RAM to run.\n\nThis device has just {memoryMb} MB.\n\nSorry. :("
const LIGHTWEIGHT_CHROMIUM_ARGS = @[
  "--headless",
  "--no-sandbox",
  "--disable-gpu",
  "--disable-software-rasterizer",
  "--disable-extensions",
  "--disable-background-networking",
  "--disable-breakpad",
  "--disable-component-update",
  "--disable-default-apps",
  "--disable-dev-shm-usage",
  "--disable-features=Translate,BackForwardCache,AutofillServerCommunication,OptimizationHints,MediaRouter,SubresourceFilter,PaintHolding",
  "--disable-sync",
  "--disk-cache-size=1",
  "--media-cache-size=1",
  "--metrics-recording-only",
  "--mute-audio",
  "--no-first-run",
  "--no-zygote",
  "--password-store=basic",
  "--renderer-process-limit=1",
  "--remote-debugging-address=127.0.0.1",
  "--remote-debugging-port=" & $CHROMIUM_DEBUG_PORT,
  "--user-data-dir=" & CHROMIUM_USER_DATA_DIR,
  "about:blank"
]

type
  AppConfig* = object
    url*: string
    width*: int
    height*: int
    disableLowMemoryCheck*: bool

  App* = ref object of AppRoot
    appConfig*: AppConfig
    systemDepsChecked: bool
    hasEnoughRam: bool
    memoryKb: int

proc ensureVenvExists(self: App): string
proc ensureBackgroundBrowser(self: App, width: int = 800, height: int = 600): bool
proc stopBackgroundBrowser(self: App)
proc shellQuote(value: string): string
proc pickChromiumBinary(): string
proc currentRamKb(): int
proc hasMinimumRam(self: App): bool

proc currentRamKb(): int =
  try:
    for line in readFile("/proc/meminfo").splitLines():
      if line.startsWith("MemTotal:"):
        let parts = line.splitWhitespace()
        if parts.len >= 2:
          return parseInt(parts[1])
  except CatchableError:
    return 0
  return 0

proc hasMinimumRam(self: App): bool =
  self.memoryKb = currentRamKb()
  if self.appConfig.disableLowMemoryCheck:
    self.log "Low memory check disabled by config; skipping minimum RAM guard"
    return true

  if self.memoryKb.float < CHROMIUM_MIN_RAM_KB.float * 0.95: # give small 50mb buffer
    self.logError &"Not enough RAM for Browser Snapshot ({self.memoryKb}kB < {CHROMIUM_MIN_RAM_KB}kB)"
    return false
  return true

proc shellQuote(value: string): string =
  "'" & value.replace("'", "'\\''") & "'"

proc readPidFromFile(path: string): int =
  if not fileExists(path):
    return 0
  try:
    let raw = readFile(path).strip()
    if raw.len == 0:
      return 0
    return parseInt(raw)
  except CatchableError:
    return 0

proc isPidAlive(pid: int): bool =
  if pid <= 0:
    return false
  let (_, response) = execCmdEx("kill -0 " & $pid)
  response == 0

proc tailLog(path: string, maxLines: int = 20): string =
  if not fileExists(path):
    return "(no chromium log file)"

  try:
    let lines = readFile(path).splitLines()
    let start = max(0, lines.len - maxLines)
    result = lines[start ..< lines.len].join("\n")
  except CatchableError:
    result = "(failed to read chromium log file)"

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
  let (_, pythonResponse) = execCmdEx("command -v python3")
  let (_, chromiumHeadlessShellResponse) = execCmdEx("command -v chromium-headless-shell")
  let (_, chromiumBrowserResponse) = execCmdEx("command -v chromium-browser")
  let (_, chromiumResponse) = execCmdEx("command -v chromium")

  if pythonResponse == 0 and (chromiumHeadlessShellResponse == 0 or chromiumBrowserResponse == 0 or chromiumResponse == 0):
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

  var chromiumInstallResponse = execShellCmd("sudo apt-get install -y chromium-headless-shell")
  if chromiumInstallResponse != 0:
    self.log "Package chromium-headless-shell unavailable, retrying with chromium-browser..."
    chromiumInstallResponse = execShellCmd("sudo apt-get install -y chromium-browser")
  if chromiumInstallResponse != 0:
    self.log "Package chromium-browser unavailable, retrying with chromium..."
    chromiumInstallResponse = execShellCmd("sudo apt-get install -y chromium")

  if chromiumInstallResponse != 0:
    self.logError &"Error installing Chromium dependencies (response {chromiumInstallResponse})"

proc init*(self: App) =
  ## (Initialization if needed)
  self.hasEnoughRam = self.hasMinimumRam()
  if not self.hasEnoughRam:
    self.systemDepsChecked = true
    return

  self.ensureSystemDependencies()
  self.systemDepsChecked = true
  discard self.ensureVenvExists()
  discard self.ensureBackgroundBrowser(self.appConfig.width, self.appConfig.height)

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

proc ensureBackgroundBrowser(self: App, width: int = 800, height: int = 600): bool =
  if isBrowserDebugPortReady(CHROMIUM_DEBUG_PORT):
    return true

  let existingPid = readPidFromFile(CHROMIUM_PID_FILE)
  if existingPid > 0 and isPidAlive(existingPid):
    self.log &"Chromium PID {existingPid} is already running but debug port is not ready yet"
  elif existingPid > 0:
    self.log &"Removing stale Chromium PID file {CHROMIUM_PID_FILE} (PID {existingPid} is not alive)"
    try:
      removeFile(CHROMIUM_PID_FILE)
    except CatchableError:
      discard

  let chromiumBinary = pickChromiumBinary()
  if chromiumBinary.len == 0:
    self.logError "Could not find chromium-headless-shell, chromium-browser, or chromium in PATH"
    return false

  self.log "Starting background Chromium process for Browser Snapshot..."
  try:
    let chromiumArgs = LIGHTWEIGHT_CHROMIUM_ARGS & @["--window-size=" & $width & "," & $height]
    let argString = chromiumArgs.mapIt(shellQuote(it)).join(" ")
    let startCommand = &"nohup {shellQuote(chromiumBinary)} {argString} >> {shellQuote(CHROMIUM_LOG_FILE)} 2>&1 & echo $! > {shellQuote(CHROMIUM_PID_FILE)}"
    let response = execShellCmd("bash -lc " & shellQuote(startCommand))
    if response != 0:
      self.logError &"Error starting background Chromium process (response {response})"
      return false
  except CatchableError as e:
    self.logError &"Error starting background Chromium process: {e.msg}"
    return false

  for _ in 0 ..< CHROMIUM_STARTUP_ATTEMPTS:
    if isBrowserDebugPortReady(CHROMIUM_DEBUG_PORT):
      return true
    sleep(CHROMIUM_STARTUP_SLEEP_MS)

  let chromiumPid = readPidFromFile(CHROMIUM_PID_FILE)
  let chromiumAlive = if chromiumPid > 0: isPidAlive(chromiumPid) else: false
  self.logError &"Chromium debug port {CHROMIUM_DEBUG_PORT} did not become ready in {CHROMIUM_STARTUP_ATTEMPTS * CHROMIUM_STARTUP_SLEEP_MS / 1000}s (pid={chromiumPid}, alive={chromiumAlive})"
  self.logError &"Chromium startup log tail:\n{tailLog(CHROMIUM_LOG_FILE)}"
  return false

proc stopBackgroundBrowser(self: App) =
  let chromiumPid = readPidFromFile(CHROMIUM_PID_FILE)
  if chromiumPid <= 0:
    return

  self.log &"Stopping Chromium PID {chromiumPid} before restart"

  discard execCmdEx("kill " & $chromiumPid)
  for _ in 0 ..< 10:
    if not isPidAlive(chromiumPid):
      break
    sleep(200)

  if isPidAlive(chromiumPid):
    self.log &"Chromium PID {chromiumPid} did not exit gracefully, forcing kill"
    discard execCmdEx("kill -9 " & $chromiumPid)

  try:
    if fileExists(CHROMIUM_PID_FILE):
      removeFile(CHROMIUM_PID_FILE)
  except CatchableError:
    discard

proc pickChromiumBinary(): string =
  let browserCandidates = ["chromium-headless-shell", "chromium-browser", "chromium"]
  for candidate in browserCandidates:
    let (path, response) = execCmdEx("command -v " & candidate)
    if response == 0:
      return path.strip()
  return ""

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

  if not self.hasEnoughRam:
    return renderError(width, height, LOW_RAM_ERROR.replace("{memoryMb}", $(round(self.memoryKb / 1024).int)))

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
    if not self.ensureBackgroundBrowser(width, height):
      if context.hasImage:
        return context.image
      else:
        return renderError(width, height, "Chromium browser is not available")

    self.log &"Waiting {CHROMIUM_STARTUP_SETTLE_MS}ms for Chromium to finish warming up"
    sleep(CHROMIUM_STARTUP_SETTLE_MS)

    # Write the playwright script to a temporary file
    let scripHead = DEFAULT_PLAYWRIGHT_SCRIPT_START.replace("URL_TO_CAPTURE", $(%*(self.appConfig.url)))
      .replace("BROWSER_DEBUG_PORT", $CHROMIUM_DEBUG_PORT)
      .replace("WIDTH", $width).replace("HEIGHT", $height)
      .replace("NAVIGATION_TIMEOUT_MS", $PLAYWRIGHT_NAVIGATION_TIMEOUT_MS)
    # TODO: make this configurable... but also compatible with a background browser process
    let scriptBody = """
page.emulate_media(reduced_motion="reduce")
page.wait_for_load_state("domcontentloaded")
page.wait_for_timeout(1500)
"""
    let scriptTail = DEFAULT_PLAYWRIGHT_SCRIPT_END.replace("SCREENSHOT_PATH", $(%*(screenshotFile)))

    writeFile(scriptFile, scripHead & scriptBody & "\n" & scriptTail)

    # Run the script. Retry once if Chromium crashed and closed the target.
    var cmd = &"{venvPython} {scriptFile}"
    self.log "Running command: " & cmd
    var completed = false
    var lastError = ""

    for attempt in 0 .. 1:
      if attempt > 0:
        self.log "Retrying Browser Snapshot with a fresh Chromium process"
        self.stopBackgroundBrowser()
        if not self.ensureBackgroundBrowser(width, height):
          return renderError(width, height, "Chromium browser is not available")
        sleep(CHROMIUM_STARTUP_SETTLE_MS)

      try:
        let (output, response) = execCmdEx(cmd)
        if response == 0:
          completed = true
          break

        if output.contains("TimeoutError"):
          self.logError &"Playwright navigation timed out after {PLAYWRIGHT_NAVIGATION_TIMEOUT_MS}ms while loading {self.appConfig.url}. Chromium may still be warming up."
          self.logError &"Playwright timeout details: {output}"
          return renderError(width, height, "Browser snapshot timed out while loading the page")

        if output.contains("TargetClosedError") and attempt == 0:
          self.logError &"Playwright target closed unexpectedly. Will restart Chromium and retry once. Details: {output}"
          continue

        lastError = output
        break
      except OSError as e:
        lastError = e.msg
        break

    if not completed:
      self.logError &"Playwright command failed: {lastError}"
      if context.hasImage:
        return context.image
      return renderError(width, height, "Playwright command failed")

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
