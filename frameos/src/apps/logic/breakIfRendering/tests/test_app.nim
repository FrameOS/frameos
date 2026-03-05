import std/unittest

import ../app
import frameos/types

suite "logic/breakIfRendering app":
  test "raises only while scene is rendering":
    let renderingScene = FrameScene(isRendering: true)
    let appRendering = App(scene: renderingScene)
    expect(Exception):
      appRendering.run(ExecutionContext())

    let idleScene = FrameScene(isRendering: false)
    let appIdle = App(scene: idleScene)
    appIdle.run(ExecutionContext())
