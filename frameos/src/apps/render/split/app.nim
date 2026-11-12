import strutils
import tables
import pixie
import options
import frameos/apps
import frameos/types
import frameos/utils/image

type
  AppConfig* = object
    inputImage*: Option[Image]
    hideEmpty*: bool
    rows*: int
    columns*: int
    renderFunctions*: seq[seq[NodeId]]
    renderFunction*: NodeId
    gap*: string
    margin*: string
    widthRatios*: string
    heightRatios*: string

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc extractMargins*(marginString: string): (float, float, float, float) =
  let
    margins = if marginString == "": @[] else: marginString.split(' ')
    marginTop = if margins.len > 0: parseFloat(margins[0]) else: 0.0
    marginRight = if margins.len > 1: parseFloat(margins[1]) else: marginTop
    marginBottom = if margins.len > 2: parseFloat(margins[2]) else: marginTop
    marginLeft = if margins.len > 3: parseFloat(margins[3]) else: marginRight
  result = (marginTop, marginRight, marginBottom, marginLeft)

proc extractGaps*(gapString: string): (float, float) =
  let
    gaps = if gapString == "": @[] else: gapString.split(' ')
    gapHorizontal = if gaps.len > 0: parseFloat(gaps[0]) else: 0.0
    gapVertical = if gaps.len > 1: parseFloat(gaps[1]) else: gapHorizontal
  result = (gapHorizontal, gapVertical)

proc extractRatios*(widthRatios: string, heightRatios: string, columns: int,
    rows: int): (seq[float], seq[float], float, float) =
  let
    widthRatios = if widthRatios == "": @[] else: widthRatios.split(' ')
    heightRatios = if heightRatios == "": @[] else: heightRatios.split(' ')

  var
    normalizedWidthRatios = newSeq[float](columns)
    normalizedHeightRatios = newSeq[float](rows)
    totalWidthRatio = 0.0
    totalHeightRatio = 0.0

  for i in 0..(columns-1):
    normalizedWidthRatios[i] = if widthRatios.len > 0: parseFloat(widthRatios[
        i mod widthRatios.len]) else: 1.0
    totalWidthRatio += normalizedWidthRatios[i]
  for i in 0..(rows-1):
    normalizedHeightRatios[i] = if heightRatios.len > 0: parseFloat(
        heightRatios[i mod heightRatios.len]) else: 1.0
    totalHeightRatio += normalizedHeightRatios[i]
  if totalWidthRatio == 0.0:
    for i in 0..(columns-1):
      normalizedWidthRatios[i] = 1.0
    totalWidthRatio = columns.toFloat
  if totalHeightRatio == 0.0:
    for i in 0..(rows-1):
      normalizedHeightRatios[i] = 1.0
    totalHeightRatio = rows.toFloat
  result = (normalizedWidthRatios, normalizedHeightRatios, totalWidthRatio, totalHeightRatio)

proc splitDimensions*(width: int, height: int, appConfig: AppConfig): seq[(int, int)] =
  let
    rows = appConfig.rows
    columns = appConfig.columns

    (marginTop, marginRight, marginBottom, marginLeft) = extractMargins(appConfig.margin)
    (gapHorizontal, gapVertical) = extractGaps(appConfig.gap)

    imageWidth = width.toFloat - marginLeft - marginRight - (columns - 1).toFloat * gapHorizontal
    imageHeight = height.toFloat - marginTop - marginBottom - (rows - 1).toFloat * gapVertical

    (widthRatios, heightRatios, totalWidthRatio, totalHeightRatio) = extractRatios(
        appConfig.widthRatios, appConfig.heightRatios, columns, rows)

  var
    cellWidths, cellHeights: seq[int]

  var
    totalWidth: int = 0
    totalHeight: int = 0

  # Calculate cell dimensions
  for i in 0..(columns-1):
    let width: int = (imageWidth * widthRatios[i] / totalWidthRatio).toInt
    totalWidth += width
    cellWidths.add(width)
  for i in 0..(rows-1):
    let height: int = (imageHeight * heightRatios[i] / totalHeightRatio).toInt
    totalHeight += height
    cellHeights.add(height)

  # Adjust last cell dimensions to fill the image
  cellWidths[cellWidths.len - 1] = imageWidth.toInt - (totalWidth - cellWidths[cellWidths.len - 1])
  cellHeights[cellHeights.len - 1] = imageHeight.toInt - (totalHeight - cellHeights[cellHeights.len - 1])

  # Return cell dimensions as a sequence of tuples
  result = newSeq[(int, int)](rows * columns)
  for row in 0..<rows:
    for col in 0..<columns:
      result[row * columns + col] = (cellWidths[col], cellHeights[row])

proc rendersItsOwnCell(self: App, node: NodeId): bool =
  ## A scene node in a cell paints its own background, or leaves what the
  ## canvas holds (frameos/scene_rhythm.nim).
  if self.scene of InterpretedFrameScene:
    let found = InterpretedFrameScene(self.scene).nodes.getOrDefault(node)
    result = not found.isNil and found.nodeType == "scene"

proc payBackground(image: Image, color: Color, x, y, w, h: int) =
  let
    x1 = clamp(x, 0, image.width)
    y1 = clamp(y, 0, image.height)
    w1 = min(w, image.width - x1)
    h1 = min(h, image.height - y1)
  if w1 > 0 and h1 > 0:
    image.view(x1, y1, w1, h1).fill(color)

{.push boundChecks: off, overflowChecks: off, rangeChecks: off.}
proc render*(self: App, context: ExecutionContext, image: var Image) =
  let
    rows = self.appConfig.rows
    columns = self.appConfig.columns
    renderFunction = self.appConfig.renderFunction
    renderFunctions = self.appConfig.renderFunctions

  if rows <= 0:
    writeError(image, image.width, image.height, "Grid: Invalid rows value")
    return
  if columns <= 0:
    writeError(image, image.width, image.height, "Grid: Invalid columns value")
    return

  # Calculate cell dimensions
  let
    cellDims = splitDimensions(image.width, image.height, self.appConfig)
    (marginTop, marginRight {.used.}, marginBottom {.used.}, marginLeft) = extractMargins(self.appConfig.margin)
    (gapHorizontal, gapVertical) = extractGaps(self.appConfig.gap)

  # The background owed goes on the margins, the gaps and the cells nothing
  # draws in, but not under a panel, whose pixels may be staying.
  let owed = context.backgroundPending
  context.backgroundPending = false
  var above = 0

  # Loop through each cell defined by rows and columns
  var cellY = marginTop
  for row in 0..<rows:
    let top = cellY.toInt
    if owed: image.payBackground(context.backgroundColor, 0, above, image.width, top - above)
    var cellX = marginLeft
    var before = 0
    for column in 0..<columns:
      let (cellWidth, cellHeight) = cellDims[row * columns + column]
      let renderer: NodeId = if row < renderFunctions.len and column < renderFunctions[row].len and
          renderFunctions[row][column] != 0: renderFunctions[row][column] else: renderFunction
      if owed:
        let left = cellX.toInt
        image.payBackground(context.backgroundColor, before, top, left - before, cellHeight)
        if renderer == 0 or not self.rendersItsOwnCell(renderer):
          image.payBackground(context.backgroundColor, left, top, cellWidth, cellHeight)
        before = left + cellWidth
        if column == columns - 1:
          image.payBackground(context.backgroundColor, before, top, image.width - before, cellHeight)
          above = top + cellHeight
      if renderer != 0:
        # Cells render at cell size, not canvas size: the child sees a
        # cellWidth x cellHeight context and everything downstream (JS apps,
        # render/image, nested splits) sizes itself from context.image.
        #
        # That context is now a VIEW onto this image rather than a copy of the
        # region, so the child draws straight into the canvas and there is
        # nothing to draw back. It is what a cell always meant; it just used to
        # cost a buffer to say it. Nesting is where it tells: a view of a view
        # flattens onto the original owner, so a split inside a split inside a
        # split costs the canvas and nothing else, where copies stacked one
        # region per level for as long as the innermost cell was rendering.
        #
        # One semantic edge moved with it: a child using an ERASING blend
        # (overwrite/mask) over a transparent source now punches that alpha
        # into the canvas, where the copy path flattened it on the normal-blend
        # draw back. That matches what the same node does outside a split;
        # docs/value-pipeline.md carries the full reasoning.
        #
        # Margins, gaps and ratios are floats, so a cell can round to a rect a
        # pixel outside the parent. A view has to fit exactly, so clamp rather
        # than let a rounding edge become a render error.
        let viewX = clamp(cellX.toInt, 0, max(0, image.width - 1))
        let viewY = clamp(cellY.toInt, 0, max(0, image.height - 1))
        let viewW = clamp(cellWidth, 1, image.width - viewX)
        let viewH = clamp(cellHeight, 1, image.height - viewY)
        let img = image.view(viewX, viewY, viewW, viewH)
        var cellContext = ExecutionContext(
            scene: context.scene,
            image: img,
            hasImage: true,
            event: context.event,
            payload: context.payload,
            parent: context,
            loopIndex: row * columns + column,
            loopKey: context.loopKey & "/" & $(row * columns + column),
            nextSleep: context.nextSleep
        )
        self.scene.execNode(renderer, cellContext)
        if cellContext.nextSleep != context.nextSleep:
          context.nextSleep = cellContext.nextSleep
        if cellContext.image != img:
          # The child swapped its context image for one of its own instead of
          # drawing into what it was given. Nothing wrote through, so it still
          # has to be composited into place.
          image.draw(cellContext.image, translate(vec2(viewX.float32, viewY.float32)))

      cellX += cellWidth.toFloat + gapHorizontal
      if column == columns - 1:
        cellY += cellHeight.toFloat + gapVertical
  if owed: image.payBackground(context.backgroundColor, 0, above, image.width, image.height - above)
{.pop.}

proc run*(self: App, context: ExecutionContext) =
  render(self, context, context.image)

proc get*(self: App, context: ExecutionContext): Image =
  result = if self.appConfig.inputImage.isSome:
    self.appConfig.inputImage.get()
  elif context.hasImage:
    newImage(context.image.width, context.image.height)
  else:
    newImage(self.frameConfig.renderWidth(), self.frameConfig.renderHeight())
  render(self, context, result)
