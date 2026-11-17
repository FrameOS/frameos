## The code editor's hook (docs/code-editor.md): what a JS app reads and asks
## with `frameos.code(op, arg)`. The Code editor sample scene is the app that
## uses it; an app needs the "code" permission.
##
## The host has the facts and does the work, off the render task: the Pi's
## frameos/scene_code_linux.nim, the ESP32's main/fos_code.c through
## embedded/embedded_runtime.nim, the browser preview's
## frameos/scene_code_preview.nim (reads only). A runtime without a host
## leaves it nil, and the app reads null. One hook, not one per operation:
## each is a proc and a bridge in the ESP32's flash.

type
  SceneCode* = proc (asker, op, arg: string): string {.nimcall, gcsafe, raises: [].}
    ## The answer as JSON text, handed to the app as it is: "" is null, "!"
    ## and a reason is what the app's call throws. `asker` is the scene
    ## asking: news redraws it while it shows.
    ##
    ## - "read": the facts, or "" where the frame does not offer its page
    ##   (the owner turned the settings on its screen off): {busy: the action
    ##   running or "", error: the last action's refusal code, done: the last
    ##   action that worked, draft: {id, name, summary} or null, ask: an AI
    ##   can be asked, save: a scene can be saved, previewOnly?}.
    ## - "source" (`arg` a scene id): that scene's JSON text, "" without one.
    ## - "draft": the AI's last scene, "" without one.
    ## - "ask" {action, prompt, scene?}, "save" {action, scene, show?} (`arg`
    ##   JSON text, the request body as the plane takes it), "clear": started,
    ##   "true". One at a time: an action while one runs is dropped, and one
    ##   the host does not know is ignored. The host renders `asker` again
    ##   when it is done.
    ## - Anything but "read" while the page is not offered: SettingsOffCode.

const SettingsOffCode* = "!settings on the frame's screen are off"

var sceneCode*: SceneCode
