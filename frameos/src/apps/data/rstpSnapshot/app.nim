import osproc
import pixie
import strutils
import streams
import frameos/apps
import frameos/types
import frameos/utils/image

type
  AppConfig* = object
    url*: string

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc get*(self: App, context: ExecutionContext): Image =
  try:
    let url = self.appConfig.url.replace("'", "\\'")
    let command = "/usr/bin/ffmpeg -loglevel quiet -y -i '" & url & "' -vframes 1 -f image2 -c:v bmp pipe:1"
    if self.frameConfig.debug:
      self.log "Running: " & command
    var p = startProcess(command, options = {poUsePath, poEvalCommand, poDaemon})
    defer:
      p.close()
    let outputStream = p.outputStream()
    let data = outputStream.readAll()
    discard p.waitForExit()
    return decodeImage(data)
  except CatchableError as e:
    self.logError "An error occurred while rendering the image: " & $e.msg
    return renderError(
      if context.hasImage: context.image.width else: self.frameConfig.renderWidth(),
      if context.hasImage: context.image.height else: self.frameConfig.renderHeight(),
      # Not including the actual error for fear of data leakage (e.g. sensitive URL) in a public place
      "An error occurred while rendering the image"
    )
