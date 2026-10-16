## The JavaScript app test harness (app_tests.nim, app_test_harness.js): a
## test file next to an app's app.ts runs in the app's own interpreter with
## describe / it / expect / mock / makeApp, and the report says what passed.
## The second suite runs every repo app's own tests (repo/apps/**/*.test.ts),
## which is how a test file is checked without a browser.
import std/[json, os, strutils, unittest]
import frameos/js_runtime/app_tests
import frameos/types

const RepoApps = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / ".." / "repo" / "apps"

const ProbeConfig = """{"name": "Probe", "category": "data",
  "fields": [{"name": "city", "type": "string", "value": "Brussels"}, {"name": "count", "type": "integer", "value": 3}],
  "output": [{"name": "json", "type": "json"}], "settings": ["openAI"]}"""

const ProbeApp = """
import { shout } from './util'
export function get(app, context) {
  const key = frameos.getSetting('openAI', 'apiKey')
  const r = frameos.httpRequest('https://example.com/' + app.config.city, { method: 'GET' })
  frameos.setState('seen', (app.state.seen || 0) + 1)
  console.log('city', app.config.city)
  return { status: r.status, body: shout(r.body), key, count: app.config.count, event: context.event }
}
"""
const ProbeUtil = "export const shout = (s: string): string => String(s).toUpperCase()\n"

const ProbeTest = """
import { get } from './app'
describe('probe', () => {
  it('runs the app with a mocked request', () => {
    const http = mock.httpRequest((url) => mock.response(200, 'hi ' + url))
    const app = makeApp({ settings: { openAI: { apiKey: 'k' } }, state: { seen: 4 } })
    const out = get(app, makeContext())
    expect(out).toEqual({ status: 200, body: 'HI HTTPS://EXAMPLE.COM/BRUSSELS', key: 'k', count: 3, event: 'render' })
    expect(http).toHaveBeenCalledTimes(1)
    expect(http).toHaveBeenCalledWith('https://example.com/Brussels', { method: 'GET' })
    expect(app.state.seen).toBe(5)
    expect(app.config).toMatchObject({ city: 'Brussels' })
  })
  it('fails on a wrong expectation', () => {
    expect(1 + 1).toBe(3)
  })
  it('fails when the app reaches the network unmocked', () => {
    get(makeApp(), makeContext())
  })
  it.skip('is skipped', () => {
    expect(true).toBe(false)
  })
  describe('nested', () => {
    beforeEach(() => {
      mock.httpRequest(() => mock.json({ ok: true }))
    })
    it('fetchJson goes through the mocked request', () => {
      expect(frameos.fetchJson('https://x')).toEqual({ ok: true })
      expect(() => frameos.fetchImage('https://x')).toThrow('not mocked')
      expect(mock.image({ width: 4, height: 2 }).image).toMatchObject({ __frameosType: 'image', width: 4, height: 2 })
    })
    it('collects what the test logs', () => {
      console.log('hello', { a: 1 })
      frameos.error('bad')
      console.warn('careful')
    })
    it('keeps memory and the next sleep on the app', () => {
      const app = makeApp()
      expect(frameos.remember('k', [1, 2])).toBe(true)
      expect(frameos.recall('k')).toEqual([1, 2])
      frameos.setNextSleep(12)
      expect(app.nextSleep).toBe(12)
      expect(frameos.recall('missing')).toBeUndefined()
    })
  })
})
"""

proc probeSources(): JsonNode =
  %*{"config.json": ProbeConfig, "app.ts": ProbeApp, "util.ts": ProbeUtil, "app.test.ts": ProbeTest,
     "broken.test.ts": "import { get } from './app'\ndescribe('x', () => {\n  it('y', () => {\n", 
     "nothing.test.ts": "import { nope } from './missing'\n"}

proc frameConfig(): FrameConfig =
  FrameConfig(width: 200, height: 120, rotate: 0, scalingMode: "cover", debug: false,
    saveAssets: %*false, settings: %*{}, timeZone: "UTC")

proc child(report: JsonNode, path: varargs[string]): JsonNode =
  result = report
  for name in path:
    var found: JsonNode = nil
    for c in result["children"]:
      if c["name"].getStr() == name:
        found = c
    doAssert not found.isNil, "no child " & name
    result = found

suite "JavaScript app tests":
  test "test files are the ones named .test.*":
    check isAppTestFile("app.test.ts")
    check isAppTestFile("lib/Helper.TEST.tsx")
    check not isAppTestFile("app.ts")
    check not isAppTestFile("test.ts")
    check appTestFiles(probeSources()) == @["app.test.ts", "broken.test.ts", "nothing.test.ts"]

  test "a test file runs in the app's interpreter and reports every outcome":
    let report = runJsAppTests(probeSources(), "app.test.ts", frameConfig())
    checkpoint($report)
    check report["ok"].getBool() == false
    check report["counts"] == %*{"passed": 4, "failed": 2, "skipped": 1, "total": 7}
    check report["file"].getStr() == "app.test.ts"
    let probe = report.child("probe")
    check probe["status"].getStr() == "failed"
    check probe.child("runs the app with a mocked request")["status"].getStr() == "passed"
    # The app's own console.log, captured per test.
    check probe.child("runs the app with a mocked request")["logs"] == %*[{"level": "log", "text": "city Brussels"}]
    let wrong = probe.child("fails on a wrong expectation")
    check wrong["status"].getStr() == "failed"
    check wrong["error"]["message"].getStr() == "expected 2 to be 3"
    check wrong["error"]["stack"].getStr().contains("app.test.ts:")
    let unmocked = probe.child("fails when the app reaches the network unmocked")
    check unmocked["status"].getStr() == "failed"
    check unmocked["error"]["message"].getStr().contains("frameos.httpRequest is not mocked")
    check probe.child("is skipped")["status"].getStr() == "skipped"
    let nested = probe.child("nested")
    check nested["status"].getStr() == "passed"
    check nested.child("collects what the test logs")["logs"] == %*[
      {"level": "log", "text": "hello {\"a\":1}"}, {"level": "error", "text": "bad"}, {"level": "warn", "text": "careful"}]
    check nested.child("keeps memory and the next sleep on the app")["status"].getStr() == "passed"

  test "a test file that does not parse, or imports what is not there, is one failed report":
    let broken = runJsAppTests(probeSources(), "broken.test.ts", frameConfig())
    check broken["ok"].getBool() == false
    check broken["error"].getStr().len > 0
    check broken["counts"]["total"].getInt() == 0
    let nothing = runJsAppTests(probeSources(), "nothing.test.ts", frameConfig())
    check nothing["ok"].getBool() == false
    check nothing["error"].getStr().contains("missing")
    check runJsAppTests(probeSources(), "app.ts", frameConfig())["error"].getStr().contains("Not a test file")
    check runJsAppTests(probeSources(), "gone.test.ts", frameConfig())["error"].getStr().contains("No such file")
    let all = runAllJsAppTests(probeSources(), frameConfig())
    check all["ok"].getBool() == false
    check all["files"].len == 3

  test "every repo app's own tests pass":
    var ran = 0
    for folder in walkDirs(RepoApps / "*"):
      for appDir in walkDirs(folder / "*"):
        var sources = %*{}
        for file in walkDirRec(appDir, relative = true):
          sources[file] = %readFile(appDir / file)
        for testFile in appTestFiles(sources):
          let report = runJsAppTests(sources, testFile, frameConfig())
          inc ran
          if not report["ok"].getBool():
            checkpoint(appDir / testFile & ": " & $report)
          check report["ok"].getBool()
          check report["counts"]["total"].getInt() > 0
    checkpoint("ran " & $ran & " repo app test files")
    check ran >= 15
