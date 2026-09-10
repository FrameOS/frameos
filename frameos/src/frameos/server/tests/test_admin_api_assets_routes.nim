import unittest
import os
import strutils
import mummy
import json
import httpcore
import pixie

import ../routes/admin_api_assets_routes
import ../state
import ../../types

proc baseConfig(assetsPath = ""): FrameConfig =
  FrameConfig(
    name: "Unit Frame",
    mode: "web_only",
    frameHost: "localhost",
    framePort: 8787,
    frameAccess: "private",
    frameAccessKey: "test-key",
    frameAdminAuth: %*{},
    serverHost: "localhost",
    serverPort: 8989,
    serverApiKey: "api",
    width: 800,
    height: 480,
    rotate: 0,
    flip: "",
    scalingMode: "contain",
    device: "web_only",
    metricsInterval: 60,
    assetsPath: assetsPath,
    saveAssets: %*(false),
    network: NetworkConfig(networkCheck: false),
  )

suite "Server admin api asset helpers":
  test "content type for compiled web assets":
    check contentTypeForAsset("bundle.css") == "text/css"
    check contentTypeForAsset("bundle.js") == "application/javascript"
    check contentTypeForAsset("font.woff2") == "font/woff2"

  test "scene-writable assets go out inert: nosniff, sandboxed, active types as downloads":
    for active in ["image/svg+xml", "application/javascript", "text/css", "text/html; charset=utf-8"]:
      check isActiveContentType(active)
    for inert in ["image/png", "image/jpeg", "font/woff2", "application/octet-stream"]:
      check not isActiveContentType(inert)
    var headers: mummy.HttpHeaders
    setInertAssetHeaders(headers, "image/svg+xml", "/srv/assets/evil\"name.svg")
    check headers["Content-Type"] == "image/svg+xml"
    check headers["X-Content-Type-Options"] == "nosniff"
    check headers["Content-Security-Policy"] == "default-src 'none'; sandbox"
    check headers["Content-Disposition"] == "attachment; filename=\"evil_name.svg\""
    var image: mummy.HttpHeaders
    setInertAssetHeaders(image, "image/png", "/srv/assets/a.png")
    check image["X-Content-Type-Options"] == "nosniff"
    check not image.contains("Content-Disposition")

  test "content type for regular files":
    check contentTypeForFilePath("image.png") == "image/png"
    check contentTypeForFilePath("image.jpeg") == "image/jpeg"
    check contentTypeForFilePath("image.webp") == "image/webp"

  test "path containment checks":
    check withinBasePath("/tmp/a/b", "/tmp/a")
    check not withinBasePath("/tmp/a/../b", "/tmp/a")

  test "frameAssetsPayload includes directories and files":
    let tempRoot = getTempDir() / "frameos-api-assets"
    createDir(tempRoot)
    createDir(tempRoot / "nested")
    writeFile(tempRoot / "nested" / "image.txt", "hello")

    globalFrameConfig = baseConfig(tempRoot)
    let payload = frameAssetsPayload()
    check payload.kind == JArray
    check payload.len >= 2

    var sawDir = false
    var sawFile = false
    for item in payload.items:
      if item{"path"}.getStr() == tempRoot / "nested":
        sawDir = item{"is_dir"}.getBool()
      if item{"path"}.getStr() == tempRoot / "nested" / "image.txt":
        sawFile = not item{"is_dir"}.getBool() and item{"size"}.getInt() == 5
    check sawDir
    check sawFile

  test "getAssetPayload validates path missing and raw file content":
    let tempRoot = getTempDir() / "frameos-api-asset-payload"
    createDir(tempRoot)
    writeFile(tempRoot / "asset.txt", "asset-body")
    globalFrameConfig = baseConfig(tempRoot)

    let missingPath = getAssetPayload("", false)
    check int(missingPath.status) == int(Http400)
    check missingPath.body.contains("Path is required")

    let invalidPath = getAssetPayload("../secret.txt", false)
    check int(invalidPath.status) == int(Http400)
    check invalidPath.body.contains("Invalid path")

    let missingFile = getAssetPayload("missing.txt", false)
    check int(missingFile.status) == int(Http404)
    check missingFile.body.contains("Asset not found")

    let foundFile = getAssetPayload("asset.txt", false)
    check int(foundFile.status) == int(Http200)
    check foundFile.headers["Content-Type"] == "application/octet-stream"
    check foundFile.body == "asset-body"

  test "getAssetPayload renders and caches thumbnails without ImageMagick":
    let tempRoot = getTempDir() / "frameos-api-asset-thumbs"
    removeDir(tempRoot)
    createDir(tempRoot)
    let source = newImage(1600, 900)
    source.fill(rgba(10, 120, 200, 255))
    writeFile(tempRoot / "wide.png", source.encodeImage(PngFormat))
    globalFrameConfig = baseConfig(tempRoot)

    let thumb = getAssetPayload("wide.png", true)
    check int(thumb.status) == int(Http200)
    check thumb.headers["Content-Type"] == ThumbnailContentType
    let decoded = decodeImage(thumb.body)
    # Fit inside the box, aspect kept: 1600x900 -> 320x180.
    check decoded.width == ThumbnailMaxEdge
    check decoded.height == 180

    # Cached on disk under .thumbs, and served from there the second time.
    var cachedFiles: seq[string] = @[]
    for file in walkDirRec(tempRoot / ".thumbs"):
      cachedFiles.add(file)
    check cachedFiles.len == 1
    check cachedFiles[0].endsWith(ThumbnailFileSuffix)
    writeFile(cachedFiles[0], newImage(4, 4).encodeImage(PngFormat))
    let cached = getAssetPayload("wide.png", true)
    check decodeImage(cached.body).width == 4

  test "a replaced image gets a new thumbnail and the stale one is evicted":
    let tempRoot = getTempDir() / "frameos-api-asset-thumbs-replaced"
    removeDir(tempRoot)
    createDir(tempRoot)
    writeFile(tempRoot / "photo.png", newImage(800, 400).encodeImage(PngFormat))
    globalFrameConfig = baseConfig(tempRoot)
    let first = getAssetPayload("photo.png", true)
    check decodeImage(first.body).height == 160

    # Same path, different contents (and a different size, so the key changes
    # even when the filesystem's mtime granularity is one second).
    writeFile(tempRoot / "photo.png", newImage(400, 800).encodeImage(PngFormat))
    let second = getAssetPayload("photo.png", true)
    check decodeImage(second.body).height == ThumbnailMaxEdge
    check decodeImage(second.body).width == 160
    var cachedFiles: seq[string] = @[]
    for file in walkDirRec(tempRoot / ".thumbs"):
      cachedFiles.add(file)
    check cachedFiles.len == 1

  test "getAssetPayload reports why a thumbnail could not be made":
    let tempRoot = getTempDir() / "frameos-api-asset-thumb-errors"
    removeDir(tempRoot)
    createDir(tempRoot)
    writeFile(tempRoot / "notes.txt", "not an image")
    globalFrameConfig = baseConfig(tempRoot)

    let failed = getAssetPayload("notes.txt", true)
    check int(failed.status) == int(Http500)
    check failed.body.contains("Failed to generate thumbnail")

  test "asset mutation helpers stay scoped to the configured assets root":
    let tempRoot = getTempDir() / "frameos-api-asset-mutations"
    createDir(tempRoot)
    globalFrameConfig = baseConfig(tempRoot)

    let uploaded = saveAssetUploadPayload("nested", "hello.txt", "hello")
    check uploaded{"path"}.getStr() == tempRoot / "nested" / "hello.txt"
    check fileExists(tempRoot / "nested" / "hello.txt")

    let sanitizedFilename = saveAssetUploadPayload("nested", "..", "trap")
    check sanitizedFilename{"path"}.getStr() == tempRoot / "nested" / "uploaded_file"
    check fileExists(tempRoot / "nested" / "uploaded_file")

    createAssetDirectory("nested/inner")
    check dirExists(tempRoot / "nested" / "inner")

    renameAssetEntry("nested", "renamed")
    check dirExists(tempRoot / "renamed")
    check fileExists(tempRoot / "renamed" / "hello.txt")

    let uploadedImage = saveUploadedImagePayload("sample image.png", "png-bytes")
    check uploadedImage{"path"}.getStr().startsWith("uploads/sample_image.")
    check uploadedImage{"filename"}.getStr().endsWith(".png")

    deleteAssetEntry("renamed")
    check not dirExists(tempRoot / "renamed")

    expect ValueError:
      discard saveAssetUploadPayload("../escape", "nope.txt", "bad")

  test "a symlink inside the assets root cannot point the admin routes outside it":
    let tempRoot = getTempDir() / "frameos-api-asset-symlinks"
    let outside = getTempDir() / "frameos-api-asset-symlinks-outside"
    removeDir(tempRoot)
    removeDir(outside)
    createDir(tempRoot)
    createDir(outside)
    writeFile(outside / "secret.txt", "not yours")
    globalFrameConfig = baseConfig(tempRoot)
    createSymlink(outside, tempRoot / "escape")
    createSymlink(outside / "secret.txt", tempRoot / "leak.txt")
    createDir(tempRoot / "real")
    createSymlink(tempRoot / "real", tempRoot / "alias")

    # Lexically inside, really outside: refused whether the target exists
    # (a read) or is about to be created (a write).
    expect ValueError:
      discard resolveAssetPath("escape/secret.txt")
    expect ValueError:
      discard resolveAssetPath("escape/new.txt")
    expect ValueError:
      discard resolveAssetPath("leak.txt")
    expect ValueError:
      discard resolveAssetPath("escape")
    # A link that stays inside the root is fine, and so is a fresh path.
    check resolveAssetPath("alias/photo.png") == tempRoot / "alias" / "photo.png"
    check resolveAssetPath("real/photo.png") == tempRoot / "real" / "photo.png"
    check resolveAssetPath("brand/new/dir/file.txt") == tempRoot / "brand" / "new" / "dir" / "file.txt"
    removeDir(tempRoot)
    removeDir(outside)

  test "chunked upload helpers append and finalize within scoped assets root":
    let tempRoot = getTempDir() / "frameos-api-chunked-assets"
    createDir(tempRoot)
    globalFrameConfig = baseConfig(tempRoot)

    appendUploadChunk("upload-a", 0, "he")
    appendUploadChunk("upload-a", 1, "llo")
    let finalized = finishChunkedAssetUpload("upload-a", "nested", "hello.txt")
    check finalized{"path"}.getStr() == tempRoot / "nested" / "hello.txt"
    check readFile(tempRoot / "nested" / "hello.txt") == "hello"

    appendUploadChunk("upload-image", 0, "png")
    let uploadedImage = finishChunkedImageUpload("upload-image", "sample.png")
    check uploadedImage{"path"}.getStr().startsWith("uploads/sample.")
    check uploadedImage{"filename"}.getStr().endsWith(".png")

  test "local upload parts are swept, capped in total, and dropped when they cannot finish":
    let tempRoot = getTempDir() / "frameos-api-chunked-parts"
    removeDir(tempRoot)
    createDir(tempRoot)
    globalFrameConfig = baseConfig(tempRoot)

    # The sweep matches local parts too (it used to see only `cloud-*.part`).
    appendUploadChunk("abandoned", 0, "half a file")
    cleanupStaleAssetUploadChunks()
    appendUploadChunk("abandoned", 1, " and more")
    cleanupStaleAssetUploadChunks(maxAgeSeconds = -60)
    expect OSError:
      discard finishChunkedAssetUpload("abandoned", "", "gone.txt")

    # A cumulative cap over every unfinished part, not per upload.
    appendUploadChunk("cap-a", 0, repeat('a', 600), maxTotalBytes = 1000)
    expect ValueError:
      appendUploadChunk("cap-b", 0, repeat('b', 600), maxTotalBytes = 1000)
    # Restarting the same upload replaces its bytes rather than adding to them.
    appendUploadChunk("cap-a", 0, repeat('a', 900), maxTotalBytes = 1000)
    expect ValueError:
      appendUploadChunk("cap-a", 1, repeat('a', 200), maxTotalBytes = 1000)
    discardUploadChunk("cap-a")
    discardUploadChunk("cap-b")

    # A part whose destination is refused (here: a directory already sits at
    # the target) does not linger as a .part.
    createDir(tempRoot / "taken.txt")
    appendUploadChunk("bad-dest", 0, "x")
    expect ValueError:
      discard finishChunkedAssetUpload("bad-dest", "", "taken.txt")
    expect OSError:
      discard finishChunkedAssetUpload("bad-dest", "", "ok.txt")

  test "offset-addressed cloud upload chunks overwrite on retry and refuse holes":
    let tempRoot = getTempDir() / "frameos-api-cloud-chunked-assets"
    removeDir(tempRoot)
    createDir(tempRoot)
    globalFrameConfig = baseConfig(tempRoot)

    check writeAssetUploadChunk("cloud-up-a", 0, "hel") == 3
    check writeAssetUploadChunk("cloud-up-a", 3, "lo ") == 6
    # A redelivered chunk lands on the same bytes rather than appending.
    check writeAssetUploadChunk("cloud-up-a", 3, "lo ") == 6
    check writeAssetUploadChunk("cloud-up-a", 6, "world") == 11
    expect ValueError:
      discard writeAssetUploadChunk("cloud-up-a", 20, "gap")
    let finalized = finishAssetUploadChunks("cloud-up-a", "fonts/../fonts/Big Font.ttf")
    # Same filename sanitizing as a single-shot upload; the part is gone.
    check finalized{"path"}.getStr() == tempRoot / "fonts" / "Big_Font.ttf"
    check readFile(tempRoot / "fonts" / "Big_Font.ttf") == "hello world"
    expect OSError:
      discard finishAssetUploadChunks("cloud-up-a", "fonts/again.ttf")

    # Offset 0 restarts an upload; parts never escape the temp root.
    check writeAssetUploadChunk("cloud-up-b", 0, "first try") == 9
    check writeAssetUploadChunk("cloud-up-b", 0, "again") == 5
    discardAssetUploadChunks("cloud-up-b")
    expect OSError:
      discard finishAssetUploadChunks("cloud-up-b", "x.bin")
    expect ValueError:
      discard writeAssetUploadChunk("", 0, "x")

    # Stale sweep: parts older than the cutoff go, younger ones stay. A
    # just-written part is younger than a six-hour cutoff and older than a
    # cutoff in the future (negative age).
    check writeAssetUploadChunk("cloud-up-old", 0, "old") == 3
    cleanupStaleAssetUploadChunks()
    check writeAssetUploadChunk("cloud-up-old", 3, "er") == 5
    cleanupStaleAssetUploadChunks(maxAgeSeconds = -60)
    expect OSError:
      discard finishAssetUploadChunks("cloud-up-old", "old.bin")

  test "a NUL byte or a bare slash never resolves to the assets root":
    let tempRoot = getTempDir() / "frameos-api-asset-nul"
    removeDir(tempRoot)
    createDir(tempRoot)
    writeFile(tempRoot / "keep.txt", "still here")
    globalFrameConfig = baseConfig(tempRoot)

    # "\0" used to normalise to "<root>/\0", pass the lexical checks as a
    # child of the root, and be seen by rmdir as the root itself.
    for bad in ["\0", "/\0", "sub\0dir", "a\x01b", "\x7f", "/", "//", "./", " / "]:
      expect ValueError:
        discard resolveAssetPath(bad)
      expect ValueError:
        deleteAssetEntry(bad)
      check getAssetPayload(bad, false).status == Http400
    check dirExists(tempRoot)
    check fileExists(tempRoot / "keep.txt")
    removeDir(tempRoot)
