"""What a board's keys do before anyone changes them (docs/buttons.md).

One function, `default_event_map`, makes a hardware preset's frame event map
(frame.json `eventMap`, docs/events.md "Event map") out of what the board
has: its keys and the role each one plays, a touch screen or not, a
microphone or not. Every preset's map comes from here
(`EMBEDDED_HARDWARE_PRESETS`), and so do the copies other code needs, which
`frameos/tools/generate_board_keys.py` writes and the backend suite checks:
the firmware's own table (`embedded/esp32/main/fos_board_keys_gen.h`), the
SPA's (`frontend/src/generated/boardKeys.gen.ts`) and the maps of the Linux
devices that come with keys or a glass (`frameos/src/frameos/device_event_map_gen.nim`).

The standard, in short (docs/buttons.md has the why):

- A short press belongs to the scene. Holds belong to the frame, and so do
  the keys that have one job (Home, Back, Screen).
- Action (`primary`) held: the voice chat on a board with a microphone,
  else Home (the scene list).
- Next / Prev held: the next / previous scene. Matched by role, not label,
  because a key that points somewhere turns with the frame.
- Back pressed: `back`; held: Home. A board with no Back key gets one from
  two keys held together (matched by role: the key made of two has no label
  of its own).
- Home pressed: the scene list; held: the scene's settings.
- Screen pressed: the screen off and on; held: the voice chat if it is the
  board's only way to talk, else Home.
- A touch screen's edges: in from the left `back`, from the right
  `forward`, up from the bottom the scene list, down from the top the
  scene's settings.
- No double or triple press, anywhere: two presses are two presses.
"""

from __future__ import annotations

import copy
from typing import Any, Iterable

ACTION_ROLES = ("primary", "refresh", "secondary")
ARROW_ROLES = ("next", "prev", "left", "right", "up", "down")
NEXT_ROLES = ("next", "right", "down")

# A touch screen's swipes in from an edge (docs/scene-switcher.md,
# docs/scene-settings.md): the scene's own back and forward, never another
# scene, the scene list and the scene's settings.
TOUCH_EDGE_SWIPES: list[dict[str, Any]] = [
    {"event": "edgeSwipe", "match": {"edge": "right"}, "emit": "forward", "as": {}},
    {"event": "edgeSwipe", "match": {"edge": "left"}, "emit": "back", "as": {}},
    {"event": "edgeSwipe", "match": {"edge": "bottom"}, "emit": "sceneSwitcher", "as": {}},
    {"event": "edgeSwipe", "match": {"edge": "top"}, "emit": "sceneSettings", "as": {}},
]


def _key_rule(label: str, action: str, emit: str, as_: dict[str, Any] | None = None) -> dict[str, Any]:
    return {"event": "button", "match": {"label": label, "action": action}, "emit": emit, "as": as_ or {}}


def _role_rule(role: str, action: str, emit: str, as_: dict[str, Any] | None = None) -> dict[str, Any]:
    return {"event": "button", "match": {"role": role, "action": action}, "emit": emit, "as": as_ or {}}


def key_kind(role: str) -> str:
    """What a key is for: action, arrow, back, home, screen, or "" for none."""
    if role in ACTION_ROLES:
        return "action"
    if role in ARROW_ROLES:
        return "arrow"
    if role == "back":
        return "back"
    if role == "menu":
        return "home"
    if role == "screen":
        return "screen"
    return ""


def default_event_map(keys: Iterable[dict[str, Any]], *, touch: bool, mic: bool) -> list[dict[str, Any]]:
    """The frame event map of a board with these keys (each `{label, role,
    hold?}`; `hold` false for a key that is only ever pressed, such as a
    crown's turns, which the firmware makes into presses), a touch screen or
    not, and a microphone or not. An empty list for a board with neither."""
    keys = [k for k in keys if k.get("label") and key_kind(k.get("role", ""))]
    held = [k for k in keys if k.get("hold", True)]
    kinds = {key_kind(k["role"]) for k in keys}
    rules: list[dict[str, Any]] = []
    voice_taken = False
    # The voice key is the Action key; without one, the Screen key.
    voice_kind = "action" if any(key_kind(k["role"]) == "action" for k in held) else "screen"
    for key in keys:
        label = key["label"]
        kind = key_kind(key["role"])
        can_hold = key.get("hold", True)
        if kind == "screen":
            rules.append(_key_rule(label, "press", "toggleScreen"))
        elif kind == "home":
            rules.append(_key_rule(label, "press", "sceneSwitcher"))
        elif kind == "back":
            rules.append(_key_rule(label, "press", "back"))
        if not can_hold:
            continue
        if kind == "home":
            rules.append(_key_rule(label, "longPress", "sceneSettings"))
        elif kind == "back":
            rules.append(_key_rule(label, "longPress", "sceneSwitcher"))
        elif kind in ("action", "screen"):
            if mic and kind == voice_kind and not voice_taken:
                voice_taken = True
                rules.append(_key_rule(label, "longPress", "voiceChat"))
            else:
                rules.append(_key_rule(label, "longPress", "sceneSwitcher"))
    # The arrows held walk the scenes, by role: a reTerminal turned upside
    # down has its next key on the left (docs/events.md "Buttons").
    if any(key_kind(k["role"]) == "arrow" for k in held):
        rules.append(_role_rule("prev", "longPress", "setCurrentScene", {"direction": "prev"}))
        rules.append(_role_rule("next", "longPress", "setCurrentScene", {"direction": "next"}))
    # No Back key: two keys held together are one (input_state.nim makes it
    # where a rule binds Back by role).
    if "back" not in kinds and len(held) >= 2:
        rules.append(_role_rule("back", "press", "back"))
        rules.append(_role_rule("back", "longPress", "sceneSwitcher"))
    if touch:
        rules.extend(copy.deepcopy(TOUCH_EDGE_SWIPES))
    return rules
