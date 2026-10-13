## Built-in Nim apps that were deleted in favour of a repo JavaScript app
## (docs/retired-apps.json, docs/retired-apps.md).
##
## Both control planes rewrite a retired keyword into the JS app before a
## current runtime sees it. This is the Linux runtime's fallback for the one
## case they cannot reach: scenes already on disk when the runtime itself
## moved on. A Pi updates itself (auto_update, the admin UI) and carries its
## scenes.json forward without a redeploy, so a scene deployed while it ran an
## older release still names `data/immich` or `data/frameOSGallery` after
## the update. Such a node gets the replacement app from the generated copy
## (retired_apps_gen.nim) — the same sources a converted scene would carry.
##
## Not on the ESP32 or in the wasm preview: the ESP32 re-pulls its scenes on
## every wake and its control plane hands it the converted form, and every
## byte of its app slot counts; the preview only ever sees converted scenes.

import std/json

when not defined(frameosEmbedded) and not defined(frameosWasm):
  import frameos/retired_apps_gen

  proc retiredAppSources*(keyword: string): JsonNode =
    ## The replacement app's files for a retired keyword, or nil.
    if keyword notin RetiredAppKeywords:
      return nil
    try:
      let all = parseJson(RetiredAppSourcesJson)
      result = all{keyword}
    except CatchableError:
      result = nil
else:
  proc retiredAppSources*(keyword: string): JsonNode =
    discard keyword
    nil
