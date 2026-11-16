## A scene's icon (`settings.icon`, docs/scene-icons.md): one SVG path in a
## 0 0 24 24 box, filled (nonzero) with the color of wherever it is shown.
## Read here alone, so every host lists the same thing in `app.frame.scenes`
## and the scene switcher draws only what pixie can: a value that is not an
## icon is no icon. The SPA's `utils/sceneIcon.ts` is the same rule, pinned
## together by docs/scene-icon-fixtures.json.

import pixie/[common, paths]

const SceneIconMaxLength* = 1024
  ## It travels to every frame, an ESP32's scene index included.

{.push overflowChecks: off, rangeChecks: off, boundChecks: off.}

proc sceneIconPath*(raw: string): string =
  ## `raw` as an icon, its ends trimmed, or "" when it is none: empty, too
  ## long, not starting with a moveto, holding anything but path commands,
  ## numbers and the separators pixie's reader knows (space, tab, CR, LF,
  ## comma), or not drawable (that reader refuses it).
  var first = 0
  var last = raw.len - 1
  while first <= last and raw[first] in {' ', '\t', '\n', '\r'}:
    inc first
  while last >= first and raw[last] in {' ', '\t', '\n', '\r'}:
    dec last
  let length = last - first + 1
  if length <= 0 or length > SceneIconMaxLength or raw[first] notin {'M', 'm'}:
    return ""
  for i in first .. last:
    if raw[i] notin {'M', 'm', 'L', 'l', 'H', 'h', 'V', 'v', 'C', 'c', 'S', 's', 'Q', 'q', 'T', 't',
        'A', 'a', 'Z', 'z', '0'..'9', 'e', 'E', '.', ',', '+', '-', ' ', '\t', '\n', '\r'}:
      return ""
  result = raw[first .. last]
  try:
    discard parsePath(result)
  except PixieError:
    result = ""

{.pop.}
