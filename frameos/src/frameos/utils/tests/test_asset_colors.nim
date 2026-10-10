import std/[json, os, options, unittest]
import pixie

import ../asset_colors
import ../dither

proc gradient(width, height: int): Image =
  ## A deterministic test photo: red ramps across, green ramps down, blue
  ## fixed — enough hue, saturation and luminance variety for every slider
  ## to have something to do. The same picture is built by the frontend's
  ## parity test (cloud/apps/auth-web/src/test/shared-spa/asset-colors.test.ts).
  result = newImage(width, height)
  for y in 0 ..< height:
    for x in 0 ..< width:
      result.unsafe[x, y] = rgbx(
        uint8((x * 255) div max(width - 1, 1)),
        uint8((y * 255) div max(height - 1, 1)),
        96'u8, 255'u8)

proc pixelsOf(image: Image): seq[int] =
  for y in 0 ..< image.height:
    for x in 0 ..< image.width:
      let p = image.unsafe[x, y]
      result.add(p.r.int)
      result.add(p.g.int)
      result.add(p.b.int)

proc profileOf(colors: string): AssetColorProfile =
  let parsed = parseAssetColorProfile(parseJson("""{"version": 1, "colors": """ & colors & "}"))
  check parsed.isSome
  parsed.get()

suite "asset colour profiles":
  test "sidecar naming":
    check sidecarPathFor("/srv/assets/photos/cat.jpg") == "/srv/assets/photos/cat.jpg.frameos.json"
    check isSidecarPath("cat.jpg.frameos.json")
    check not isSidecarPath("cat.jpg")

  test "a neutral profile changes nothing and reports no adjustments":
    let profile = profileOf("{}")
    check not profile.hasAdjustments()
    check not profile.hasPaletteOverride()
    let image = gradient(6, 4)
    let before = pixelsOf(image)
    applyAssetColors(image, profile)
    check pixelsOf(image) == before

  test "parsing clamps sliders, accepts strings and ignores unknown keys":
    let profile = profileOf("""{"exposure": "1.5", "contrast": 250, "whites": -40, "novel": 1,
      "shadows": {"luminance": 10, "r": -5}, "hues": {"blue": {"saturation": 30}}}""")
    check profile.exposure == 1.5
    check profile.contrast == 100
    check profile.whites == -40
    check profile.shadows.luminance == 10
    check profile.shadows.r == -5
    check profile.shadows.g == 0
    check profile.hues[5].saturation == 30
    check profile.hasAdjustments()

  test "a broken or missing sidecar is no profile":
    check parseAssetColorProfile(parseJson("""{"version": 1}""")).isNone
    check parseAssetColorProfile(parseJson("[]")).isNone
    check loadAssetColorProfile("/nonexistent/photo.jpg").isNone

  test "the palette override parses hex and triplets, and voids on one bad entry":
    let hex = profileOf("""{"palette": ["#191426", "#b2c1c0", "#c7bb00", "#6b1119", "#18539a", "#2a5531"]}""")
    check hex.palette.len == 6
    check hex.palette[0] == (0x19, 0x14, 0x26)
    check hex.palette[5] == (0x2a, 0x55, 0x31)
    check hex.hasPaletteOverride()
    check not hex.hasAdjustments()
    let triplets = profileOf("""{"palette": [[0, 0, 0], [255, 255, 255]]}""")
    check triplets.palette == @[(0, 0, 0), (255, 255, 255)]
    let broken = profileOf("""{"palette": ["#191426", "nope"]}""")
    check broken.palette.len == 0

  test "negative whites pull the highlights below the panel's white":
    let profile = profileOf("""{"whites": -100}""")
    let image = newImage(1, 1)
    image.unsafe[0, 0] = rgbx(255, 255, 255, 255)
    applyAssetColors(image, profile)
    let p = image.unsafe[0, 0]
    # whitePoint = 1.4: 1 / 1.4 = 0.714 → 182
    check p.r == 182
    check p.g == 182
    check p.b == 182
    check p.a == 255

  test "positive blacks lift the shadows":
    let profile = profileOf("""{"blacks": 100}""")
    let image = newImage(1, 1)
    image.unsafe[0, 0] = rgbx(0, 0, 0, 255)
    applyAssetColors(image, profile)
    # blackPoint = -0.4: 0.4 / 1.4 = 0.286 → 73
    check image.unsafe[0, 0].r == 73

  test "exposure is in stops":
    let profile = profileOf("""{"exposure": 1}""")
    let image = newImage(1, 1)
    image.unsafe[0, 0] = rgbx(60, 60, 60, 255)
    applyAssetColors(image, profile)
    check image.unsafe[0, 0].r == 120

  test "saturation -100 is greyscale with the dither's grey weights":
    let profile = profileOf("""{"saturation": -100}""")
    let image = newImage(1, 1)
    image.unsafe[0, 0] = rgbx(255, 0, 0, 255)
    applyAssetColors(image, profile)
    let p = image.unsafe[0, 0]
    check p.r == p.g and p.g == p.b
    check p.r == 54 # 0.21 * 255

  test "hue ranges leave greys alone":
    let profile = profileOf("""{"hues": {"red": {"hue": 30, "saturation": 100, "luminance": 100}}}""")
    let image = newImage(2, 1)
    image.unsafe[0, 0] = rgbx(128, 128, 128, 255)
    image.unsafe[1, 0] = rgbx(200, 40, 40, 255)
    applyAssetColors(image, profile)
    check image.unsafe[0, 0] == rgbx(128, 128, 128, 255)
    let red = image.unsafe[1, 0]
    # +30° towards orange, brighter, more saturated.
    check red.g > 40
    check red.r >= 200

  test "a rectangle of a bigger canvas can be adjusted alone":
    let profile = profileOf("""{"exposure": 1}""")
    let canvas = newImage(4, 2)
    canvas.fill(rgbx(60, 60, 60, 255))
    applyAssetColors(canvas, profile, 2, 0, 2, 2)
    check canvas.unsafe[1, 0].r == 60
    check canvas.unsafe[2, 0].r == 120
    check canvas.unsafe[3, 1].r == 120

  test "loading a sidecar from disk":
    let root = getTempDir() / "frameos-asset-colors-" & $getCurrentProcessId()
    createDir(root)
    defer: removeDir(root)
    let image = root / "photo.jpg"
    writeFile(image, "not really a jpeg")
    check loadAssetColorProfile(image).isNone
    writeFile(sidecarPathFor(image), """{"version": 1, "colors": {"contrast": 20}}""")
    let loaded = loadAssetColorProfile(image)
    check loaded.isSome
    check loaded.get().contrast == 20
    writeFile(sidecarPathFor(image), "{ not json")
    check loadAssetColorProfile(image).isNone

  test "parity vector for the frontend preview":
    # The same photo, profile and arithmetic as the TypeScript port; the
    # expected bytes are what the Nim pipeline produced when the port was
    # written (2026-10-10; end points widened and hue made a degree rotation the same day). A change here
    # must be mirrored in adjust.ts.
    let profile = profileOf("""{"exposure": 0.4, "contrast": 25, "whites": -30, "blacks": 15,
      "saturation": 20, "shadows": {"luminance": -10, "b": 20}, "midtones": {"r": 10},
      "highlights": {"luminance": 15, "g": -10},
      "hues": {"red": {"hue": 40, "saturation": -30, "luminance": 20},
               "green": {"hue": -50, "saturation": 60, "luminance": -20},
               "blue": {"luminance": 30}}}""")
    let image = gradient(4, 3)
    applyAssetColors(image, profile)
    check pixelsOf(image) == @[
      0, 0, 192, 109, 0, 142, 248, 8, 109, 247, 14, 105,
      0, 160, 83, 116, 177, 87, 240, 190, 130, 248, 198, 135,
      0, 238, 1, 190, 255, 71, 252, 255, 110, 255, 255, 114]

  test "dither parity vector for the frontend preview":
    # forEachPaletteDithered on the same gradient against the Spectra table
    # (hole included), jitter amplitude 8: the indices the TypeScript port
    # (frontend/src/utils/assetColors/dither.ts) must reproduce exactly.
    let image = gradient(8, 4)
    var indices: seq[int] = @[]
    image.forEachPaletteDithered(spectra6ColorPalette, x, y, index):
      indices.add(index)
    check indices == @[0, 0, 0, 3, 3, 3, 3, 3, 5, 5, 5, 5, 1, 3, 1, 3,
      6, 6, 1, 2, 1, 1, 2, 1, 5, 6, 6, 1, 2, 1, 2, 1]
