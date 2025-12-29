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

proc renderError(self: App, context: ExecutionContext, message: string): Image =
  return renderError(
    if context.hasImage: context.image.width else: self.frameConfig.renderWidth(),
    if context.hasImage: context.image.height else: self.frameConfig.renderHeight(),
    message
  )

proc get*(self: App, context: ExecutionContext): Image =
  try:
    let url = self.appConfig.url.replace("'", "\\'")
    let command = "ffmpeg -loglevel quiet -y -i '" & url & "' -vframes 1 -f image2 -c:v bmp pipe:1"

    if self.frameConfig.debug:
      self.log "Running: " & command

    # Run ffmpeg
    var p = startProcess(command, options = {poUsePath, poEvalCommand, poDaemon})
    defer:
      p.close()

    let outputStream = p.outputStream()
    let data = outputStream.readAll()
    let exitCode = p.waitForExit()

    if exitCode != 0:
      self.logError "ffmpeg exited with code " & $exitCode
      return renderError(self, context, "ffmpeg failed to run (exit code " & $exitCode & ")")

    try:
      return decodeImageWithFallback(data)
    except CatchableError as decodeErr:
      self.logError "Failed to decode image: " & decodeErr.msg
      return renderError(self, context, "Could not decode image from ffmpeg output")

  except OSError as osErr:
    self.logError "OS error when starting ffmpeg: " & osErr.msg
    return renderError(self, context, "ffmpeg not found or not executable")

  except CatchableError as e:
    self.logError "Unexpected error: " & e.msg
    return renderError(self, context, "An unexpected error occurred")
