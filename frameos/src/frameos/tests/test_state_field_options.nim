import std/unittest
import jsony

import ../interpreter
import ../types

const sceneJson = """[
  {
    "id": "scene-1",
    "name": "Options",
    "nodes": [],
    "edges": [],
    "apps": {},
    "fields": [
      {
        "name": "theme",
        "label": "Theme",
        "type": "select",
        "value": "dark",
        "access": "public",
        "options": ["dark", {"value": "light", "label": "Light mode"}, {"value": "sepia"}, 12, null, ["x"]]
      }
    ],
    "settings": {"execution": "interpreted"}
  }
]"""

suite "select field options":
  test "parses both plain strings and value/label pairs":
    let scenes = parseInterpretedSceneInputs(sceneJson)
    check scenes.len == 1
    let options = scenes[0].fields[0].options
    check options.len == 6
    check options[0] == StateFieldOption(value: "dark", label: "dark")
    check options[1] == StateFieldOption(value: "light", label: "Light mode")
    # A pair without its own label falls back to the value
    check options[2] == StateFieldOption(value: "sepia", label: "sepia")
    # Shapes the editor should never write, but which must not kill the scene
    check options[3] == StateFieldOption(value: "12", label: "12")
    check options[4] == StateFieldOption(value: "", label: "")
    check options[5] == StateFieldOption(value: "", label: "")

  test "dumps back to the shape it came in as":
    let options = @[
      StateFieldOption(value: "dark", label: "dark"),
      StateFieldOption(value: "light", label: "Light mode"),
    ]
    check options.toJson() == """["dark",{"value":"light","label":"Light mode"}]"""
