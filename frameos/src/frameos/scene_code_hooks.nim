## The code editor's hooks (docs/code-editor.md): what a JS app reads and asks
## with `frameos.code(op, arg)`. The Code editor sample scene is the app that
## uses them; an app needs the "code" permission.
##
## The host has the facts and does the work, off the render task: the Pi's
## frameos/scene_code_linux.nim, the ESP32's main/fos_code.c through
## embedded/embedded_runtime.nim, the browser preview's
## frameos/scene_code_preview.nim (reads only). A runtime without a host
## leaves them nil, and the app reads null.

type
  SceneCodeRead* = proc (asker: string): string {.nimcall, gcsafe, raises: [].}
    ## JSON text, handed to the app as it is. "": no host to ask (the owner
    ## turned the settings on the frame's screen off). Else {busy: the action
    ## running or "", error: the last action's refusal code, done: the last
    ## action that worked, draft: {id, name, summary} or null, ask: an AI can
    ## be asked, save: a scene can be saved, previewOnly?}. `asker` is the
    ## scene reading: news redraws it while it shows.
  SceneCodeSource* = proc (what: string): string {.nimcall, gcsafe, raises: [].}
    ## A scene's JSON text as the frame holds it, "" when it holds none of
    ## that id. `what` is a scene id, or "\1draft" for the AI's last scene.
  SceneCodeAction* = proc (asker, action, args: string) {.nimcall, gcsafe, raises: [].}
    ## `args` is a JSON object's text. ask {prompt, scene?}, save {scene,
    ## show?}, clear. One at a time: an action while one runs is dropped. The
    ## host asks for a render of `asker` when it is done.

const DraftSource* = "\1draft"
  ## What `SceneCodeSource` is asked for the draft: no scene id has a \1.

var
  sceneCodeRead*: SceneCodeRead
  sceneCodeSource*: SceneCodeSource
  sceneCodeAction*: SceneCodeAction
