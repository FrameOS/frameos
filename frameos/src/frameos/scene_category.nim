## A scene's category (`settings.category`, docs/scene-icons.md "Category"):
## one of the store's category slugs, which a desktop layout groups its scene
## lists by (`app.frame.scenes`), under the name `app.frame.categories` gives
## it. Any other value stays in the scene and is listed as none. The table is
## docs/scene-categories.json's (scene_categories_gen.nim).

import std/[json, strutils]
import ./scene_categories_gen

export SceneCategoryIds, SceneCategoryNames

proc sceneCategory*(raw: string): string =
  ## `raw` as a category slug (trimmed, in lower case), or "" when the store
  ## has no such category.
  let slug = raw.strip().toLowerAscii()
  for known in SceneCategoryIds:
    if slug == known:
      return slug

proc sceneCategoriesJson*(): JsonNode =
  ## `app.frame.categories`: every category in shelf order, `{id, name}`, so
  ## an app shows a category by its name without a table of its own.
  result = newJArray()
  for i in 0 ..< SceneCategoryIds.len:
    let item = newJObject()
    item["id"] = newJString(SceneCategoryIds[i])
    item["name"] = newJString(SceneCategoryNames[i])
    result.add item
