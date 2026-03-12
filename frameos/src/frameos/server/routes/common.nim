import strutils
import mummy
import httpcore
import ../state

proc respond*(request: Request; statusCode: httpcore.HttpCode;
    headers: sink mummy.HttpHeaders = emptyHttpHeaders(); body: sink string = "") =
  mummy.respond(request, int(statusCode), headers, body)

template frameWebHtml*(): string =
  {.gcsafe.}:
    let scalingMode = case globalFrameConfig.scalingMode:
      of "cover", "center": globalFrameConfig.scalingMode
      of "stretch": "100% 100%"
      else: "contain"
    frameWebIndexHtml.replace("/*$scalingMode*/contain", scalingMode)

proc requestedFrameMatches*(request: Request): bool =
  parseFrameApiId(request.pathParams["id"]) == frameApiId()
