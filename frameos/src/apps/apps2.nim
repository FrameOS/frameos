import frameos/types
import frameos/values
import apps/data/newImage/app_loader as data_newImage_loader
import apps/data/frameOSGallery/app_loader as data_frameOSGallery_loader
import apps/render/calendar/app_loader as render_calendar_loader
import apps/render/color/app_loader as render_color_loader
import apps/render/gradient/app_loader as render_gradient_loader
import apps/render/image/app_loader as render_image_loader
import apps/render/opacity/app_loader as render_opacity_loader
import apps/render/split/app_loader as render_split_loader
import apps/render/text/app_loader as render_text_loader

proc initApp*(keyword: string, node: DiagramNode, scene: FrameScene): AppRoot =
  case keyword:
  of "data/newImage":
    data_newImage_loader.init(node, scene)
  of "data/frameOSGallery":
    data_frameOSGallery_loader.init(node, scene)
  of "render/calendar":
    render_calendar_loader.init(node, scene)
  of "render/color":
    render_color_loader.init(node, scene)
  of "render/gradient":
    render_gradient_loader.init(node, scene)
  of "render/image":
    render_image_loader.init(node, scene)
  of "render/opacity":
    render_opacity_loader.init(node, scene)
  of "render/split":
    render_split_loader.init(node, scene)
  of "render/text":
    render_text_loader.init(node, scene)
  else:
    raise newException(ValueError, "Unknown app keyword: " & keyword)

proc setAppField*(keyword: string, app: AppRoot, field: string, value: Value) =
  case keyword:
  of "data/newImage": data_newImage_loader.setField(app, field, value)
  of "data/frameOSGallery": data_frameOSGallery_loader.setField(app, field, value)
  of "render/calendar": render_calendar_loader.setField(app, field, value)
  of "render/color": render_color_loader.setField(app, field, value)
  of "render/gradient": render_gradient_loader.setField(app, field, value)
  of "render/image": render_image_loader.setField(app, field, value)
  of "render/opacity": render_opacity_loader.setField(app, field, value)
  of "render/split": render_split_loader.setField(app, field, value)
  of "render/text": render_text_loader.setField(app, field, value)
  else:
    raise newException(ValueError, "Unknown app keyword: " & keyword)

proc isRunnable*(keyword: string): bool =
  case keyword
  of "data/newImage", "data/frameOSGallery": false
  of "render/calendar", "render/color", "render/gradient", "render/image",
     "render/opacity", "render/split", "render/text": true
  else: false

proc runApp*(keyword: string, app: AppRoot, context: var ExecutionContext) =
  echo "runApp called for keyword: ", keyword
  case keyword
  of "render/calendar": render_calendar_loader.run(app, context)
  of "render/color": render_color_loader.run(app, context)
  of "render/gradient": render_gradient_loader.run(app, context)
  of "render/image": render_image_loader.run(app, context)
  of "render/opacity": render_opacity_loader.run(app, context)
  of "render/split": render_split_loader.run(app, context)
  of "render/text": render_text_loader.run(app, context)
  of "data/newImage", "data/frameOSGallery":
    raise newException(Exception, "App '" & keyword & "' cannot be run; use get().")
  else:
    raise newException(ValueError, "Unknown app keyword: " & keyword)

proc getApp*(keyword: string, app: AppRoot, context: var ExecutionContext): Value =
  echo "getApp called for keyword: ", keyword
  case keyword
  of "data/newImage": data_newImage_loader.get(app, context)
  of "data/frameOSGallery": data_frameOSGallery_loader.get(app, context)
  of "render/calendar": render_calendar_loader.get(app, context)
  of "render/color": render_color_loader.get(app, context)
  of "render/gradient": render_gradient_loader.get(app, context)
  of "render/image": render_image_loader.get(app, context)
  of "render/opacity": render_opacity_loader.get(app, context)
  of "render/split": render_split_loader.get(app, context)
  of "render/text": render_text_loader.get(app, context)
  else:
    raise newException(ValueError, "Unknown app keyword: " & keyword)
