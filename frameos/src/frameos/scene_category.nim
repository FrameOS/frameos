## A scene's category (`settings.category`, docs/scene-icons.md "Category"):
## one of the store's category slugs, which a desktop layout groups its scene
## lists by (`app.frame.scenes`). Any other value stays in the scene and is
## listed as none. The slugs are the store's (frontend/src/utils/
## storeCategories.ts), pinned by docs/scene-category-fixtures.json.

import std/strutils

const SceneCategories* = ["photos", "art", "calendar", "weather", "ai", "dashboards", "fun", "realtime",
  "desktops", "layouts", "utilities", "demos"]

proc sceneCategory*(raw: string): string =
  ## `raw` as a category slug (trimmed, in lower case), or "" when the store
  ## has no such category.
  let slug = raw.strip().toLowerAscii()
  for known in SceneCategories:
    if slug == known:
      return slug
