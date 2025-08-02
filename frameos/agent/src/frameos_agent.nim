import std/[algorithm, segfaults, strformat, strutils, asyncdispatch, terminal,
            times, os, sysrand, httpclient, osproc, streams, unicode, typedthreads, monotimes]
import checksums/md5
import json, jsony
import ws
import nimcrypto
import nimcrypto/hmac
import zippy

const
  DefaultConfigPath* = "./frame.json" # secure location
  MaxBackoffSeconds* = 60             # don’t wait longer than this

# ----------------------------------------------------------------------------
# Types
# ----------------------------------------------------------------------------

type
  NetworkConfig* = ref object
    networkCheck*: bool
    networkCheckTimeoutSeconds*: float
    networkCheckUrl*: string
    wifiHotspot*: string
    wifiHotspotSsid*: string
    wifiHotspotPassword*: string
    wifiHotspotTimeoutSeconds*: float

  AgentConfig* = ref object
    agentEnabled*: bool
    agentRunCommands*: bool
    agentSharedSecret*: string

  FrameConfig* = ref object
    name*: string
    serverHost*: string
    serverPort*: int
    serverApiKey*: string # shared secret, may be empty
    frameHost*: string
    framePort*: int
    frameAccessKey*: string
    frameAccess*: string
    width*: int
    height*: int
    metricsInterval*: float
    rotate*: int
    scalingMode*: string
    assetsPath*: string
    logToFile*: string
    debug*: bool
    timeZone*: string
    network*: NetworkConfig
    agent*: AgentConfig

  WhichStream* = enum stdoutStr, stderrStr

  LineMsg* = object
    stream*: WhichStream ## stdout or stderr
    txt*: string         ## one complete line
    done*: bool          ## true when process finished
    exit*: int           ## exit code (only valid if done)

  UploadSession = object
    fh: File
    compression: string
    bytesWritten: int

var currentUpload: UploadSession

# ----------------------------------------------------------------------------
# Config IO (fails hard if unreadable)
# ----------------------------------------------------------------------------

proc loadConfig(): FrameConfig =
  var path = getEnv("FRAMEOS_CONFIG")
  if path == "":
    path = DefaultConfigPath
  if not fileExists(path):
    raise newException(IOError, "⚠️  config file not found: " & path)
  let raw = readFile(path)
  result = raw.fromJson(FrameConfig)

# ----------------------------------------------------------------------------
# HMAC helpers
# ----------------------------------------------------------------------------

proc hmacSha256Hex(key, data: string): string =
  ## Return lowercase hex of HMAC-SHA256(key, data).
  let digest = sha256.hmac(key, data) # MDigest[256]
  result = $digest # `$` gives uppercase hex
  result = result.toLowerAscii() # make it lowercase

# ----------------------------------------------------------------------------
# Signing helper – HMAC(secret, apiKey||data)
# ----------------------------------------------------------------------------
proc sign(data: string; cfg: FrameConfig): string =
  ## data   = the “open” string we want to protect
  ## secret = cfg.agent.agentSharedSecret   (never leaves the device)
  ## apiKey = cfg.serverApiKey                (public “username”)
  ##
  ## The server re-creates exactly the same byte-sequence:
  ##   apiKey || data   (no separators, keep order)
  result = hmacSha256Hex(cfg.agent.agentSharedSecret,
                         cfg.serverApiKey & data)

# ----------------------------------------------------------------------------
# Secure frame wrapper
# ----------------------------------------------------------------------------
proc canonical(node: JsonNode): string =
  case node.kind
  of JObject:
    var keys = newSeq[string]()
    for k, _ in node: keys.add k
    keys.sort(cmp)
    result.add('{')
    for i, k in keys:
      if i > 0: result.add(',')
      result.add(k.escapeJson())
      result.add(':')
      result.add(canonical(node[k]))
    result.add('}')
  of JArray:
    result.add('[')
    for i in 0 ..< node.len:
      if i > 0: result.add(',')
      result.add(canonical(node[i]))
    result.add(']')
  of JString:
    result.add(node.getStr().escapeJson())
  of JInt, JFloat, JBool, JNull:
    result = $node

proc makeSecureEnvelope(payload: JsonNode; cfg: FrameConfig): JsonNode =
  let nonce = getTime().toUnix()
  let body = canonical(payload)
  let mac = sign($nonce & body, cfg) # api-key is injected in sign()
  result = %*{
    "nonce": nonce,
    "serverApiKey": cfg.serverApiKey, # visible “username”
    "payload": payload,
    "mac": mac
  }

proc verifyEnvelope(node: JsonNode; cfg: FrameConfig): bool =
  node.hasKey("nonce") and node.hasKey("payload") and node.hasKey("mac") and
  node.hasKey("serverApiKey") and
  node["serverApiKey"].getStr == cfg.serverApiKey and
  node["mac"].getStr.toLowerAscii() ==
    sign($node["nonce"].getInt & canonical(node["payload"]), cfg)

proc sendResp(ws: WebSocket; cfg: FrameConfig;
              id: string; ok: bool; res: JsonNode) {.async.} =
  let env = makeSecureEnvelope(%*{
    "type": "cmd/resp", "id": id, "ok": ok, "result": res
  }, cfg)
  await ws.send($env)

proc streamChunk(ws: WebSocket; cfg: FrameConfig;
                 id: string; which: string; data: string) {.async.} =
  let env = makeSecureEnvelope(%*{
    "type": "cmd/stream", "id": id, "stream": which, "data": data
  }, cfg)
  await ws.send($env)

# ----------------------------------------------------------------------------
# utils – tiny print-and-quit helper
# ----------------------------------------------------------------------------
proc fatal(msg: string; code = 1) =
  ## Print a red "❌" + message to stderr and quit with the given exit code.
  styledWrite(stderr, fgRed, "❌ ")
  stderr.writeLine msg
  quit(code)

proc recvText(ws: WebSocket): Future[string] {.async.} =
  ## Wait for the next *text* frame, replying to pings automatically.
  while true:
    let (opcode, payload) = await ws.receivePacket()
    case opcode
    of Opcode.Text:
      return cast[string](payload)
    of Opcode.Ping:
      await ws.send(payload, OpCode.Pong) # keep-alive
    of Opcode.Close:
      # payload = 2-byte status code (BE) + optional UTF-8 reason
      if payload.len >= 2:
        let code = (uint16(payload[0]) shl 8) or uint16(payload[1])
        let reason = if payload.len > 2:
                       cast[string](payload[2 .. ^1])
                     else: ""
        raise newException(Exception,
          &"connection closed by server (code {code}): {reason}")
      else:
        raise newException(Exception, "connection closed by server")
    else:
      discard # ignore binary, pong …

proc recvBinary(ws: WebSocket): Future[string] {.async.} =
  ## Wait for the next *binary* frame, replying to pings automatically.
  while true:
    let (opcode, payload) = await ws.receivePacket()
    case opcode
    of Opcode.Binary:
      return cast[string](payload)
    of Opcode.Ping:
      await ws.send(payload, OpCode.Pong)
    of Opcode.Close:
      if payload.len >= 2:
        let code = (uint16(payload[0]) shl 8) or uint16(payload[1])
        let reason = if payload.len > 2:
                       cast[string](payload[2 .. ^1])
                     else: ""
        raise newException(Exception,
          &"connection closed by server (code {code}): {reason}")
      else:
        raise newException(Exception, "connection closed by server")
    else:
      discard # ignore text, pong …

# TODO: split stdout and stderr
proc execShellSimple(rawCmd: string;
                     ws: WebSocket;
                     cfg: FrameConfig;
                     id: string): Future[void] {.async.} =
  var p = startProcess("/usr/bin/env",
                       args = ["bash", "-c", rawCmd],
                       options = {poUsePath, poStdErrToStdOut}) # <- merge stderr

  var line: string
  while p.outputStream.readLine(line):
    await streamChunk(ws, cfg, id, "stdout", line & '\n')

  let rc = p.waitForExit() # closes pipe & reaps the child
  await sendResp(ws, cfg, id, rc == 0, %*{"exit": rc})

# ----------------------------------------------------------------------------
# All command handlers
# ----------------------------------------------------------------------------
proc handleCmd(cmd: JsonNode; ws: WebSocket; cfg: FrameConfig): Future[void] {.async.} =
  let id = cmd{"id"}.getStr()
  let name = cmd{"name"}.getStr()
  let args = cmd{"args"}

  echo &"📥 cmd: {name}({args})"

  # No remote execution available
  if not cfg.agent.agentRunCommands:
    if name != "version": # only allow "version" command
      await sendResp(ws, cfg, id, false, %*{"error": "agentRunCommands disabled in config"})
      return

  try:
    case name
    of "version":
      await sendResp(ws, cfg, id, true, %*{"version": "0.0.0"})

    of "http":
      let methodArg = args{"method"}.getStr("GET")
      let path = args{"path"}.getStr("/")
      let bodyArg = args{"body"}.getStr("")

      var client = newAsyncHttpClient()
      if args.hasKey("headers"):
        for k, v in args["headers"].pairs:
          try:
            client.headers.add(k, v.getStr())
          except Exception:
            discard # ignore malformed header values
      let url = &"http://127.0.0.1:{cfg.framePort}{path}"
      let resp = await (if methodArg == "POST": client.post(url, bodyArg) else: client.get(url))

      let bodyBytes = await resp.body # raw bytes
      var hdrs = %*{}
      for k, v in resp.headers: hdrs[k.toLowerAscii()] = %*v

      # ---------- send binary when body is not UTF-8 ---------- #
      let isBinary = bodyBytes.validateUtf8() >= 0
      if isBinary:
        # ── 1. stream the bytes FIRST ───────────────────────────────
        var sent = 0
        const chunk = 65536
        while sent < bodyBytes.len:
          let endPos = min(sent + chunk, bodyBytes.len)
          await ws.send(bodyBytes[sent ..< endPos], OpCode.Binary)
          sent = endPos

        # ── 2. JSON reply AFTER all chunks ──────────────────────────
        await sendResp(ws, cfg, id, true, %*{
          "status": resp.code.int,
          "size": bodyBytes.len,
          "headers": hdrs,
          "binary": true # flag for backend
        })
      else:
        await sendResp(
          ws, cfg, id, true,
          %*{"status": resp.code.int,
              "body": cast[string](bodyBytes),
              "headers": hdrs,
              "binary": false})
    of "shell":
      if not args.hasKey("cmd"):
        await sendResp(ws, cfg, id, false, %*{"error": "`cmd` missing"})
      else:
        asyncCheck execShellSimple(args["cmd"].getStr(), ws, cfg, id)

    of "file_md5":
      let path = args{"path"}.getStr("")
      if path.len == 0:
        await sendResp(ws, cfg, id, false, %*{"error": "`path` missing"})
      elif not fileExists(path):
        await sendResp(ws, cfg, id, true, %*{"exists": false, "md5": ""})
      else:
        let contents = readFile(path)
        let digest = getMD5(contents)
        await sendResp(ws, cfg, id, true,
                       %*{"exists": true, "md5": $digest.toLowerAscii()})

    of "file_read":
      let path = args{"path"}.getStr("")
      if path.len == 0:
        await sendResp(ws, cfg, id, false, %*{"error": "`path` missing"})
      elif not fileExists(path):
        await sendResp(ws, cfg, id, false, %*{"error": "file not found"})
      else:
        let raw = readFile(path)
        let zipped = compress(raw)
        var sent = 0
        const chunkSize = 65536
        while sent < zipped.len:
          let chunkEnd = min(sent + chunkSize, zipped.len)
          await ws.send(zipped[sent ..< chunkEnd], OpCode.Binary)
          sent = chunkEnd
        await sendResp(ws, cfg, id, true, %*{"size": raw.len})

    of "file_write":
      let path = args{"path"}.getStr("")
      let size = args{"size"}.getInt(0) # COMPRESSED size!
      if path.len == 0 or size <= 0:
        await sendResp(ws, cfg, id, false,
                      %*{"error": "`path`/`size` missing"})
        return

      try:
        var buf = newStringUninit(size) # len == size (un‑init)
        var pos = 0

        while pos < size:
          let frame = await recvBinary(ws) # raw WS frame (bytes)
          copyMem(addr buf[pos], unsafeAddr frame[0], frame.len)
          pos += frame.len

        let payload =
          if currentUpload.compression == "zlib":
            uncompress(buf) # zippy
          else:
            buf

        createDir(parentDir(path))
        writeFile(path, payload)
        await sendResp(ws, cfg, id, true, %*{"written": payload.len})
      except CatchableError as e:
        await sendResp(ws, cfg, id, false, %*{"error": e.msg})

    of "file_write_open":
      let path = args["path"].getStr("")
      createDir(parentDir(path))
      currentUpload.fh = open(path, fmWrite)
      currentUpload.compression = args["compression"].getStr("none")
      currentUpload.bytesWritten = 0
      await sendResp(ws, cfg, id, true, %*{})

    of "file_write_chunk":
      if currentUpload.fh.isNil:
        await sendResp(ws, cfg, id, false, %*{"error": "file_write_open missing"})
        return
      let expected = args["size"].getInt()
      var buf = newStringUninit(expected) # one shot, uninitialised
      var pos = 0

      while pos < expected:
        let frame = await recvBinary(ws) # returns raw bytes of a WS frame
        copyMem(addr buf[pos], unsafeAddr frame[0], frame.len)
        pos += frame.len

      let data =
        if currentUpload.compression == "zlib":
          uncompress(buf) # zippy API
        else:
          buf

      write(currentUpload.fh, data)
      currentUpload.bytesWritten += data.len
      await sendResp(ws, cfg, id, true, %*{"written": currentUpload.bytesWritten})

    of "file_write_close":
      if not currentUpload.fh.isNil:
        currentUpload.fh.flushFile()
        currentUpload.fh.close()
      currentUpload = UploadSession() # reset
      await sendResp(ws, cfg, id, true, %*{})

    of "file_delete":
      let path = args{"path"}.getStr("")
      if path.len == 0:
        await sendResp(ws, cfg, id, false, %*{"error": "`path` missing"})
      else:
        try:
          let rc = execShellCmd("rm -rf " & quoteShell(path))
          await sendResp(ws, cfg, id, rc == 0, %*{"exit": rc})
        except CatchableError as e:
          await sendResp(ws, cfg, id, false, %*{"error": e.msg})

    of "file_mkdir":
      let path = args{"path"}.getStr("")
      if path.len == 0:
        await sendResp(ws, cfg, id, false, %*{"error": "`path` missing"})
      else:
        try:
          let rc = execShellCmd("mkdir -p " & quoteShell(path))
          await sendResp(ws, cfg, id, rc == 0, %*{"exit": rc})
        except CatchableError as e:
          await sendResp(ws, cfg, id, false, %*{"error": e.msg})

    of "file_rename":
      let src = args{"src"}.getStr("")
      let dst = args{"dst"}.getStr("")
      if src.len == 0 or dst.len == 0:
        await sendResp(ws, cfg, id, false, %*{"error": "`src`/`dst` missing"})
      else:
        try:
          let rc = execShellCmd("mv " & quoteShell(src) & " " & quoteShell(dst))
          await sendResp(ws, cfg, id, rc == 0, %*{"exit": rc})
        except CatchableError as e:
          await sendResp(ws, cfg, id, false, %*{"error": e.msg})

    of "assets_list":
      let root = args{"path"}.getStr("")
      if root.len == 0:
        await sendResp(ws, cfg, id, false,
                       %*{"error": "`path` missing"})
      elif not dirExists(root):
        await sendResp(ws, cfg, id, false,
                       %*{"error": "dir not found"})
      else:
        var items = newSeq[JsonNode]()
        for path in walkDirRec(root, yieldFilter = {pcFile, pcDir}):
          let fi = getFileInfo(path)
          items.add %*{
            "path": path,
            "size": fi.size,
            "mtime": fi.lastWriteTime.toUnix(),
            "is_dir": dirExists(path)
          }
        await sendResp(ws, cfg, id, true, %*{"assets": items})
    else:
      await sendResp(ws, cfg, id, false,
                     %*{"error": "unknown command: " & name})
  except CatchableError as e:
    await sendResp(ws, cfg, id, false, %*{"error": e.msg})

proc doHandshake(ws: WebSocket; cfg: FrameConfig): Future[void] {.async.} =
  ## Implements the protocol:
  ##   0) agent  → {action:"hello", serverApiKey}
  ##   1) server → {action:"challenge", c:<hex-rand>}
  ##   2) agent  → {action:"handshake", mac:<hmac-sha256(serverApiKey || c, sharedSecret)>}
  ##   3) server → {action:"handshake/ok"}

  if len(cfg.serverApiKey) == 0:
    echo "⚠️  serverApiKey is empty, cannot connect"
    raise newException(Exception, "⚠️  serverApiKey is empty, cannot connect")

  if len(cfg.agent.agentSharedSecret) == 0:
    echo "⚠️  agentSharedSecret is empty, cannot connect"
    raise newException(Exception, "⚠️  agent.agentSharedSecret is empty, cannot connect")

  # --- Step 0: say hello ----------------------------------------------------
  var hello = %*{
    "action": "hello",
    "serverApiKey": cfg.serverApiKey
  }
  await ws.send($hello)

  # --- Step 1: wait for challenge -------------------------------------------
  let challengeMsg = await ws.recvText()
  echo &"🔑 challenge: {challengeMsg}"

  let challengeJson = parseJson(challengeMsg)
  if challengeJson["action"].getStr != "challenge":
    raise newException(Exception,
      "Expected challenge, got: " & challengeMsg)
  let challenge = challengeJson["c"].getStr

  # --- Step 2: answer -------------------------------------------------------
  let mac = if cfg.agent.agentSharedSecret.len > 0:
              sign(challenge, cfg)
            else: ""
  let reply = %*{
    "action": "handshake",
    "mac": mac
  }
  echo &"🔐 reply: {reply}"
  await ws.send($reply)

  # --- Step 3: await OK ---------------------------------
  let ackMsg = await ws.recvText()
  let ack = parseJson(ackMsg)
  let act = ack["action"].getStr
  case act
  of "handshake/ok":
    echo "✅ handshake done"
  else:
    echo &"⚠️ handshake failed, unexpected action: {act} in {ackMsg}"
    raise newException(Exception, "Handshake failed: " & ackMsg)

proc startHeartbeat(ws: WebSocket; cfg: FrameConfig): Future[void] {.async.} =
  ## Keeps server-side idle-timeout at bay.
  try:
    while true:
      await sleepAsync(40_000)
      let env = makeSecureEnvelope(%*{"type": "heartbeat"}, cfg)
      await ws.send($env)
  except Exception: discard # will quit when ws closes / errors out

proc calcBackoff(elapsed: int): int =
  result = elapsed div 60 # whole minutes since disconnect
  if result < 3: result = 3
  if result > MaxBackoffSeconds: result = MaxBackoffSeconds

# ----------------------------------------------------------------------------
# Run-forever loop with exponential back-off
# ----------------------------------------------------------------------------

proc runAgent(cfg: FrameConfig) {.async.} =
  var disconnectAt = getMonoTime()
  var wasConnected = false # did we ever finish handshake?
  while true:
    try:
      # --- Connect ----------------------------------------------------------
      let port = (if cfg.serverPort <= 0: 443 else: cfg.serverPort)
      let scheme = (if port mod 1000 == 443: "wss" else: "ws")
      let url = &"{scheme}://{cfg.serverHost}:{port}/ws/agent"
      echo &"🔗 Connecting → {url} …"

      var ws = await newWebSocket(url)
      try:
        await doHandshake(ws, cfg) # throws on failure
        wasConnected = true # handshake succeeded

        asyncCheck startHeartbeat(ws, cfg)

        # ── Main receive loop ───────────────────────────────────────────────
        while true:
          let raw = await ws.recvText()
          let node = parseJson(raw)
          if not verifyEnvelope(node, cfg):
            echo "⚠️  bad MAC – dropping packet"; continue
          let payload = node["payload"]
          case payload{"type"}.getStr("")
          of "cmd":
            await handleCmd(payload, ws, cfg)
          else:
            echo &"📥 {payload}"

      finally:
        if not ws.isNil:
          ws.close()

    except Exception as e:
      echo &"⚠️  connection error: {e.msg}"

    # --- Back-off & retry ----------------------------------------------------
    if wasConnected:
      disconnectAt = getMonoTime()
      wasConnected = false
    let elapsed = (getMonoTime() - disconnectAt).inSeconds.int
    let backoff = min(calcBackoff(elapsed), MaxBackoffSeconds)
    echo &"⏳ reconnecting in {backoff}s (disconnected {elapsed}s)…"
    await sleepAsync(backoff * 1_000)

# ----------------------------------------------------------------------------
# Program entry
# ----------------------------------------------------------------------------

when isMainModule:
  try:
    var cfg = loadConfig()
    if not cfg.agent.agentEnabled:
      echo "ℹ️  agentEnabled = false  →  no websocket connection started. Exiting in 10s."
      waitFor sleepAsync(10_000)
      quit(0) # graceful, zero-exit

    waitFor runAgent(cfg)
  except Exception as e:
    fatal(e.msg)
