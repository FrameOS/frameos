import strutils
import pixie
import frameos/config
import frameos/types
import frameos/utils/image

type
  AppConfig* = object
    rows*: int
    columns*: int
    renderFunctions*: seq[seq[NodeId]]
    renderFunction*: NodeId
    gap*: string
    margin*: string
    widthRatios*: string
    heightRatios*: string

  App* = ref object
    nodeId*: NodeId
    scene*: FrameScene
    appConfig*: AppConfig
    frameConfig*: FrameConfig

proc init*(nodeId: NodeId, scene: FrameScene, appConfig: AppConfig): App =
  result = App(
    nodeId: nodeId,
    scene: scene,
    appConfig: appConfig,
    frameConfig: scene.frameConfig,
  )

proc extractMargins(marginString: string): (float, float, float, float) =
  let
    margins = if marginString == "": @[] else: marginString.split(' ')
    marginTop = if margins.len > 0: parseFloat(margins[0]) else: 0.0
    marginRight = if margins.len > 1: parseFloat(margins[1]) else: marginTop
    marginBottom = if margins.len > 2: parseFloat(margins[2]) else: marginTop
    marginLeft = if margins.len > 3: parseFloat(margins[3]) else: marginRight
  result = (marginTop, marginRight, marginBottom, marginLeft)

proc extractGaps(gapString: string): (float, float) =
  let
    gaps = if gapString == "": @[] else: gapString.split(' ')
    gapHorizontal = if gaps.len > 0: parseFloat(gaps[0]) else: 0.0
    gapVertical = if gaps.len > 1: parseFloat(gaps[1]) else: gapHorizontal
  result = (gapHorizontal, gapVertical)

proc extractRatios(widthRatios: string, heightRatios: string, columns: int,
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
  result = (normalizedWidthRatios, normalizedHeightRatios, totalWidthRatio, totalHeightRatio)

proc splitDimensions(width: int, height: int, appConfig: AppConfig): seq[(int, int)] =
  let
    rows = appConfig.rows
    columns = appConfig.columns

    (marginTop, marginRight, marginBottom, marginLeft) = extractMargins(
        appConfig.margin)
    (gapHorizontal, gapVertical) = extractGaps(appConfig.gap)

    imageWidth = width.toFloat - marginLeft - marginRight - (columns -
        1).toFloat * gapHorizontal
    imageHeight = height.toFloat - marginTop - marginBottom - (rows -
        1).toFloat * gapVertical

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
  cellWidths[cellWidths.len - 1] = imageWidth.toInt - (totalWidth - cellWidths[
      cellWidths.len - 1])
  cellHeights[cellHeights.len - 1] = imageHeight.toInt - (totalHeight -
      cellHeights[cellHeights.len - 1])

  # Return cell dimensions as a sequence of tuples
  result = newSeq[(int, int)](rows * columns)
  for row in 0..<rows:
    for col in 0..<columns:
      result[row * columns + col] = (cellWidths[col], cellHeights[row])

proc run*(self: App, context: var ExecutionContext) =
  let
    rows = self.appConfig.rows
    columns = self.appConfig.columns
    renderFunction = self.appConfig.renderFunction
    renderFunctions = self.appConfig.renderFunctions

  if rows <= 0:
    writeError(context.image, self.frameConfig.renderWidth(), self.frameConfig.renderHeight(), "Split: Invalid rows value")
    return
  if columns <= 0:
    writeError(context.image, self.frameConfig.renderWidth(), self.frameConfig.renderHeight(), "Split: Invalid columns value")
    return

  # Calculate cell dimensions
  let
    cellDims = splitDimensions(context.image.width, context.image.height,
      self.appConfig)
    (marginTop, marginRight {.used.}, marginBottom {.used.},
        marginLeft) = extractMargins(self.appConfig.margin)
    (gapHorizontal, gapVertical) = extractGaps(self.appConfig.gap)

  # Loop through each cell defined by rows and columns
  var cellY = marginTop
  for row in 0..<rows:
    var cellX = marginLeft
    for column in 0..<columns:
      let (cellWidth, cellHeight) = cellDims[row * columns + column]
      let image = context.image.subImage(cellX.toInt, cellY.toInt, cellWidth, cellHeight)
      let renderer: NodeId = if row >= 0 and row < renderFunctions.len and column >= 0 and column < renderFunctions[
          row].len and renderFunctions[row][column] == 0: renderFunction else: renderFunctions[row][column]
      if renderer != 0:
        var cellContext = ExecutionContext(
            scene: context.scene,
            image: image,
            event: context.event,
            payload: context.payload,
            parent: context,
            loopIndex: row * columns + column,
            loopKey: context.loopKey & "/" & $(row * columns + column)
        )
        self.scene.execNode(renderer, cellContext)
      context.image.draw(
        image,
        translate(vec2(cellX, cellY))
      )
      cellX += cellWidth.toFloat + gapHorizontal
      if column == columns - 1:
        cellY += cellHeight.toFloat + gapVertical
