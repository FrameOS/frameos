import pixie
import frameos/apps
import frameos/types
import frameos/local_access
import frameos/spawn_guard
import frameos/utils/image

import os, strformat, strutils, json, net, sequtils
import posix except Time
import frameos/utils/process

const APT_TIMEOUT_MS = 30 * 60 * 1000
const VENV_TIMEOUT_MS = 30 * 60 * 1000
const BROWSER_START_TIMEOUT_MS = 60 * 1000
const PLAYWRIGHT_COMMAND_TIMEOUT_MS = 5 * 60 * 1000

# The request gate (frameos/spawn_guard.nim): the guard checked ONE URL
# before the browser was handed it, but a page is a chain of requests —
# redirects, sub-resources, iframes — and each of those is a fresh host the
# guard never saw. While the frame's private-network deny is on
# (PIN_HOST set: cloud-managed frames), every request the page makes goes
# through here: the pinned host itself is fine (Chromium resolves it to the
# checked address through --host-resolver-rules, so it cannot rebind), and
# any other host is resolved and classified the way the runtime's HTTP
# client classifies (`not is_global` = loopback, RFC1918, link-local, CGNAT,
# reserved, multicast) and dropped when private. The lookup is this
# script's, not Chromium's, so a sub-resource host that rebinds between the
# two lookups is the residual window — narrower than the "first URL only"
# it replaces, and the primary host has none.
const DEFAULT_PLAYWRIGHT_SCRIPT_START = """
import ipaddress
import socket
import time
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright

PIN_HOST = PINNED_HOST

def _private_host(host):
    try:
        addr = ipaddress.ip_address(host)
        return not addr.is_global
    except ValueError:
        pass
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        return True
    for info in infos:
        try:
            if not ipaddress.ip_address(info[4][0]).is_global:
                return True
        except ValueError:
            return True
    return not infos

def _gate(route, request):
    parts = urlsplit(request.url)
    if parts.scheme not in ("http", "https"):
        route.abort("blockedbyclient")
        return
    host = (parts.hostname or "").lower()
    if host == PIN_HOST or not _private_host(host):
        route.continue_()
    else:
        route.abort("blockedbyclient")

playwright = sync_playwright().start()
browser = playwright.chromium.connect_over_cdp("http://127.0.0.1:BROWSER_DEBUG_PORT")
context = browser.contexts[0] if browser.contexts else browser.new_context()
page = context.new_page()
if PIN_HOST is not None:
    page.route("**/*", _gate)
page.set_viewport_size({"width": WIDTH, "height": HEIGHT})
page.goto(URL_TO_CAPTURE, timeout=NAVIGATION_TIMEOUT_MS, wait_until="domcontentloaded")
"""

const DEFAULT_PLAYWRIGHT_SCRIPT_END = """
page.screenshot(path=SCREENSHOT_PATH, timeout=120000)
page.close()
if not PERSIST_SESSION:
    context.close()
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
# Chromium refuses to start as root without --no-sandbox, and with it a page
# renders unsandboxed AS ROOT. The runtime is `frameos` (uid 990) on every
# image since the privileged door shipped (docs/buildroot-privileges.md), and
# there the real sandbox runs; a root install (a self-hosted backend's SSH
# deploy, an image from before 9.4) gets the flag only after the local admin
# has said at the panel that this frame may run shell apps at all.
const ROOT_SANDBOX_REFUSAL = "chromiumScreenshot: FrameOS runs as root on this frame, so Chromium " &
  "would render the page unsandboxed as root. Allow shell apps at the panel " &
  "(Settings → Network → shell apps for store scenes, confirmed with the code " &
  "shown on the panel) to accept that, or run FrameOS as the unprivileged " &
  "frameos user (every release image since 9.4 does)."
const LIGHTWEIGHT_CHROMIUM_ARGS = @[
  "--headless",
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
    persistSession*: bool

  App* = ref object of AppRoot
    appConfig*: AppConfig
    hasEnoughRam: bool
    memoryKb: int

  ChromiumRamProbeHook* = proc(): int
  ChromiumEnsureSystemDependenciesHook* = proc(self: App)
  ChromiumEnsureVenvExistsHook* = proc(self: App): string
  ChromiumEnsureBackgroundBrowserHook* = proc(self: App, width: int, height: int): bool

var
  chromiumRamProbeHook*: ChromiumRamProbeHook = nil
  chromiumEnsureSystemDependenciesHook*: ChromiumEnsureSystemDependenciesHook = nil
  chromiumEnsureVenvExistsHook*: ChromiumEnsureVenvExistsHook = nil
  chromiumEnsureBackgroundBrowserHook*: ChromiumEnsureBackgroundBrowserHook = nil
  # The --host-resolver-rules the running background Chromium was started
  # with. A resolver rule is a process-start flag, so a target pinned to
  # another address (spawn_guard.nim) means a restart. Unknown after a
  # runtime restart (the browser outlives us): a pinned target then restarts
  # it once.
  chromiumRunningResolverRules = ""
  chromiumRunningResolverRulesKnown = false

when defined(testing):
  # Under -d:testing the bootstrap seams default to no-ops instead of nil.
  # init() otherwise apt-installs Chromium (30-minute timeout per attempt),
  # builds a pip venv and launches a headless browser. On a dev laptop all of
  # that fails in milliseconds (no sudo, no apt) and nobody notices; on a CI
  # runner with passwordless sudo it all genuinely runs — which is how a
  # planner test that merely INITS every repo scene spent its entire CI budget
  # inside apt-get. A test that wants the real bootstrap sets a hook back to
  # nil; a test that wants to observe it sets its own, as tests/test_app.nim
  # does.
  chromiumEnsureSystemDependenciesHook = proc(self: App) = discard
  chromiumEnsureVenvExistsHook = proc(self: App): string = ""
  chromiumEnsureBackgroundBrowserHook = proc(self: App, width, height: int): bool = false

proc ensureVenvExists(self: App): string
proc ensureBackgroundBrowser(self: App, width: int = 800, height: int = 600,
                             resolverRules = ""): bool
proc stopBackgroundBrowser(self: App)
proc shellQuote(value: string): string
proc pickChromiumBinary(): string
proc currentRamKb(): int
proc hasMinimumRam(self: App): bool

proc currentRamKb(): int =
  if chromiumRamProbeHook != nil:
    return chromiumRamProbeHook()

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
  posix.kill(Pid(pid), 0) == 0

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
  let hasPython = findExe("python3") != ""
  let hasChromium = findExe("chromium-headless-shell") != "" or
      findExe("chromium-browser") != "" or findExe("chromium") != ""

  if hasPython and hasChromium:
    return

  self.log "Installing Browser Snapshot system dependencies..."
  let updateResponse = runShellWithParentStreams("sudo apt-get update",
      timeoutMs = APT_TIMEOUT_MS).exitCode
  if updateResponse != 0:
    self.logError &"Error running apt-get update (response {updateResponse})"
    return

  let pythonInstallResponse = runShellWithParentStreams(
      "sudo apt-get install -y python3 python3-pip python3-venv",
      timeoutMs = APT_TIMEOUT_MS).exitCode
  if pythonInstallResponse != 0:
    self.logError &"Error installing Python dependencies (response {pythonInstallResponse})"
    return

  var chromiumInstallResponse = runShellWithParentStreams(
      "sudo apt-get install -y chromium-headless-shell", timeoutMs = APT_TIMEOUT_MS).exitCode
  if chromiumInstallResponse != 0:
    self.log "Package chromium-headless-shell unavailable, retrying with chromium-browser..."
    chromiumInstallResponse = runShellWithParentStreams(
        "sudo apt-get install -y chromium-browser", timeoutMs = APT_TIMEOUT_MS).exitCode
  if chromiumInstallResponse != 0:
    self.log "Package chromium-browser unavailable, retrying with chromium..."
    chromiumInstallResponse = runShellWithParentStreams(
        "sudo apt-get install -y chromium", timeoutMs = APT_TIMEOUT_MS).exitCode

  if chromiumInstallResponse != 0:
    self.logError &"Error installing Chromium dependencies (response {chromiumInstallResponse})"

proc init*(self: App) =
  self.log "Initializing chromium screenshot app"
  ## (Initialization if needed)
  self.hasEnoughRam = self.hasMinimumRam()
  if not self.hasEnoughRam:
    self.log "Not enough RAM to run Chromium. At least 1GB is needed, got " & $(self.memoryKb / 1024).toInt() & "MB"
    return

  if chromiumEnsureSystemDependenciesHook == nil:
    self.ensureSystemDependencies()
  else:
    chromiumEnsureSystemDependenciesHook(self)

  if chromiumEnsureVenvExistsHook == nil:
    discard self.ensureVenvExists()
  else:
    discard chromiumEnsureVenvExistsHook(self)

  if chromiumEnsureBackgroundBrowserHook == nil:
    discard self.ensureBackgroundBrowser(self.appConfig.width, self.appConfig.height)
  else:
    discard chromiumEnsureBackgroundBrowserHook(self, self.appConfig.width, self.appConfig.height)

# Ensure the virtual environment exists and is set up
proc ensureVenvExists(self: App): string =
  let venvPath = "/srv/frameos/venvs/screenshot"
  result = venvPath
  let venvPython = venvPath & "/bin/python"
  if not fileExists(venvPython):
    self.log "Virtual environment not found. Creating venv at " & venvPath
    try:
      discard runShellWithParentStreams("python3 -m venv " & venvPath, timeoutMs = VENV_TIMEOUT_MS)
    except OSError as e:
      self.logError &"Error creating venv: {e.msg}"
      return
    self.log "Installing playwright package..."
    try:
      discard runShellWithParentStreams(venvPython & " -m pip install playwright", timeoutMs = VENV_TIMEOUT_MS)
    except OSError as e:
      self.logError &"Error installing playwright: {e.msg}"
      return

proc runningAsRoot(): bool =
  posix.geteuid() == 0

proc ensureBackgroundBrowser(self: App, width: int = 800, height: int = 600,
                             resolverRules = ""): bool =
  if isBrowserDebugPortReady(CHROMIUM_DEBUG_PORT):
    let rulesMatch =
      if chromiumRunningResolverRulesKnown: chromiumRunningResolverRules == resolverRules
      else: resolverRules.len == 0
    if rulesMatch:
      return true
    self.log "Restarting Chromium: the target's host-resolver rules changed"
    self.stopBackgroundBrowser()

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
    # The viewport is scene-supplied; hold it to the decode ceiling like any
    # other requested raster, or a 20000x20000 window is Chromium's problem
    # and then the frame's.
    let (windowWidth, windowHeight) = boundedRequestedDimensions(width, height)
    var chromiumArgs = LIGHTWEIGHT_CHROMIUM_ARGS & @["--window-size=" & $windowWidth & "," & $windowHeight]
    if runningAsRoot():
      # Only reachable after the panel ceremony (see get); logged every
      # start so the choice stays visible.
      self.log "Chromium runs with --no-sandbox because FrameOS runs as root on this frame"
      chromiumArgs.add("--no-sandbox")
    if resolverRules.len > 0:
      chromiumArgs.add("--host-resolver-rules=" & resolverRules)
    let argString = chromiumArgs.mapIt(shellQuote(it)).join(" ")
    let startCommand = &"nohup {shellQuote(chromiumBinary)} {argString} >> {shellQuote(CHROMIUM_LOG_FILE)} 2>&1 & echo $! > {shellQuote(CHROMIUM_PID_FILE)}"
    # the shell backgrounds chromium with nohup and exits right away
    let response = runShellWithParentStreams("bash -lc " & shellQuote(startCommand),
        timeoutMs = BROWSER_START_TIMEOUT_MS).exitCode
    if response != 0:
      self.logError &"Error starting background Chromium process (response {response})"
      return false
    chromiumRunningResolverRules = resolverRules
    chromiumRunningResolverRulesKnown = true
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

  discard posix.kill(Pid(chromiumPid), SIGTERM)
  for _ in 0 ..< 10:
    if not isPidAlive(chromiumPid):
      break
    sleep(200)

  if isPidAlive(chromiumPid):
    self.log &"Chromium PID {chromiumPid} did not exit gracefully, forcing kill"
    discard posix.kill(Pid(chromiumPid), SIGKILL)

  try:
    if fileExists(CHROMIUM_PID_FILE):
      removeFile(CHROMIUM_PID_FILE)
  except CatchableError:
    discard
  chromiumRunningResolverRules = ""
  chromiumRunningResolverRulesKnown = false

proc privateWorkDir(): string =
  ## A fresh 0700 directory for this capture's script and screenshot. The
  ## script is executed, so a predictable name in a shared /tmp was a
  ## pre-plant-and-race invitation; mkdtemp's name is the kernel's and the
  ## mode keeps other users out.
  var pattern = getTempDir() / "frameos-screenshot-XXXXXX"
  if posix.mkdtemp(pattern.cstring) == nil:
    raise newException(OSError, "mkdtemp failed: " & $strerror(errno))
  pattern

proc pickChromiumBinary(): string =
  let browserCandidates = ["chromium-headless-shell", "chromium-browser", "chromium"]
  for candidate in browserCandidates:
    let path = findExe(candidate)
    if path != "":
      return path
  return ""

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

  if not self.hasEnoughRam:
    return renderError(width, height, LOW_RAM_ERROR.replace("{memoryMb}", $(round(self.memoryKb / 1024).int)))

  # Provenance and target checks before anything is spawned (spawn_guard.nim):
  # a store scene needs the local admin's say-so to run a browser at all, and
  # the URL it opens must be http(s) to a host the LAN policy allows.
  let refusal = spawningAppRefusal(self.scene, "chromiumScreenshot")
  if refusal.len > 0:
    self.logError refusal
    return renderError(width, height, refusal)
  let target = spawnTarget(self.appConfig.url, ["http", "https"])
  if target.refusal.len > 0:
    self.logError "chromiumScreenshot refused to open the configured URL: " & target.refusal
    return renderError(width, height, target.refusal)
  if runningAsRoot() and not storedAllowShellApps():
    self.logError ROOT_SANDBOX_REFUSAL
    return renderError(width, height, ROOT_SANDBOX_REFUSAL)
  # While the private-network deny is on, Chromium must connect the checked
  # host to the checked address and nothing else (spawn_guard.nim).
  let resolverRules =
    if target.address.len > 0: "MAP " & target.hostname & " " & target.address
    else: ""

  try:
    let workDir = privateWorkDir()
    let screenshotFile = workDir / "screenshot.png"
    let scriptFile = workDir / "capture.py"

    # Remove the temp files on every exit path, not just success: a scene
    # stuck on a failing URL re-renders for months, and /tmp is RAM-backed.
    defer:
      try: removeDir(workDir)
      except OSError: discard

    self.log &"Capturing URL `{self.appConfig.url}` at {width}x{height} in {screenshotFile}"

    if fileExists(screenshotFile):
      try: removeFile(screenshotFile)
      except: discard

    # Ensure the Python venv for Playwright exists and is set up.
    let venvRoot = if chromiumEnsureVenvExistsHook == nil:
        self.ensureVenvExists()
      else:
        chromiumEnsureVenvExistsHook(self)
    let venvPython = venvRoot & "/bin/python"
    let browserReady = if chromiumEnsureBackgroundBrowserHook == nil:
        self.ensureBackgroundBrowser(width, height, resolverRules)
      else:
        chromiumEnsureBackgroundBrowserHook(self, width, height)
    if not browserReady:
      if context.hasImage:
        return context.image
      else:
        return renderError(width, height, "Chromium browser is not available")

    self.log &"Waiting {CHROMIUM_STARTUP_SETTLE_MS}ms for Chromium to finish warming up"
    sleep(CHROMIUM_STARTUP_SETTLE_MS)

    # Write the playwright script to a temporary file
    let scriptContext = if self.appConfig.persistSession:
      "context = browser.contexts[0] if browser.contexts else browser.new_context()"
    else:
      "context = browser.new_context()"

    let pinnedHost = if target.address.len > 0: $(%*(target.hostname.toLowerAscii())) else: "None"
    let scripHead = DEFAULT_PLAYWRIGHT_SCRIPT_START.replace("URL_TO_CAPTURE", $(%*(target.url)))
      .replace("PINNED_HOST", pinnedHost)
      .replace("BROWSER_DEBUG_PORT", $CHROMIUM_DEBUG_PORT)
      .replace("context = browser.contexts[0] if browser.contexts else browser.new_context()", scriptContext)
      .replace("WIDTH", $width).replace("HEIGHT", $height)
      .replace("NAVIGATION_TIMEOUT_MS", $PLAYWRIGHT_NAVIGATION_TIMEOUT_MS)
    # TODO: make this configurable... but also compatible with a background browser process
    let scriptBody = """
page.emulate_media(reduced_motion="reduce")
page.wait_for_load_state("domcontentloaded")
page.wait_for_timeout(1500)
"""
    let scriptTail = DEFAULT_PLAYWRIGHT_SCRIPT_END.replace("SCREENSHOT_PATH", $(%*(screenshotFile)))
      .replace("PERSIST_SESSION", if self.appConfig.persistSession: "True" else: "False")

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
        let browserReady = if chromiumEnsureBackgroundBrowserHook == nil:
            self.ensureBackgroundBrowser(width, height, resolverRules)
          else:
            chromiumEnsureBackgroundBrowserHook(self, width, height)
        if not browserReady:
          return renderError(width, height, "Chromium browser is not available")
        sleep(CHROMIUM_STARTUP_SETTLE_MS)

      try:
        let (output, response) = runShellCapture(cmd, timeoutMs = PLAYWRIGHT_COMMAND_TIMEOUT_MS)
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

    if fileExists(screenshotFile):
      # The screenshot is captured at width x height; keep those bounds so
      # large displays stay sharp while the decode remains memory-bounded.
      let screenshotImage = readImageWithDisplayBounds(
        screenshotFile,
        maxEdge = max(DisplayDecodeMaxEdge, max(width, height)),
        maxPixels = max(DisplayDecodeMaxPixels, width * height)
      )
      self.log &"Loaded screenshot from {screenshotFile}. Size: {screenshotImage.width}x{screenshotImage.height}"
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
