import json
import base64
import times
import std/[os, osproc, strformat, strutils, tables]
import checksums/md5
import mummy
import mummy/routers
import httpcore
import ../auth
import ../api
import ../state
import ./common

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
    headers["Content-Type"] = contentTypeForFilePath(fullPath)
    return (Http200, headers, readFile(fullPath))

  let fullMd5 = getMD5(fullPath)
  let thumbRoot = assetsPath / ".thumbs"
  let thumbPath = normalizedPath(thumbRoot / (fullMd5 & ".320x320.jpg"))
  if not withinBasePath(thumbPath, thumbRoot):
    var headers: mummy.HttpHeaders
    headers["Content-Type"] = "application/json"
    return (Http400, headers, $(%*{"detail": "Invalid thumbnail path"}))

  try:
    if not fileExists(thumbPath):
      createDir(parentDir(thumbPath))
      let cmd = "convert " & quoteShell(fullPath) & " -thumbnail 320x320 " & quoteShell(thumbPath)
      let (output, exitCode) = execCmdEx(cmd)
      if exitCode != 0:
        var headers: mummy.HttpHeaders
        headers["Content-Type"] = "application/json"
        return (Http500, headers, $(%*{"detail": "Failed to generate thumbnail", "error": output}))
    var headers: mummy.HttpHeaders
    headers["Content-Type"] = "image/jpeg"
    return (Http200, headers, readFile(thumbPath))
  except CatchableError as e:
    var headers: mummy.HttpHeaders
    headers["Content-Type"] = "application/json"
    return (Http500, headers, $(%*{"detail": "Failed to fetch asset", "error": e.msg}))

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

  router.post("/api/admin/frames/@id/assets/upload", proc(request: Request) {.gcsafe.} =
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
  )

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

  router.post("/api/admin/frames/@id/assets/mkdir", proc(request: Request) {.gcsafe.} =
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
  )

  router.post("/api/admin/frames/@id/assets/delete", proc(request: Request) {.gcsafe.} =
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
  )

  router.post("/api/admin/frames/@id/assets/rename", proc(request: Request) {.gcsafe.} =
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
  )
