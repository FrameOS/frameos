import unittest
import os
import strutils
import mummy
import json
import httpcore

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
