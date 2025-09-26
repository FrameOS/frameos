import frameos/types
import apps/render/image/app_loader as render_image_loader
import apps/render/gradient/app_loader as render_gradient_loader
# import apps/render/split/app_loader as render_split_loader
import apps/data/newImage/app_loader as data_newImage_loader
import apps/render/text/app_loader as render_text_loader

proc initApp*(keyword: string, node: DiagramNode, scene: FrameScene): AppRoot =
  case keyword:
  of "render/gradient":
    render_gradient_loader.init(node, scene)
  of "render/image":
    render_image_loader.init(node, scene)
  of "render/text":
    render_text_loader.init(node, scene)
  of "data/newImage":
    data_newImage_loader.init(node, scene)
#   of "render/split":
#     render_split_loader.init(node, scene)
  else:
    raise newException(ValueError, "Unknown app keyword: " & keyword)
