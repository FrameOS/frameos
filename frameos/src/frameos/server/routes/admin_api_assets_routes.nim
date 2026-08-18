import json
import base64
import times
import std/[os, strformat, strutils, tables]
import pixie
import frameos/utils/image
import checksums/md5
import mummy
import mummy/routers
import httpcore
import ../auth
import ../api
import ../state
import ./common

# mummy buffers whole responses in RAM, and assets can include multi-hundred
# MB videos: serving one of those would blow straight through MemoryMax and
# OOM-kill the service. Refuse anything bigger than this.
const MaxAssetDownloadBytes* = 50 * 1024 * 1024

# Asset thumbnails. Longest edge, and the cache filename/content type that go
# with it. PNG because Pixie decodes eleven formats and encodes no JPEG; the
# alternative was keeping the ImageMagick `convert` shell-out this replaced,
# and ImageMagick is on no image FrameOS ships any more — which made every
# thumbnail on a Buildroot frame a 500, in the admin panel, the backend's
# frame API and the cloud's asset browser alike.
const
  ThumbnailMaxEdge* = 320
  ThumbnailFileSuffix* = ".320x320.png"
  ThumbnailContentType* = "image/png"

proc contentTypeForAsset*(path: string): string =
  if path.endsWith(".css"):
    "text/css"
  elif path.endsWith(".js"):
    "application/javascript"
  elif path.endsWith(".svg"):
    "image/svg+xml"
  elif path.endsWith(".png"):
    "image/png"
  elif path.endsWith(".woff2"):
    "font/woff2"
  elif path.endsWith(".woff"):
    "font/woff"
  else:
    "application/octet-stream"

proc configuredAssetsPath*(): string =
  normalizedPath(if globalFrameConfig.assetsPath.len > 0: globalFrameConfig.assetsPath else: "/srv/assets")

proc uploadChunkTempRoot(): string =
  normalizedPath(getTempDir() / "frameos-upload-chunks")

proc withinBasePath*(path, basePath: string): bool =
  let normalizedTargetPath = normalizedPath(path)
  let normalizedBasePath = normalizedPath(basePath)
  return normalizedTargetPath == normalizedBasePath or normalizedTargetPath.startsWith(normalizedBasePath & DirSep)

proc sanitizeAssetComponent(value: string, fallback: string, allowDot = false): string =
  result = ""
  for ch in value:
    if ch.isAlphaNumeric() or ch in {'-', '_'} or (allowDot and ch == '.'):
      result.add(ch)
    else:
      result.add('_')
  result = result.strip(chars = {'_', '.'})
  if result.len == 0:
    result = fallback

proc sanitizeAssetExtension(value: string): string =
  result = ""
  for ch in value:
    if ch == '.' or ch.isAlphaNumeric():
      result.add(ch)
  if result.len > 0 and not result.startsWith("."):
    result = "." & result

proc sanitizeUploadId(uploadId: string): string =
  let safeId = sanitizeAssetComponent(uploadId, "")
  if safeId.len == 0:
    raise newException(ValueError, "Missing upload id")
  safeId

proc uploadChunkTempPath(uploadId: string): string =
  normalizedPath(uploadChunkTempRoot() / (sanitizeUploadId(uploadId) & ".part"))

proc resolveAssetPath*(path: string, allowRoot = false): string =
  let assetsPath = configuredAssetsPath()
  let stripped = path.strip()
  if stripped.len == 0:
    if allowRoot:
      return assetsPath
    raise newException(ValueError, "Path is required")

  var relPath = stripped
  while relPath.startsWith("./"):
    relPath = relPath[2 .. ^1]
  while relPath.startsWith("/"):
    relPath = relPath[1 .. ^1]

  let fullPath = normalizedPath(assetsPath / relPath)
  if not withinBasePath(fullPath, assetsPath):
    raise newException(ValueError, "Invalid asset path")
  if not allowRoot and fullPath == assetsPath:
    raise newException(ValueError, "Path is required")
  fullPath

proc relativeAssetPath*(path: string): string =
  let assetsPath = configuredAssetsPath()
  let fullPath = normalizedPath(path)
  if fullPath == assetsPath:
    ""
  else:
    fullPath[(assetsPath.len + 1) .. ^1]

proc resolveAssetUploadPath(subdir: string, filename: string): string =
  let safeFilename = sanitizeAssetComponent(extractFilename(filename), "uploaded_file", allowDot = true)
  if subdir.strip().len == 0:
    resolveAssetPath(safeFilename)
  else:
    resolveAssetPath(subdir / safeFilename)

proc contentTypeForFilePath*(path: string): string =
  let lowerPath = path.toLowerAscii()
  if lowerPath.endsWith(".png"):
    return "image/png"
  if lowerPath.endsWith(".jpg") or lowerPath.endsWith(".jpeg"):
    return "image/jpeg"
  if lowerPath.endsWith(".webp"):
    return "image/webp"
  if lowerPath.endsWith(".gif"):
    return "image/gif"
  if lowerPath.endsWith(".svg"):
    return "image/svg+xml"
  contentTypeForAsset(lowerPath)

proc assetPayloadForPath*(path: string): JsonNode =
  let fullPath = normalizedPath(path)
  let isDir = dirExists(fullPath)
  let info = getFileInfo(fullPath)
  %*{
    "path": fullPath,
    "size": if isDir: BiggestInt(0) else: info.size,
    "mtime": info.lastWriteTime.toUnix(),
    "is_dir": isDir,
  }

proc decodeDataUrlPayload*(value: string): string =
  let commaIndex = value.find(',')
  if commaIndex < 0:
    raise newException(ValueError, "Invalid upload payload")
  let header = value[0 ..< commaIndex]
  if ";base64" notin header:
    raise newException(ValueError, "Invalid upload payload")
  decode(value[(commaIndex + 1) .. ^1])

proc saveAssetUploadPayload*(subdir: string, filename: string, data: string): JsonNode =
  let targetPath = resolveAssetUploadPath(subdir, filename)
  createDir(parentDir(targetPath))
  writeFile(targetPath, data)
  assetPayloadForPath(targetPath)

proc saveUploadedImagePayload*(filename: string, data: string): JsonNode =
  let originalName = extractFilename(if filename.strip().len > 0: filename else: "image")
  let (_, name, ext) = splitFile(originalName)
  let safeBase = sanitizeAssetComponent(name, "image")
  let safeExt = sanitizeAssetExtension(ext)
  let hashedFilename = &"{safeBase}.{getMD5(data)}{safeExt}"
  let targetPath = resolveAssetPath("uploads" / hashedFilename)
  createDir(parentDir(targetPath))
  let uploaded = not fileExists(targetPath)
  if uploaded:
    writeFile(targetPath, data)
  %*{
    "path": relativeAssetPath(targetPath),
    "filename": hashedFilename,
    "size": data.len,
    "uploaded": uploaded,
  }

proc createAssetDirectory*(path: string) =
  createDir(resolveAssetPath(path))

proc appendUploadChunk*(uploadId: string, chunkIndex: int, data: string) =
  let tempPath = uploadChunkTempPath(uploadId)
  createDir(parentDir(tempPath))
  var fileHandle = open(tempPath, if chunkIndex <= 0: fmWrite else: fmAppend)
  try:
    fileHandle.write(data)
  finally:
    fileHandle.close()

proc discardUploadChunk*(uploadId: string) =
  let tempPath = uploadChunkTempPath(uploadId)
  if fileExists(tempPath):
    removeFile(tempPath)

# ---------------------------------------------------------------------------
# Offset-addressed chunked uploads (the cloud's `asset_put_chunk` verb).
#
# appendUploadChunk above appends blindly, which is what the local admin's
# per-request uploads want and exactly what a retried chunk must not do:
# hub delivery is at-least-once, so a chunk can arrive twice. These parts
# are addressed by offset instead — offset 0 starts the part, a later chunk
# must land at or before the part's current end (a hole means an earlier
# chunk was lost and the sender restarts: "chunk_gap"), and a resent chunk
# overwrites itself. Same idea as the ESP32's fos_assets_chunk_begin.
# ---------------------------------------------------------------------------

const
  # Parts left behind by an upload that never completed (the provider gave up,
  # the link died mid-file) are swept on the next session start once older
  # than this. Long enough for a slow link to finish a big file; short enough
  # that a dead upload does not hold disk for a day.
  CloudUploadPartMaxAgeSeconds* = 6 * 60 * 60

proc cloudUploadPartPath(uploadId: string): string =
  normalizedPath(uploadChunkTempRoot() / ("cloud-" & sanitizeUploadId(uploadId) & ".part"))

proc writeAssetUploadChunk*(uploadId: string, offset: BiggestInt, data: string): BiggestInt =
  ## Write `data` at `offset` into the upload's part file and return the
  ## part's size afterwards. Raises ValueError("chunk_gap") when `offset` lies
  ## past what has landed so far.
  let partPath = cloudUploadPartPath(uploadId)
  createDir(parentDir(partPath))
  if offset <= 0:
    # First (or restarted) chunk: whatever was there is a previous attempt.
    writeFile(partPath, data)
    return data.len.BiggestInt
  if not fileExists(partPath) or getFileSize(partPath) < offset:
    raise newException(ValueError, "chunk_gap")
  var fileHandle = open(partPath, fmReadWriteExisting)
  try:
    fileHandle.setFilePos(offset)
    fileHandle.write(data)
  finally:
    fileHandle.close()
  getFileSize(partPath)

proc finishAssetUploadChunks*(uploadId: string, path: string): JsonNode =
  ## Move the finished part to `path` inside the assets directory, sanitizing
  ## the filename exactly like a single-shot upload. Returns the stored entry
  ## with an ABSOLUTE path (assetPayloadForPath); callers relativize.
  let partPath = cloudUploadPartPath(uploadId)
  if not fileExists(partPath):
    raise newException(OSError, "Upload not found")
  let (dir, name, ext) = splitFile(path)
  let targetPath = resolveAssetUploadPath(dir, name & ext)
  createDir(parentDir(targetPath))
  if dirExists(targetPath):
    raise newException(ValueError, "Invalid asset path")
  if fileExists(targetPath):
    removeFile(targetPath)
  moveFile(partPath, targetPath)
  assetPayloadForPath(targetPath)

proc discardAssetUploadChunks*(uploadId: string) =
  let partPath = cloudUploadPartPath(uploadId)
  if fileExists(partPath):
    removeFile(partPath)

proc cleanupStaleAssetUploadChunks*(maxAgeSeconds = CloudUploadPartMaxAgeSeconds) =
  ## Delete cloud upload parts nobody has touched for `maxAgeSeconds`.
  let root = uploadChunkTempRoot()
  if not dirExists(root):
    return
  let cutoff = getTime() - initDuration(seconds = maxAgeSeconds)
  for kind, filePath in walkDir(root):
    if kind != pcFile:
      continue
    let fileName = extractFilename(filePath)
    if not (fileName.startsWith("cloud-") and fileName.endsWith(".part")):
      continue
    try:
      if getFileInfo(filePath).lastWriteTime < cutoff:
        removeFile(filePath)
    except CatchableError:
      discard

proc finishChunkedAssetUpload*(uploadId: string, subdir: string, filename: string): JsonNode =
  let tempPath = uploadChunkTempPath(uploadId)
  if not fileExists(tempPath):
    raise newException(OSError, "Upload not found")
  let targetPath = resolveAssetUploadPath(subdir, filename)
  createDir(parentDir(targetPath))
  if dirExists(targetPath):
    raise newException(ValueError, "Invalid asset path")
  if fileExists(targetPath):
    removeFile(targetPath)
  moveFile(tempPath, targetPath)
  assetPayloadForPath(targetPath)

proc finishChunkedImageUpload*(uploadId: string, filename: string): JsonNode =
  let tempPath = uploadChunkTempPath(uploadId)
  if not fileExists(tempPath):
    raise newException(OSError, "Upload not found")
  try:
    saveUploadedImagePayload(filename, readFile(tempPath))
  finally:
    discardUploadChunk(uploadId)

proc deleteAssetEntry*(path: string) =
  let targetPath = resolveAssetPath(path)
  if fileExists(targetPath):
    removeFile(targetPath)
  elif dirExists(targetPath):
    removeDir(targetPath)
  else:
    raise newException(OSError, "Asset not found")

proc renameAssetEntry*(srcPath: string, dstPath: string) =
  let sourcePath = resolveAssetPath(srcPath)
  let targetPath = resolveAssetPath(dstPath)
  if not fileExists(sourcePath) and not dirExists(sourcePath):
    raise newException(OSError, "Asset not found")
  createDir(parentDir(targetPath))
  if dirExists(sourcePath):
    moveDir(sourcePath, targetPath)
  else:
    moveFile(sourcePath, targetPath)

proc frameAssetsPayload*(): JsonNode =
  let assetsPath = configuredAssetsPath()
  var assets: seq[JsonNode] = @[]
  if not dirExists(assetsPath):
    return %*[]

  proc addAsset(path: string, kind: PathComponent) =
    if kind notin {pcDir, pcFile}:
      return
    try:
      let info = getFileInfo(path)
      assets.add(%*{
        "path": path,
        "size": if kind == pcFile: info.size else: BiggestInt(0),
        "mtime": info.lastWriteTime.toUnix(),
        "is_dir": kind == pcDir,
      })
    except CatchableError:
      discard

  for kind, path in walkDir(assetsPath, relative = false):
    if kind == pcDir:
      addAsset(path, kind)

  for filePath in walkDirRec(assetsPath, relative = false):
    addAsset(filePath, pcFile)

  return %*assets

proc writeThumbnail*(sourcePath, thumbPath: string) =
  ## Renders one cached thumbnail, in-process and inside the render memory
  ## budget: the decode is asked for no more than a thumbnail's worth of
  ## pixels up front, so a 40-megapixel photo never materialises full size to
  ## be thrown away a moment later. Writes via a temp file so a concurrent
  ## request for the same asset can never read a half-written cache entry.
  var image = readImageWithDisplayBounds(sourcePath,
    maxEdge = ThumbnailMaxEdge, maxPixels = ThumbnailMaxEdge * ThumbnailMaxEdge)
  # Fit inside the box, never crop, never upscale — `convert -thumbnail
  # 320x320` semantics. The bounded decode usually lands here already; a
  # format whose decoder cannot scale on the way in arrives full size.
  if image.width > ThumbnailMaxEdge or image.height > ThumbnailMaxEdge:
    let scale = min(ThumbnailMaxEdge / image.width, ThumbnailMaxEdge / image.height)
    image = image.resize(
      max(1, (image.width.float * scale).int),
      max(1, (image.height.float * scale).int))
  let tempPath = thumbPath & "." & $getThreadId() & ".tmp"
  writeFile(tempPath, image.encodeImage(PngFormat))
  moveFile(tempPath, thumbPath)

proc getAssetPayload*(path: string, thumb: bool): tuple[status: httpcore.HttpCode, headers: mummy.HttpHeaders, body: string] =
  let assetsPath = configuredAssetsPath()
  let relPath = path.strip()
  if relPath.len == 0:
    var headers: mummy.HttpHeaders
    headers["Content-Type"] = "application/json"
    return (Http400, headers, $(%*{"detail": "Path is required"}))

  let fullPath =
    try:
      resolveAssetPath(relPath)
    except ValueError:
      var headers: mummy.HttpHeaders
      headers["Content-Type"] = "application/json"
      return (Http400, headers, $(%*{"detail": "Invalid path"}))
  if not withinBasePath(fullPath, assetsPath):
    var headers: mummy.HttpHeaders
    headers["Content-Type"] = "application/json"
    return (Http400, headers, $(%*{"detail": "Invalid path"}))
  if not fileExists(fullPath):
    var headers: mummy.HttpHeaders
    headers["Content-Type"] = "application/json"
    return (Http404, headers, $(%*{"detail": "Asset not found"}))

  if not thumb:
    var headers: mummy.HttpHeaders
    let fileSize = getFileSize(fullPath)
    if fileSize > MaxAssetDownloadBytes:
      headers["Content-Type"] = "application/json"
      return (Http413, headers, $(%*{
        "detail": &"Asset is {fileSize} bytes; downloads over this endpoint are capped at {MaxAssetDownloadBytes} bytes"
      }))
    headers["Content-Type"] = contentTypeForFilePath(fullPath)
    return (Http200, headers, readFile(fullPath))

  let fullMd5 = getMD5(fullPath)
  let thumbRoot = assetsPath / ".thumbs"
  let thumbPath = normalizedPath(thumbRoot / (fullMd5 & ThumbnailFileSuffix))
  if not withinBasePath(thumbPath, thumbRoot):
    var headers: mummy.HttpHeaders
    headers["Content-Type"] = "application/json"
    return (Http400, headers, $(%*{"detail": "Invalid thumbnail path"}))

  try:
    if not fileExists(thumbPath):
      createDir(parentDir(thumbPath))
      writeThumbnail(fullPath, thumbPath)
    var headers: mummy.HttpHeaders
    headers["Content-Type"] = ThumbnailContentType
    return (Http200, headers, readFile(thumbPath))
  except PixieError as e:
    var headers: mummy.HttpHeaders
    headers["Content-Type"] = "application/json"
    return (Http500, headers, $(%*{"detail": "Failed to generate thumbnail", "error": e.msg}))
  except CatchableError as e:
    var headers: mummy.HttpHeaders
    headers["Content-Type"] = "application/json"
    return (Http500, headers, $(%*{"detail": "Failed to fetch asset", "error": e.msg}))

proc handleAssetsUpload*(request: Request) {.gcsafe.} =
  if not hasAdminAccess(request):
    request.respond(Http401, body = "Unauthorized")
    return
  {.gcsafe.}:
    if not requestedFrameMatches(request):
      request.respond(Http404, body = "Not found!")
    else:
      try:
        if request.queryParams.contains("upload_id"):
          let chunkIndex =
            try:
              parseInt(request.queryParams.getOrDefault("chunk_index", "0"))
            except ValueError:
              0
          appendUploadChunk(request.queryParams["upload_id"], chunkIndex, request.body)
          if request.queryParams.getOrDefault("complete", "") == "1":
            jsonResponse(
              request,
              Http200,
              finishChunkedAssetUpload(
                request.queryParams["upload_id"],
                request.queryParams.getOrDefault("path", ""),
                request.queryParams.getOrDefault("filename", "uploaded_file")
              )
            )
          else:
            jsonResponse(request, Http200, %*{"status": "partial"})
        else:
          let payload = parseJson(if request.body == "": "{}" else: request.body)
          let path = payload{"path"}.getStr("")
          let filename = payload{"filename"}.getStr("uploaded_file")
          let dataUrl = payload{"data_url"}.getStr("")
          if dataUrl.len == 0:
            jsonResponse(request, Http400, %*{"detail": "Missing upload payload"})
            return
          let asset = saveAssetUploadPayload(path, filename, decodeDataUrlPayload(dataUrl))
          jsonResponse(request, Http200, asset)
      except ValueError as e:
        jsonResponse(request, Http400, %*{"detail": e.msg})
      except OSError:
        jsonResponse(request, Http404, %*{"detail": "Upload not found"})
      except CatchableError as e:
        jsonResponse(request, Http500, %*{"detail": e.msg})

proc handleAssetsMkdir*(request: Request) {.gcsafe.} =
  if not hasAdminAccess(request):
    request.respond(Http401, body = "Unauthorized")
    return
  {.gcsafe.}:
    if not requestedFrameMatches(request):
      request.respond(Http404, body = "Not found!")
    else:
      try:
        let params = parseUrlEncoded(request.body)
        createAssetDirectory(if params.hasKey("path"): params["path"] else: "")
        jsonResponse(request, Http200, %*{"message": "Created"})
      except ValueError as e:
        jsonResponse(request, Http400, %*{"detail": e.msg})
      except CatchableError as e:
        jsonResponse(request, Http500, %*{"detail": e.msg})

proc handleAssetsDelete*(request: Request) {.gcsafe.} =
  if not hasAdminAccess(request):
    request.respond(Http401, body = "Unauthorized")
    return
  {.gcsafe.}:
    if not requestedFrameMatches(request):
      request.respond(Http404, body = "Not found!")
    else:
      try:
        let params = parseUrlEncoded(request.body)
        deleteAssetEntry(if params.hasKey("path"): params["path"] else: "")
        jsonResponse(request, Http200, %*{"message": "Deleted"})
      except ValueError as e:
        jsonResponse(request, Http400, %*{"detail": e.msg})
      except OSError:
        jsonResponse(request, Http404, %*{"detail": "Asset not found"})
      except CatchableError as e:
        jsonResponse(request, Http500, %*{"detail": e.msg})

proc handleAssetsRename*(request: Request) {.gcsafe.} =
  if not hasAdminAccess(request):
    request.respond(Http401, body = "Unauthorized")
    return
  {.gcsafe.}:
    if not requestedFrameMatches(request):
      request.respond(Http404, body = "Not found!")
    else:
      try:
        let params = parseUrlEncoded(request.body)
        renameAssetEntry(
          if params.hasKey("src"): params["src"] else: "",
          if params.hasKey("dst"): params["dst"] else: ""
        )
        jsonResponse(request, Http200, %*{"message": "Renamed"})
      except ValueError as e:
        jsonResponse(request, Http400, %*{"detail": e.msg})
      except OSError:
        jsonResponse(request, Http404, %*{"detail": "Asset not found"})
      except CatchableError as e:
        jsonResponse(request, Http500, %*{"detail": e.msg})


proc addAdminApiAssetRoutes*(router: var Router) =
  router.get("/api/admin/frames/@id/assets", proc(request: Request) {.gcsafe.} =
    if not hasAdminAccess(request):
      request.respond(Http401, body = "Unauthorized")
      return
    {.gcsafe.}:
      if not requestedFrameMatches(request):
        request.respond(Http404, body = "Not found!")
      else:
        jsonResponse(request, Http200, %*{"assets": frameAssetsPayload()})
  )

  router.get("/api/admin/frames/@id/asset", proc(request: Request) {.gcsafe.} =
    if not hasAdminAccess(request):
      request.respond(Http401, body = "Unauthorized")
      return
    {.gcsafe.}:
      if not requestedFrameMatches(request):
        request.respond(Http404, body = "Not found!")
      else:
        let path = request.queryParams.getOrDefault("path", "")
        let thumb = request.queryParams.getOrDefault("thumb", "") == "1"
        let (status, headers, body) = getAssetPayload(path, thumb)
        request.respond(status, headers, body)
  )

  router.post("/api/admin/frames/@id/assets/upload", handleAssetsUpload)
  # Canonical frame API (docs/api-triality.md). Same handler, same
  # hasAdminAccess check the admin route makes — the two paths differ only
  # in name, so the shared frontend can call the canonical one on a Pi the
  # way it already does on the backend and the ESP32.
  router.post("/api/frames/@id/assets/upload", handleAssetsUpload)

  router.post("/api/admin/frames/@id/assets/upload_image", proc(request: Request) {.gcsafe.} =
    if not hasAdminAccess(request):
      request.respond(Http401, body = "Unauthorized")
      return
    {.gcsafe.}:
      if not requestedFrameMatches(request):
        request.respond(Http404, body = "Not found!")
      else:
        try:
          if request.queryParams.contains("upload_id"):
            let chunkIndex =
              try:
                parseInt(request.queryParams.getOrDefault("chunk_index", "0"))
              except ValueError:
                0
            appendUploadChunk(request.queryParams["upload_id"], chunkIndex, request.body)
            if request.queryParams.getOrDefault("complete", "") == "1":
              jsonResponse(
                request,
                Http200,
                finishChunkedImageUpload(
                  request.queryParams["upload_id"],
                  request.queryParams.getOrDefault("filename", "image")
                )
              )
            else:
              jsonResponse(request, Http200, %*{"status": "partial"})
          else:
            let payload = parseJson(if request.body == "": "{}" else: request.body)
            let filename = payload{"filename"}.getStr("image")
            let dataUrl = payload{"data_url"}.getStr("")
            if dataUrl.len == 0:
              jsonResponse(request, Http400, %*{"detail": "Missing upload payload"})
              return
            jsonResponse(request, Http200, saveUploadedImagePayload(filename, decodeDataUrlPayload(dataUrl)))
        except ValueError as e:
          jsonResponse(request, Http400, %*{"detail": e.msg})
        except OSError:
          jsonResponse(request, Http404, %*{"detail": "Upload not found"})
        except CatchableError as e:
          jsonResponse(request, Http500, %*{"detail": e.msg})
  )

  router.post("/api/admin/frames/@id/assets/mkdir", handleAssetsMkdir)
  # Canonical frame API (docs/api-triality.md). Same handler, same
  # hasAdminAccess check the admin route makes — the two paths differ only
  # in name, so the shared frontend can call the canonical one on a Pi the
  # way it already does on the backend and the ESP32.
  router.post("/api/frames/@id/assets/mkdir", handleAssetsMkdir)

  router.post("/api/admin/frames/@id/assets/delete", handleAssetsDelete)
  # Canonical frame API (docs/api-triality.md). Same handler, same
  # hasAdminAccess check the admin route makes — the two paths differ only
  # in name, so the shared frontend can call the canonical one on a Pi the
  # way it already does on the backend and the ESP32.
  router.post("/api/frames/@id/assets/delete", handleAssetsDelete)

  router.post("/api/admin/frames/@id/assets/rename", handleAssetsRename)
  # Canonical frame API (docs/api-triality.md). Same handler, same
  # hasAdminAccess check the admin route makes — the two paths differ only
  # in name, so the shared frontend can call the canonical one on a Pi the
  # way it already does on the backend and the ESP32.
  router.post("/api/frames/@id/assets/rename", handleAssetsRename)
