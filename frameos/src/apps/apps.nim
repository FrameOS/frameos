import frameos/types
import frameos/app_capabilities
export app_capabilities
import apps/data/beRecycle/app_loader as data_beRecycle_loader
import apps/data/clock/app_loader as data_clock_loader
import apps/data/downloadImage/app_loader as data_downloadImage_loader
import apps/data/downloadUrl/app_loader as data_downloadUrl_loader
import apps/data/eventsToAgenda/app_loader as data_eventsToAgenda_loader
import apps/data/frameOSGallery/app_loader as data_frameOSGallery_loader
import apps/data/googlePhotos/app_loader as data_googlePhotos_loader
import apps/data/haSensor/app_loader as data_haSensor_loader
import apps/data/icalJson/app_loader as data_icalJson_loader
import apps/data/immich/app_loader as data_immich_loader
import apps/data/localImage/app_loader as data_localImage_loader
import apps/data/log/app_loader as data_log_loader
import apps/data/newImage/app_loader as data_newImage_loader
import apps/data/openaiImage/app_loader as data_openaiImage_loader
import apps/data/openaiText/app_loader as data_openaiText_loader
import apps/data/parseJson/app_loader as data_parseJson_loader
import apps/data/prettyJson/app_loader as data_prettyJson_loader
import apps/data/qr/app_loader as data_qr_loader
import apps/data/resizeImage/app_loader as data_resizeImage_loader
import apps/data/rotateImage/app_loader as data_rotateImage_loader
import apps/data/unsplash/app_loader as data_unsplash_loader
import apps/data/weather/app_loader as data_weather_loader
import apps/data/wikicommons/app_loader as data_wikicommons_loader
import apps/data/xmlToJson/app_loader as data_xmlToJson_loader
import apps/logic/breakIfRendering/app_loader as logic_breakIfRendering_loader
import apps/logic/ifElse/app_loader as logic_ifElse_loader
import apps/logic/nextSleepDuration/app_loader as logic_nextSleepDuration_loader
import apps/logic/setAsState/app_loader as logic_setAsState_loader
import apps/render/calendar/app_loader as render_calendar_loader
import apps/render/chart/app_loader as render_chart_loader
import apps/render/color/app_loader as render_color_loader
import apps/render/gradient/app_loader as render_gradient_loader
import apps/render/image/app_loader as render_image_loader
import apps/render/opacity/app_loader as render_opacity_loader
import apps/render/split/app_loader as render_split_loader
import apps/render/svg/app_loader as render_svg_loader
import apps/render/text/app_loader as render_text_loader
import apps/render/zoomPan/app_loader as render_zoomPan_loader
when not defined(frameosEmbedded) and not defined(frameosWasm):
  # Excluded from embedded and wasm builds: these apps depend on host-only
  # runtime features such as child processes and external binaries.
  import apps/data/chromiumScreenshot/app_loader as data_chromiumScreenshot_loader
  import apps/data/rstpSnapshot/app_loader as data_rstpSnapshot_loader

type AppEntry = object
  ## One app's four entry points, so dispatch is a table lookup instead of
  ## four `case keyword:` chains repeated over every app in the registry.
  keyword: string
  initProc: proc (node: DiagramNode, scene: FrameScene): AppRoot {.nimcall.}
  setFieldProc: proc (app: AppRoot, field: string, value: Value) {.nimcall.}
  getProc: proc (app: AppRoot, context: ExecutionContext): Value {.nimcall.}
  runProc: proc (app: AppRoot, context: ExecutionContext) {.nimcall.}

when defined(frameosEmbedded) or defined(frameosWasm):
  const appEntries = [
    AppEntry(keyword: "data/beRecycle", initProc: data_beRecycle_loader.init, setFieldProc: data_beRecycle_loader.setField, getProc: data_beRecycle_loader.get, runProc: nil),
    AppEntry(keyword: "data/clock", initProc: data_clock_loader.init, setFieldProc: data_clock_loader.setField, getProc: data_clock_loader.get, runProc: nil),
    AppEntry(keyword: "data/downloadImage", initProc: data_downloadImage_loader.init, setFieldProc: data_downloadImage_loader.setField, getProc: data_downloadImage_loader.get, runProc: nil),
    AppEntry(keyword: "data/downloadUrl", initProc: data_downloadUrl_loader.init, setFieldProc: data_downloadUrl_loader.setField, getProc: data_downloadUrl_loader.get, runProc: nil),
    AppEntry(keyword: "data/eventsToAgenda", initProc: data_eventsToAgenda_loader.init, setFieldProc: data_eventsToAgenda_loader.setField, getProc: data_eventsToAgenda_loader.get, runProc: nil),
    AppEntry(keyword: "data/frameOSGallery", initProc: data_frameOSGallery_loader.init, setFieldProc: data_frameOSGallery_loader.setField, getProc: data_frameOSGallery_loader.get, runProc: nil),
    AppEntry(keyword: "data/googlePhotos", initProc: data_googlePhotos_loader.init, setFieldProc: data_googlePhotos_loader.setField, getProc: data_googlePhotos_loader.get, runProc: nil),
    AppEntry(keyword: "data/haSensor", initProc: data_haSensor_loader.init, setFieldProc: data_haSensor_loader.setField, getProc: data_haSensor_loader.get, runProc: nil),
    AppEntry(keyword: "data/icalJson", initProc: data_icalJson_loader.init, setFieldProc: data_icalJson_loader.setField, getProc: data_icalJson_loader.get, runProc: nil),
    AppEntry(keyword: "data/immich", initProc: data_immich_loader.init, setFieldProc: data_immich_loader.setField, getProc: data_immich_loader.get, runProc: nil),
    AppEntry(keyword: "data/localImage", initProc: data_localImage_loader.init, setFieldProc: data_localImage_loader.setField, getProc: data_localImage_loader.get, runProc: nil),
    AppEntry(keyword: "data/log", initProc: data_log_loader.init, setFieldProc: data_log_loader.setField, getProc: data_log_loader.get, runProc: nil),
    AppEntry(keyword: "data/newImage", initProc: data_newImage_loader.init, setFieldProc: data_newImage_loader.setField, getProc: data_newImage_loader.get, runProc: nil),
    AppEntry(keyword: "data/openaiImage", initProc: data_openaiImage_loader.init, setFieldProc: data_openaiImage_loader.setField, getProc: data_openaiImage_loader.get, runProc: nil),
    AppEntry(keyword: "data/openaiText", initProc: data_openaiText_loader.init, setFieldProc: data_openaiText_loader.setField, getProc: data_openaiText_loader.get, runProc: nil),
    AppEntry(keyword: "data/parseJson", initProc: data_parseJson_loader.init, setFieldProc: data_parseJson_loader.setField, getProc: data_parseJson_loader.get, runProc: nil),
    AppEntry(keyword: "data/prettyJson", initProc: data_prettyJson_loader.init, setFieldProc: data_prettyJson_loader.setField, getProc: data_prettyJson_loader.get, runProc: nil),
    AppEntry(keyword: "data/qr", initProc: data_qr_loader.init, setFieldProc: data_qr_loader.setField, getProc: data_qr_loader.get, runProc: nil),
    AppEntry(keyword: "data/resizeImage", initProc: data_resizeImage_loader.init, setFieldProc: data_resizeImage_loader.setField, getProc: data_resizeImage_loader.get, runProc: nil),
    AppEntry(keyword: "data/rotateImage", initProc: data_rotateImage_loader.init, setFieldProc: data_rotateImage_loader.setField, getProc: data_rotateImage_loader.get, runProc: nil),
    AppEntry(keyword: "data/unsplash", initProc: data_unsplash_loader.init, setFieldProc: data_unsplash_loader.setField, getProc: data_unsplash_loader.get, runProc: nil),
    AppEntry(keyword: "data/weather", initProc: data_weather_loader.init, setFieldProc: data_weather_loader.setField, getProc: data_weather_loader.get, runProc: nil),
    AppEntry(keyword: "data/wikicommons", initProc: data_wikicommons_loader.init, setFieldProc: data_wikicommons_loader.setField, getProc: data_wikicommons_loader.get, runProc: nil),
    AppEntry(keyword: "data/xmlToJson", initProc: data_xmlToJson_loader.init, setFieldProc: data_xmlToJson_loader.setField, getProc: data_xmlToJson_loader.get, runProc: nil),
    AppEntry(keyword: "logic/breakIfRendering", initProc: logic_breakIfRendering_loader.init, setFieldProc: logic_breakIfRendering_loader.setField, getProc: nil, runProc: logic_breakIfRendering_loader.run),
    AppEntry(keyword: "logic/ifElse", initProc: logic_ifElse_loader.init, setFieldProc: logic_ifElse_loader.setField, getProc: nil, runProc: logic_ifElse_loader.run),
    AppEntry(keyword: "logic/nextSleepDuration", initProc: logic_nextSleepDuration_loader.init, setFieldProc: logic_nextSleepDuration_loader.setField, getProc: nil, runProc: logic_nextSleepDuration_loader.run),
    AppEntry(keyword: "logic/setAsState", initProc: logic_setAsState_loader.init, setFieldProc: logic_setAsState_loader.setField, getProc: nil, runProc: logic_setAsState_loader.run),
    AppEntry(keyword: "render/calendar", initProc: render_calendar_loader.init, setFieldProc: render_calendar_loader.setField, getProc: render_calendar_loader.get, runProc: render_calendar_loader.run),
    AppEntry(keyword: "render/chart", initProc: render_chart_loader.init, setFieldProc: render_chart_loader.setField, getProc: render_chart_loader.get, runProc: render_chart_loader.run),
    AppEntry(keyword: "render/color", initProc: render_color_loader.init, setFieldProc: render_color_loader.setField, getProc: render_color_loader.get, runProc: render_color_loader.run),
    AppEntry(keyword: "render/gradient", initProc: render_gradient_loader.init, setFieldProc: render_gradient_loader.setField, getProc: render_gradient_loader.get, runProc: render_gradient_loader.run),
    AppEntry(keyword: "render/image", initProc: render_image_loader.init, setFieldProc: render_image_loader.setField, getProc: render_image_loader.get, runProc: render_image_loader.run),
    AppEntry(keyword: "render/opacity", initProc: render_opacity_loader.init, setFieldProc: render_opacity_loader.setField, getProc: render_opacity_loader.get, runProc: render_opacity_loader.run),
    AppEntry(keyword: "render/split", initProc: render_split_loader.init, setFieldProc: render_split_loader.setField, getProc: render_split_loader.get, runProc: render_split_loader.run),
    AppEntry(keyword: "render/svg", initProc: render_svg_loader.init, setFieldProc: render_svg_loader.setField, getProc: render_svg_loader.get, runProc: render_svg_loader.run),
    AppEntry(keyword: "render/text", initProc: render_text_loader.init, setFieldProc: render_text_loader.setField, getProc: render_text_loader.get, runProc: render_text_loader.run),
    AppEntry(keyword: "render/zoomPan", initProc: render_zoomPan_loader.init, setFieldProc: render_zoomPan_loader.setField, getProc: render_zoomPan_loader.get, runProc: render_zoomPan_loader.run),
  ]
else:
  const appEntries = [
    AppEntry(keyword: "data/beRecycle", initProc: data_beRecycle_loader.init, setFieldProc: data_beRecycle_loader.setField, getProc: data_beRecycle_loader.get, runProc: nil),
    AppEntry(keyword: "data/chromiumScreenshot", initProc: data_chromiumScreenshot_loader.init, setFieldProc: data_chromiumScreenshot_loader.setField, getProc: data_chromiumScreenshot_loader.get, runProc: nil),
    AppEntry(keyword: "data/clock", initProc: data_clock_loader.init, setFieldProc: data_clock_loader.setField, getProc: data_clock_loader.get, runProc: nil),
    AppEntry(keyword: "data/downloadImage", initProc: data_downloadImage_loader.init, setFieldProc: data_downloadImage_loader.setField, getProc: data_downloadImage_loader.get, runProc: nil),
    AppEntry(keyword: "data/downloadUrl", initProc: data_downloadUrl_loader.init, setFieldProc: data_downloadUrl_loader.setField, getProc: data_downloadUrl_loader.get, runProc: nil),
    AppEntry(keyword: "data/eventsToAgenda", initProc: data_eventsToAgenda_loader.init, setFieldProc: data_eventsToAgenda_loader.setField, getProc: data_eventsToAgenda_loader.get, runProc: nil),
    AppEntry(keyword: "data/frameOSGallery", initProc: data_frameOSGallery_loader.init, setFieldProc: data_frameOSGallery_loader.setField, getProc: data_frameOSGallery_loader.get, runProc: nil),
    AppEntry(keyword: "data/googlePhotos", initProc: data_googlePhotos_loader.init, setFieldProc: data_googlePhotos_loader.setField, getProc: data_googlePhotos_loader.get, runProc: nil),
    AppEntry(keyword: "data/haSensor", initProc: data_haSensor_loader.init, setFieldProc: data_haSensor_loader.setField, getProc: data_haSensor_loader.get, runProc: nil),
    AppEntry(keyword: "data/icalJson", initProc: data_icalJson_loader.init, setFieldProc: data_icalJson_loader.setField, getProc: data_icalJson_loader.get, runProc: nil),
    AppEntry(keyword: "data/immich", initProc: data_immich_loader.init, setFieldProc: data_immich_loader.setField, getProc: data_immich_loader.get, runProc: nil),
    AppEntry(keyword: "data/localImage", initProc: data_localImage_loader.init, setFieldProc: data_localImage_loader.setField, getProc: data_localImage_loader.get, runProc: nil),
    AppEntry(keyword: "data/log", initProc: data_log_loader.init, setFieldProc: data_log_loader.setField, getProc: data_log_loader.get, runProc: nil),
    AppEntry(keyword: "data/newImage", initProc: data_newImage_loader.init, setFieldProc: data_newImage_loader.setField, getProc: data_newImage_loader.get, runProc: nil),
    AppEntry(keyword: "data/openaiImage", initProc: data_openaiImage_loader.init, setFieldProc: data_openaiImage_loader.setField, getProc: data_openaiImage_loader.get, runProc: nil),
    AppEntry(keyword: "data/openaiText", initProc: data_openaiText_loader.init, setFieldProc: data_openaiText_loader.setField, getProc: data_openaiText_loader.get, runProc: nil),
    AppEntry(keyword: "data/parseJson", initProc: data_parseJson_loader.init, setFieldProc: data_parseJson_loader.setField, getProc: data_parseJson_loader.get, runProc: nil),
    AppEntry(keyword: "data/prettyJson", initProc: data_prettyJson_loader.init, setFieldProc: data_prettyJson_loader.setField, getProc: data_prettyJson_loader.get, runProc: nil),
    AppEntry(keyword: "data/qr", initProc: data_qr_loader.init, setFieldProc: data_qr_loader.setField, getProc: data_qr_loader.get, runProc: nil),
    AppEntry(keyword: "data/resizeImage", initProc: data_resizeImage_loader.init, setFieldProc: data_resizeImage_loader.setField, getProc: data_resizeImage_loader.get, runProc: nil),
    AppEntry(keyword: "data/rotateImage", initProc: data_rotateImage_loader.init, setFieldProc: data_rotateImage_loader.setField, getProc: data_rotateImage_loader.get, runProc: nil),
    AppEntry(keyword: "data/rstpSnapshot", initProc: data_rstpSnapshot_loader.init, setFieldProc: data_rstpSnapshot_loader.setField, getProc: data_rstpSnapshot_loader.get, runProc: nil),
    AppEntry(keyword: "data/unsplash", initProc: data_unsplash_loader.init, setFieldProc: data_unsplash_loader.setField, getProc: data_unsplash_loader.get, runProc: nil),
    AppEntry(keyword: "data/weather", initProc: data_weather_loader.init, setFieldProc: data_weather_loader.setField, getProc: data_weather_loader.get, runProc: nil),
    AppEntry(keyword: "data/wikicommons", initProc: data_wikicommons_loader.init, setFieldProc: data_wikicommons_loader.setField, getProc: data_wikicommons_loader.get, runProc: nil),
    AppEntry(keyword: "data/xmlToJson", initProc: data_xmlToJson_loader.init, setFieldProc: data_xmlToJson_loader.setField, getProc: data_xmlToJson_loader.get, runProc: nil),
    AppEntry(keyword: "logic/breakIfRendering", initProc: logic_breakIfRendering_loader.init, setFieldProc: logic_breakIfRendering_loader.setField, getProc: nil, runProc: logic_breakIfRendering_loader.run),
    AppEntry(keyword: "logic/ifElse", initProc: logic_ifElse_loader.init, setFieldProc: logic_ifElse_loader.setField, getProc: nil, runProc: logic_ifElse_loader.run),
    AppEntry(keyword: "logic/nextSleepDuration", initProc: logic_nextSleepDuration_loader.init, setFieldProc: logic_nextSleepDuration_loader.setField, getProc: nil, runProc: logic_nextSleepDuration_loader.run),
    AppEntry(keyword: "logic/setAsState", initProc: logic_setAsState_loader.init, setFieldProc: logic_setAsState_loader.setField, getProc: nil, runProc: logic_setAsState_loader.run),
    AppEntry(keyword: "render/calendar", initProc: render_calendar_loader.init, setFieldProc: render_calendar_loader.setField, getProc: render_calendar_loader.get, runProc: render_calendar_loader.run),
    AppEntry(keyword: "render/chart", initProc: render_chart_loader.init, setFieldProc: render_chart_loader.setField, getProc: render_chart_loader.get, runProc: render_chart_loader.run),
    AppEntry(keyword: "render/color", initProc: render_color_loader.init, setFieldProc: render_color_loader.setField, getProc: render_color_loader.get, runProc: render_color_loader.run),
    AppEntry(keyword: "render/gradient", initProc: render_gradient_loader.init, setFieldProc: render_gradient_loader.setField, getProc: render_gradient_loader.get, runProc: render_gradient_loader.run),
    AppEntry(keyword: "render/image", initProc: render_image_loader.init, setFieldProc: render_image_loader.setField, getProc: render_image_loader.get, runProc: render_image_loader.run),
    AppEntry(keyword: "render/opacity", initProc: render_opacity_loader.init, setFieldProc: render_opacity_loader.setField, getProc: render_opacity_loader.get, runProc: render_opacity_loader.run),
    AppEntry(keyword: "render/split", initProc: render_split_loader.init, setFieldProc: render_split_loader.setField, getProc: render_split_loader.get, runProc: render_split_loader.run),
    AppEntry(keyword: "render/svg", initProc: render_svg_loader.init, setFieldProc: render_svg_loader.setField, getProc: render_svg_loader.get, runProc: render_svg_loader.run),
    AppEntry(keyword: "render/text", initProc: render_text_loader.init, setFieldProc: render_text_loader.setField, getProc: render_text_loader.get, runProc: render_text_loader.run),
    AppEntry(keyword: "render/zoomPan", initProc: render_zoomPan_loader.init, setFieldProc: render_zoomPan_loader.setField, getProc: render_zoomPan_loader.get, runProc: render_zoomPan_loader.run),
  ]

const hostOnlyApps = ["data/chromiumScreenshot", "data/rstpSnapshot"]

proc appIndex(keyword: string): int =
  ## Bisect the keyword-sorted registry. -1 when this build has no such app.
  var lo = 0
  var hi = appEntries.len - 1
  while lo <= hi:
    let mid = (lo + hi) div 2
    if appEntries[mid].keyword == keyword: return mid
    elif appEntries[mid].keyword < keyword: lo = mid + 1
    else: hi = mid - 1
  -1

proc raiseUnknownApp(keyword: string) =
  when defined(frameosEmbedded) or defined(frameosWasm):
    for hostOnly in hostOnlyApps:
      if hostOnly == keyword:
        raise newException(ValueError,
          "App '" & keyword & "' is not available on this build target")
  raise newException(ValueError, "Unknown app keyword: " & keyword)

proc initApp*(keyword: string, node: DiagramNode, scene: FrameScene): AppRoot =
  let i = appIndex(keyword)
  if i < 0: raiseUnknownApp(keyword)
  appEntries[i].initProc(node, scene)

proc setAppField*(keyword: string, app: AppRoot, field: string, value: Value) =
  let i = appIndex(keyword)
  if i < 0: raiseUnknownApp(keyword)
  appEntries[i].setFieldProc(app, field, value)

proc runApp*(keyword: string, app: AppRoot, context: ExecutionContext) =
  let i = appIndex(keyword)
  if i < 0 or appEntries[i].runProc == nil:
    raise newException(Exception, "App '" & keyword & "' cannot be run; use get().")
  appEntries[i].runProc(app, context)

proc getApp*(keyword: string, app: AppRoot, context: ExecutionContext): Value =
  let i = appIndex(keyword)
  if i < 0 or appEntries[i].getProc == nil: raiseUnknownApp(keyword)
  appEntries[i].getProc(app, context)

proc appCapabilities*(keyword: string): AppCapabilities =
  ## Per-port protocols this app declares in its config.json. Apps that
  ## declare nothing are materialized-only, which every edge supports.
  case keyword:
  of "data/downloadImage":
    AppCapabilities(
      providesTarget: @[],
      intoTarget: @[IntoTargetSpec(output: "image", fits: @["cover", "contain", "stretch"], requireStatic: @[], requireUnset: @[], requireOpaqueColor: @[])],
      forwardsTarget: @[],
      forwardsBounds: @[],
      requestsBounds: @[],
      fieldDefaults: @[])
  of "data/frameOSGallery":
    AppCapabilities(
      providesTarget: @[],
      intoTarget: @[IntoTargetSpec(output: "image", fits: @["cover", "contain", "stretch"], requireStatic: @[], requireUnset: @[], requireOpaqueColor: @[])],
      forwardsTarget: @[],
      forwardsBounds: @[],
      requestsBounds: @[],
      fieldDefaults: @[])
  of "data/googlePhotos":
    AppCapabilities(
      providesTarget: @[],
      intoTarget: @[IntoTargetSpec(output: "image", fits: @["cover", "contain", "stretch"], requireStatic: @[], requireUnset: @[], requireOpaqueColor: @[])],
      forwardsTarget: @[],
      forwardsBounds: @[],
      requestsBounds: @[],
      fieldDefaults: @[])
  of "data/immich":
    AppCapabilities(
      providesTarget: @[],
      intoTarget: @[IntoTargetSpec(output: "image", fits: @["cover", "contain", "stretch"], requireStatic: @[], requireUnset: @[], requireOpaqueColor: @[])],
      forwardsTarget: @[],
      forwardsBounds: @[],
      requestsBounds: @[],
      fieldDefaults: @[])
  of "data/localImage":
    AppCapabilities(
      providesTarget: @[],
      intoTarget: @[IntoTargetSpec(output: "image", fits: @["cover", "contain", "stretch"], requireStatic: @[], requireUnset: @[], requireOpaqueColor: @[])],
      forwardsTarget: @[],
      forwardsBounds: @[],
      requestsBounds: @[],
      fieldDefaults: @[])
  of "data/openaiImage":
    AppCapabilities(
      providesTarget: @[],
      intoTarget: @[IntoTargetSpec(output: "image", fits: @["cover", "contain", "stretch"], requireStatic: @[], requireUnset: @[], requireOpaqueColor: @[])],
      forwardsTarget: @[],
      forwardsBounds: @[],
      requestsBounds: @[],
      fieldDefaults: @[])
  of "data/resizeImage":
    AppCapabilities(
      providesTarget: @[],
      intoTarget: @[],
      forwardsTarget: @[],
      forwardsBounds: @[ForwardsBoundsSpec(output: "image", input: "image", boundsField: "", swapValues: @[], keepValues: @[], widthFrom: "width", heightFrom: "height", multiplyFrom: @[])],
      requestsBounds: @[],
      fieldDefaults: @[FieldMatch(field: "width", value: ""), FieldMatch(field: "height", value: "")])
  of "data/rotateImage":
    AppCapabilities(
      providesTarget: @[],
      intoTarget: @[],
      forwardsTarget: @[ForwardsTargetSpec(output: "image", input: "image", requireStatic: @[FieldConstraint(field: "rotationDegree", allowed: @["180", "180.0", "-180", "-180.0", "540", "540.0"])])],
      forwardsBounds: @[ForwardsBoundsSpec(output: "image", input: "image", boundsField: "rotationDegree", swapValues: @["90", "90.0", "270", "270.0", "-90", "-90.0", "-270", "-270.0", "450", "450.0"], keepValues: @["0", "0.0", "180", "180.0", "-180", "-180.0", "360", "360.0", "540", "540.0"], widthFrom: "", heightFrom: "", multiplyFrom: @[])],
      requestsBounds: @[],
      fieldDefaults: @[FieldMatch(field: "rotationDegree", value: "0")])
  of "data/unsplash":
    AppCapabilities(
      providesTarget: @[],
      intoTarget: @[IntoTargetSpec(output: "image", fits: @["cover", "contain", "stretch"], requireStatic: @[], requireUnset: @[], requireOpaqueColor: @[])],
      forwardsTarget: @[],
      forwardsBounds: @[],
      requestsBounds: @[],
      fieldDefaults: @[])
  of "data/wikicommons":
    AppCapabilities(
      providesTarget: @[],
      intoTarget: @[IntoTargetSpec(output: "image", fits: @["cover", "contain", "stretch"], requireStatic: @[], requireUnset: @[], requireOpaqueColor: @[])],
      forwardsTarget: @[],
      forwardsBounds: @[],
      requestsBounds: @[],
      fieldDefaults: @[])
  of "render/calendar":
    AppCapabilities(
      providesTarget: @[],
      intoTarget: @[IntoTargetSpec(output: "image", fits: @["cover", "contain", "stretch"], requireStatic: @[], requireUnset: @["inputImage"], requireOpaqueColor: @[])],
      forwardsTarget: @[],
      forwardsBounds: @[],
      requestsBounds: @[],
      fieldDefaults: @[FieldMatch(field: "inputImage", value: "")])
  of "render/color":
    AppCapabilities(
      providesTarget: @[],
      intoTarget: @[IntoTargetSpec(output: "image", fits: @["natural"], requireStatic: @[], requireUnset: @["inputImage"], requireOpaqueColor: @["color"])],
      forwardsTarget: @[],
      forwardsBounds: @[],
      requestsBounds: @[],
      fieldDefaults: @[FieldMatch(field: "inputImage", value: ""), FieldMatch(field: "color", value: "#ffffff")])
  of "render/gradient":
    AppCapabilities(
      providesTarget: @[],
      intoTarget: @[IntoTargetSpec(output: "image", fits: @["natural"], requireStatic: @[], requireUnset: @["inputImage"], requireOpaqueColor: @["startColor", "endColor"])],
      forwardsTarget: @[],
      forwardsBounds: @[],
      requestsBounds: @[],
      fieldDefaults: @[FieldMatch(field: "inputImage", value: ""), FieldMatch(field: "startColor", value: "#800080"), FieldMatch(field: "endColor", value: "#ffc0cb")])
  of "render/image":
    AppCapabilities(
      providesTarget: @[ProvidesTargetSpec(input: "image", fitFrom: "placement", fits: @["cover", "contain", "stretch"], requireStatic: @[FieldConstraint(field: "offsetX", allowed: @["0"]), FieldConstraint(field: "offsetY", allowed: @["0"]), FieldConstraint(field: "blendMode", allowed: @["normal", "overwrite"])], compositingRequireStatic: @[FieldConstraint(field: "blendMode", allowed: @["normal"])], requireUnset: @["inputImage"], ownedTargetExcludes: @[@[FieldMatch(field: "placement", value: "contain"), FieldMatch(field: "blendMode", value: "overwrite")]])],
      intoTarget: @[],
      forwardsTarget: @[],
      forwardsBounds: @[],
      requestsBounds: @[],
      fieldDefaults: @[FieldMatch(field: "placement", value: "cover"), FieldMatch(field: "offsetX", value: "0"), FieldMatch(field: "offsetY", value: "0"), FieldMatch(field: "blendMode", value: "normal"), FieldMatch(field: "inputImage", value: "")])
  of "render/opacity":
    AppCapabilities(
      providesTarget: @[],
      intoTarget: @[],
      forwardsTarget: @[ForwardsTargetSpec(output: "image", input: "image", requireStatic: @[])],
      forwardsBounds: @[],
      requestsBounds: @[],
      fieldDefaults: @[])
  of "render/zoomPan":
    AppCapabilities(
      providesTarget: @[],
      intoTarget: @[],
      forwardsTarget: @[],
      forwardsBounds: @[ForwardsBoundsSpec(output: "image", input: "image", boundsField: "", swapValues: @[], keepValues: @[], widthFrom: "", heightFrom: "", multiplyFrom: @["zoomStart", "zoomEnd"])],
      requestsBounds: @[RequestsBoundsSpec(input: "image", requireUnset: @["inputImage"], multiplyFrom: @["zoomStart", "zoomEnd"])],
      fieldDefaults: @[FieldMatch(field: "inputImage", value: ""), FieldMatch(field: "zoomStart", value: "1.0"), FieldMatch(field: "zoomEnd", value: "1.4")])
  else: NoAppCapabilities
