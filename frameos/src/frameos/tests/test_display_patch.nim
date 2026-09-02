import std/[json, os, unittest]
import frameos/display_patch

suite "set-display":
  test "parses args and requires --device":
    let p = parseSetDisplayArgs(@["--device=http.upload", "--width=800", "--upload-url=https://x/y", "--frame-json=/tmp/f.json"])
    check p.device == "http.upload"
    check p.width == "800"
    check p.uploadUrl == "https://x/y"
    check p.frameJsonPath == "/tmp/f.json"
    expect ValueError: discard parseSetDisplayArgs(@["--width=800"])
    expect ValueError: discard parseSetDisplayArgs(@["--device=x", "--bogus=1"])
    expect ValueError: discard parseSetDisplayArgs(@["--device=x", "oops"])

  test "patches only the given keys and keeps the rest":
    var data = %*{"name": "Kitchen", "device": "framebuffer", "width": 100, "height": 50,
                  "deviceConfig": {"pins": {"cs": 8}}, "rotate": 90}
    applyDisplayPatch(data, DisplayPatch(device: "waveshare.EPD_10in3", width: "1872", vcom: "-1.48"))
    check data["device"].getStr == "waveshare.EPD_10in3"
    check data["width"].getInt == 1872
    check data["height"].getInt == 50
    check data["rotate"].getInt == 90
    check data["name"].getStr == "Kitchen"
    check data["deviceConfig"]["pins"]["cs"].getInt == 8
    check data["deviceConfig"]["vcom"].getFloat == -1.48

  test "upload url lands under the canonical httpUploadUrl key":
    var data = %*{"device": "framebuffer"}
    applyDisplayPatch(data, DisplayPatch(device: "http.upload", uploadUrl: "https://example.com/up", rotate: "0"))
    check data["deviceConfig"]["httpUploadUrl"].getStr == "https://example.com/up"
    check data["rotate"].getInt == 0

  test "rejects bad numbers before touching anything":
    var data = %*{"device": "framebuffer", "width": 100}
    expect ValueError: applyDisplayPatch(data, DisplayPatch(device: "x", width: "abc"))
    expect ValueError: applyDisplayPatch(data, DisplayPatch(device: "x", rotate: "45"))
    expect ValueError: applyDisplayPatch(data, DisplayPatch(device: "x", height: "0"))
    expect ValueError: applyDisplayPatch(data, DisplayPatch(device: "x", vcom: "minus"))
    check data["device"].getStr == "framebuffer"
    check data["width"].getInt == 100

  test "runSetDisplay rewrites the file atomically":
    let dir = getTempDir() / "frameos-set-display-test"
    createDir(dir)
    let path = dir / "frame.json"
    writeFile(path, """{"device": "framebuffer", "scenes": [1, 2]}""")
    check runSetDisplay(@["--device=http.upload", "--frame-json=" & path, "--width=800", "--height=480"]) == 0
    let data = parseJson(readFile(path))
    check data["device"].getStr == "http.upload"
    check data["width"].getInt == 800
    check data["scenes"].len == 2
    check not fileExists(path & ".set-display-tmp")
    check getFilePermissions(path) == {fpUserRead, fpUserWrite}
    check runSetDisplay(@["--device=x", "--frame-json=" & dir / "missing.json"]) == 1
    removeDir(dir)
