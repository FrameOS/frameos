import std/[times, unittest]

import ../app
import frameos/types

suite "data/clock app":
  test "uses formatCustom when format is custom":
    let app = App(
      appConfig: AppConfig(format: "custom", formatCustom: "yyyy")
    )

    let output = app.get(ExecutionContext())
    check output == now().format("yyyy")

  test "uses configured format for non-custom mode":
    let app = App(
      appConfig: AppConfig(format: "yyyy-MM", formatCustom: "dd")
    )

    let output = app.get(ExecutionContext())
    check output == now().format("yyyy-MM")
