import strutils
import mummy
import httpcore
import ../state

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
