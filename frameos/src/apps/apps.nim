import frameos/types
import apps/data/beRecycle/app_loader as data_beRecycle_loader
import apps/data/browserSnapshot/app_loader as data_browserSnapshot_loader
import apps/data/clock/app_loader as data_clock_loader
import apps/data/downloadImage/app_loader as data_downloadImage_loader
import apps/data/downloadUrl/app_loader as data_downloadUrl_loader
import apps/data/eventsToAgenda/app_loader as data_eventsToAgenda_loader
import apps/data/frameOSGallery/app_loader as data_frameOSGallery_loader
import apps/data/haSensor/app_loader as data_haSensor_loader
import apps/data/icalJson/app_loader as data_icalJson_loader
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
import apps/data/rstpSnapshot/app_loader as data_rstpSnapshot_loader
import apps/data/unsplash/app_loader as data_unsplash_loader
import apps/data/wikicommons/app_loader as data_wikicommons_loader
import apps/data/xmlToJson/app_loader as data_xmlToJson_loader
import apps/logic/breakIfRendering/app_loader as logic_breakIfRendering_loader
import apps/logic/ifElse/app_loader as logic_ifElse_loader
import apps/logic/nextSleepDuration/app_loader as logic_nextSleepDuration_loader
import apps/logic/setAsState/app_loader as logic_setAsState_loader
import apps/render/calendar/app_loader as render_calendar_loader
import apps/render/color/app_loader as render_color_loader
import apps/render/gradient/app_loader as render_gradient_loader
import apps/render/image/app_loader as render_image_loader
import apps/render/opacity/app_loader as render_opacity_loader
import apps/render/split/app_loader as render_split_loader
import apps/render/svg/app_loader as render_svg_loader
import apps/render/text/app_loader as render_text_loader

proc initApp*(keyword: string, node: DiagramNode, scene: FrameScene): AppRoot =
  case keyword:
  of "data/beRecycle": data_beRecycle_loader.init(node, scene)
  of "data/browserSnapshot": data_browserSnapshot_loader.init(node, scene)
  of "data/clock": data_clock_loader.init(node, scene)
  of "data/downloadImage": data_downloadImage_loader.init(node, scene)
  of "data/downloadUrl": data_downloadUrl_loader.init(node, scene)
  of "data/eventsToAgenda": data_eventsToAgenda_loader.init(node, scene)
  of "data/frameOSGallery": data_frameOSGallery_loader.init(node, scene)
  of "data/haSensor": data_haSensor_loader.init(node, scene)
  of "data/icalJson": data_icalJson_loader.init(node, scene)
  of "data/localImage": data_localImage_loader.init(node, scene)
  of "data/log": data_log_loader.init(node, scene)
  of "data/newImage": data_newImage_loader.init(node, scene)
  of "data/openaiImage": data_openaiImage_loader.init(node, scene)
  of "data/openaiText": data_openaiText_loader.init(node, scene)
  of "data/parseJson": data_parseJson_loader.init(node, scene)
  of "data/prettyJson": data_prettyJson_loader.init(node, scene)
  of "data/qr": data_qr_loader.init(node, scene)
  of "data/resizeImage": data_resizeImage_loader.init(node, scene)
  of "data/rotateImage": data_rotateImage_loader.init(node, scene)
  of "data/rstpSnapshot": data_rstpSnapshot_loader.init(node, scene)
  of "data/unsplash": data_unsplash_loader.init(node, scene)
  of "data/wikicommons": data_wikicommons_loader.init(node, scene)
  of "data/xmlToJson": data_xmlToJson_loader.init(node, scene)
  of "logic/breakIfRendering": logic_breakIfRendering_loader.init(node, scene)
  of "logic/ifElse": logic_ifElse_loader.init(node, scene)
  of "logic/nextSleepDuration": logic_nextSleepDuration_loader.init(node, scene)
  of "logic/setAsState": logic_setAsState_loader.init(node, scene)
  of "render/calendar": render_calendar_loader.init(node, scene)
  of "render/color": render_color_loader.init(node, scene)
  of "render/gradient": render_gradient_loader.init(node, scene)
  of "render/image": render_image_loader.init(node, scene)
  of "render/opacity": render_opacity_loader.init(node, scene)
  of "render/split": render_split_loader.init(node, scene)
  of "render/svg": render_svg_loader.init(node, scene)
  of "render/text": render_text_loader.init(node, scene)
  else: raise newException(ValueError, "Unknown app keyword: " & keyword)

proc setAppField*(keyword: string, app: AppRoot, field: string, value: Value) =
  case keyword:
  of "data/beRecycle": data_beRecycle_loader.setField(app, field, value)
  of "data/browserSnapshot": data_browserSnapshot_loader.setField(app, field, value)
  of "data/clock": data_clock_loader.setField(app, field, value)
  of "data/downloadImage": data_downloadImage_loader.setField(app, field, value)
  of "data/downloadUrl": data_downloadUrl_loader.setField(app, field, value)
  of "data/eventsToAgenda": data_eventsToAgenda_loader.setField(app, field, value)
  of "data/frameOSGallery": data_frameOSGallery_loader.setField(app, field, value)
  of "data/haSensor": data_haSensor_loader.setField(app, field, value)
  of "data/icalJson": data_icalJson_loader.setField(app, field, value)
  of "data/localImage": data_localImage_loader.setField(app, field, value)
  of "data/log": data_log_loader.setField(app, field, value)
  of "data/newImage": data_newImage_loader.setField(app, field, value)
  of "data/openaiImage": data_openaiImage_loader.setField(app, field, value)
  of "data/openaiText": data_openaiText_loader.setField(app, field, value)
  of "data/parseJson": data_parseJson_loader.setField(app, field, value)
  of "data/prettyJson": data_prettyJson_loader.setField(app, field, value)
  of "data/qr": data_qr_loader.setField(app, field, value)
  of "data/resizeImage": data_resizeImage_loader.setField(app, field, value)
  of "data/rotateImage": data_rotateImage_loader.setField(app, field, value)
  of "data/rstpSnapshot": data_rstpSnapshot_loader.setField(app, field, value)
  of "data/unsplash": data_unsplash_loader.setField(app, field, value)
  of "data/wikicommons": data_wikicommons_loader.setField(app, field, value)
  of "data/xmlToJson": data_xmlToJson_loader.setField(app, field, value)
  of "logic/breakIfRendering": logic_breakIfRendering_loader.setField(app, field, value)
  of "logic/ifElse": logic_ifElse_loader.setField(app, field, value)
  of "logic/nextSleepDuration": logic_nextSleepDuration_loader.setField(app, field, value)
  of "logic/setAsState": logic_setAsState_loader.setField(app, field, value)
  of "render/calendar": render_calendar_loader.setField(app, field, value)
  of "render/color": render_color_loader.setField(app, field, value)
  of "render/gradient": render_gradient_loader.setField(app, field, value)
  of "render/image": render_image_loader.setField(app, field, value)
  of "render/opacity": render_opacity_loader.setField(app, field, value)
  of "render/split": render_split_loader.setField(app, field, value)
  of "render/svg": render_svg_loader.setField(app, field, value)
  of "render/text": render_text_loader.setField(app, field, value)
  else: raise newException(ValueError, "Unknown app keyword: " & keyword)

proc runApp*(keyword: string, app: AppRoot, context: ExecutionContext) =
  case keyword:
  of "logic/breakIfRendering": logic_breakIfRendering_loader.run(app, context)
  of "logic/ifElse": logic_ifElse_loader.run(app, context)
  of "logic/nextSleepDuration": logic_nextSleepDuration_loader.run(app, context)
  of "logic/setAsState": logic_setAsState_loader.run(app, context)
  of "render/calendar": render_calendar_loader.run(app, context)
  of "render/color": render_color_loader.run(app, context)
  of "render/gradient": render_gradient_loader.run(app, context)
  of "render/image": render_image_loader.run(app, context)
  of "render/opacity": render_opacity_loader.run(app, context)
  of "render/split": render_split_loader.run(app, context)
  of "render/svg": render_svg_loader.run(app, context)
  of "render/text": render_text_loader.run(app, context)
  else: raise newException(Exception, "App '" & keyword & "' cannot be run; use get().")

proc getApp*(keyword: string, app: AppRoot, context: ExecutionContext): Value =
  case keyword:
  of "data/beRecycle": data_beRecycle_loader.get(app, context)
  of "data/browserSnapshot": data_browserSnapshot_loader.get(app, context)
  of "data/clock": data_clock_loader.get(app, context)
  of "data/downloadImage": data_downloadImage_loader.get(app, context)
  of "data/downloadUrl": data_downloadUrl_loader.get(app, context)
  of "data/eventsToAgenda": data_eventsToAgenda_loader.get(app, context)
  of "data/frameOSGallery": data_frameOSGallery_loader.get(app, context)
  of "data/haSensor": data_haSensor_loader.get(app, context)
  of "data/icalJson": data_icalJson_loader.get(app, context)
  of "data/localImage": data_localImage_loader.get(app, context)
  of "data/log": data_log_loader.get(app, context)
  of "data/newImage": data_newImage_loader.get(app, context)
  of "data/openaiImage": data_openaiImage_loader.get(app, context)
  of "data/openaiText": data_openaiText_loader.get(app, context)
  of "data/parseJson": data_parseJson_loader.get(app, context)
  of "data/prettyJson": data_prettyJson_loader.get(app, context)
  of "data/qr": data_qr_loader.get(app, context)
  of "data/resizeImage": data_resizeImage_loader.get(app, context)
  of "data/rotateImage": data_rotateImage_loader.get(app, context)
  of "data/rstpSnapshot": data_rstpSnapshot_loader.get(app, context)
  of "data/unsplash": data_unsplash_loader.get(app, context)
  of "data/wikicommons": data_wikicommons_loader.get(app, context)
  of "data/xmlToJson": data_xmlToJson_loader.get(app, context)
  of "render/calendar": render_calendar_loader.get(app, context)
  of "render/color": render_color_loader.get(app, context)
  of "render/gradient": render_gradient_loader.get(app, context)
  of "render/image": render_image_loader.get(app, context)
  of "render/opacity": render_opacity_loader.get(app, context)
  of "render/split": render_split_loader.get(app, context)
  of "render/svg": render_svg_loader.get(app, context)
  of "render/text": render_text_loader.get(app, context)
  else: raise newException(ValueError, "Unknown app keyword: " & keyword)
