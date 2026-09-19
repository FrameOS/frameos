import ../pointer

block test_a_full_range_digitizer_is_unchanged:
  for value in [0, 1, 16384, 32767]:
    doAssert scalePointerAxis(value, 0, 32767) == value

block test_a_touchscreen_in_panel_pixels_spans_the_whole_range:
  doAssert scalePointerAxis(0, 0, 479) == 0
  doAssert scalePointerAxis(479, 0, 479) == PointerRange
  doAssert scalePointerAxis(240, 0, 479) == 240 * PointerRange div 479

block test_out_of_range_reports_are_clamped:
  doAssert scalePointerAxis(-5, 0, 719) == 0
  doAssert scalePointerAxis(900, 0, 719) == PointerRange

block test_an_offset_range_is_shifted:
  doAssert scalePointerAxis(100, 100, 200) == 0
  doAssert scalePointerAxis(200, 100, 200) == PointerRange

block test_an_axis_without_a_range_passes_through:
  doAssert scalePointerAxis(1234, 0, 0) == 1234
