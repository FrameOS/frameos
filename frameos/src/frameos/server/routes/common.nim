import strutils
import json
import mummy
import httpcore
import ../api
import ../state
import frameos/channels

proc respond*(request: Request; statusCode: httpcore.HttpCode;
    headers: sink mummy.HttpHeaders = emptyHttpHeaders(); body: sink string = "") =
  mummy.respond(request, int(statusCode), headers, body)

template frameWebHtml*(frameAdminMode: bool = false): string =
  {.gcsafe.}:
    let scalingMode = case globalFrameConfig.scalingMode:
      of "cover", "center": globalFrameConfig.scalingMode
      of "stretch": "100% 100%"
      else: "contain"
    let adminMode = if frameAdminMode: "true" else: "false"
    let html = frameWebIndexHtml.replace("/*$scalingMode*/contain", scalingMode).replace(
      "/*$frameAdminMode*/ false",
      adminMode,
    )
    if "frameAdminMode" in html:
      html
    else:
      let adminConfigScript = """
    <script>
      window.FRAMEOS_APP_CONFIG = {
        ...(window.FRAMEOS_APP_CONFIG || {}),
        frameAdminMode: """ & adminMode & """,
      }
    </script>
"""
      html.replace("</head>", adminConfigScript & "  </head>")

proc requestedFrameMatches*(request: Request): bool =
  parseFrameApiId(request.pathParams["id"]) == frameApiId()

proc respondInternalError*(request: Request, event: string, e: ref CatchableError,
                           detail: string) {.gcsafe.} =
  ## 500 with a fixed, caller-safe `detail`. The exception text goes to the
  ## log only: OSError and IOError messages carry absolute paths and errno
  ## strings that describe the device's filesystem to whoever asked, and
  ## the frame API answers unauthenticated-looking callers through the
  ## backend proxy and the cloud alike.
  {.gcsafe.}:
    log(%*{"event": event, "error": e.msg})
  jsonResponse(request, Http500, %*{"detail": detail})
