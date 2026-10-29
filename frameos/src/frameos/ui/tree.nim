## A UI tree built in Nim, as the scene switcher, the scene settings and the
## on-screen keyboard build theirs: an element with its classes, and a class
## with an arbitrary length appended in place. One copy for the three, since
## each costs flash on an ESP32.

import pixie/fileformats/svg

{.push overflowChecks: off, rangeChecks: off, boundChecks: off, raises: [].}

proc el*(tag: string, classes: sink string, child: sink SvgNode = nil): SvgNode =
  ## A `tag` element with `classes`, and `child` in it when there is one. Pass
  ## a class string that a loop assigns again with `move`: Nim 2.2.4 hands a
  ## plain one to the sink without clearing it, and the next assignment frees
  ## what the node holds.
  result = SvgNode(tag: tag, attrs: @[("class", classes)])
  if not child.isNil:
    result.children.add child

proc px*(c: var string, name: string, v: int) =
  ## ` name-[Npx]`: a Tailwind class with an arbitrary length.
  c.add ' '
  c.add name
  c.add "-["
  c.addInt v
  c.add "px]"

{.pop.}
