## What a frame's keys are, as its config says (docs/buttons.md): the
## questions the built-in scenes and the dispatcher ask of `gpioButtons`.
## A frame whose keys nobody listed (an ESP32's own, an editor's preview)
## answers as a frame with every key.

import std/strutils
import ./types
import ./events

proc keyRole*(button: GPIOButton): string =
  ## The role the frame configured for a key, else the one its label carries.
  if button.isNil: ""
  elif button.role.len > 0: button.role
  else: buttonRoleForLabel(button.label.strip().toUpperAscii())

proc frameHasNoArrows*(config: FrameConfig): bool =
  ## The frame's keys are listed and none of them moves anything (no next,
  ## prev or direction): a board of one key, or of keys that each do one
  ## thing. Its scene list walks on a press and opens on the hold.
  if config.isNil or config.gpioButtons.len == 0:
    return false
  for button in config.gpioButtons:
    if button.keyRole in ["next", "prev", "left", "right", "up", "down"]:
      return false
  true
