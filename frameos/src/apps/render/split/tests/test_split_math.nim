import std/math
import ../app

block test_extract_margins_supports_css_like_shorthand:
  let m1 = extractMargins("10")
  doAssert m1 == (10.0, 10.0, 10.0, 10.0)

  let m2 = extractMargins("10 20")
  doAssert m2 == (10.0, 20.0, 10.0, 20.0)

  let m4 = extractMargins("1 2 3 4")
  doAssert m4 == (1.0, 2.0, 3.0, 4.0)

block test_extract_gaps_supports_one_or_two_values:
  let g1 = extractGaps("5")
  doAssert g1 == (5.0, 5.0)

  let g2 = extractGaps("5 7")
  doAssert g2 == (5.0, 7.0)

block test_extract_ratios_repeats_provided_ratio_lists:
  let (widthRatios, heightRatios, totalWidth, totalHeight) = extractRatios("1 2", "3", columns = 3, rows = 2)
  doAssert widthRatios == @[1.0, 2.0, 1.0]
  doAssert heightRatios == @[3.0, 3.0]
  doAssert abs(totalWidth - 4.0) < 0.000001
  doAssert abs(totalHeight - 6.0) < 0.000001

block test_split_dimensions_applies_margins_gaps_and_ratios:
  let config = AppConfig(
    rows: 2,
    columns: 2,
    gap: "4",
    margin: "10",
    widthRatios: "1 3",
    heightRatios: "1 1",
  )

  let dims = splitDimensions(100, 60, config)
  doAssert dims.len == 4
  doAssert dims[0] == (19, 18)
  doAssert dims[1] == (57, 18)
  doAssert dims[2] == (19, 18)
  doAssert dims[3] == (57, 18)

block test_split_dimensions_rounds_and_backfills_the_final_cell:
  let config = AppConfig(
    rows: 1,
    columns: 3,
    gap: "1",
    margin: "",
    widthRatios: "",
    heightRatios: "",
  )

  let dims = splitDimensions(10, 5, config)
  doAssert dims.len == 3
  doAssert dims[0] == (3, 5)
  doAssert dims[1] == (3, 5)
  doAssert dims[2] == (2, 5)
