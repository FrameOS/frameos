import std/[json, unittest]

import ../apps
import ../types

proc makeConfig(width: int, height: int, rotate: int, saveAssets: JsonNode): FrameConfig =
  FrameConfig(
    width: width,
    height: height,
    rotate: rotate,
    saveAssets: saveAssets,
    assetsPath: "",
  )

suite "frameos app helpers":
  test "render dimensions swap for 90/270 rotations":
    let base = makeConfig(800, 480, 0, %*true)
    check renderWidth(base) == 800
    check renderHeight(base) == 480

    let rotate90 = makeConfig(800, 480, 90, %*true)
    check renderWidth(rotate90) == 480
    check renderHeight(rotate90) == 800

    let rotate180 = makeConfig(800, 480, 180, %*true)
    check renderWidth(rotate180) == 800
    check renderHeight(rotate180) == 480

    let rotate270 = makeConfig(800, 480, 270, %*true)
    check renderWidth(rotate270) == 480
    check renderHeight(rotate270) == 800

  test "cleanFilename strips invalid chars and collapses spaces":
    check cleanFilename("hello   world") == "hello world"
    check cleanFilename("a/b:c*d?e\"f<g>h|i") == "abcdefghi"
    check cleanFilename("My   -   file___name") == "My - file___name"

  test "saveAsset returns early when auto-save is disabled":
    let asBool = AppRoot(
      nodeName: "data/test",
      frameConfig: makeConfig(10, 10, 0, %*false)
    )
    check saveAsset(asBool, "file", ".txt", "hello", true) == ""

    let asObject = AppRoot(
      nodeName: "data/test",
      frameConfig: makeConfig(10, 10, 0, %*{"data/test": false})
    )
    check saveAsset(asObject, "file", ".txt", "hello", true) == ""

    let asInvalid = AppRoot(
      nodeName: "data/test",
      frameConfig: makeConfig(10, 10, 0, %*"invalid")
    )
    check saveAsset(asInvalid, "file", ".txt", "hello", true) == ""
