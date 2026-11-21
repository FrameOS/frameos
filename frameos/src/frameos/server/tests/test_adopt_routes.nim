import std/[json, os, strutils, unittest]

import ../../local_access
import ../../types
import ../auth
import ./helpers/http_harness

# A backend adopts the frame with the code its frame page shows
# (routes/adopt_routes.nim, docs/scene-settings.md "Linking the frame"): the
# code is exchanged for the admin login, which is minted when the frame has
# none. Nothing about the frame is said while no code shows.

let dir = getTempDir() / "frameos-adopt-routes-test"
removeDir(dir)
createDir(dir)
let configPath = dir / "frame.json"
putEnv("FRAMEOS_CONFIG", configPath)

var server = startRouterServer(19339)

proc writeFrameJson(adminAuth: JsonNode) =
  writeFile(configPath, $(%*{"name": "Kitchen", "mode": "rpios", "device": "waveshare.EPD_7in5_V2",
    "frameAdminAuth": adminAuth}))
  invalidateFrameAdminAuthCache()

proc adopt(code: string): TestResponse =
  httpRequest(server.port, "POST", "/api/adopt", headers = [("Content-Type", "application/json")],
    body = $(%*{"code": code}))

suite "adoption by a backend":
  setup:
    clearLocalAccessChallenge()
    resetLocalAccessWrongCodes()
    configureServerState(defaultFrameConfig())

  test "no code on the panel: nothing to read, nothing to take":
    writeFrameJson(%*{"enabled": false})
    let info = httpRequest(server.port, "GET", "/api/adopt")
    check info.status == 200
    check parseJson(info.body) == %*{"adopting": false}
    let response = adopt("123456")
    check response.status == 410
    check parseJson(response.body)["error"].getStr() == "code_expired"

  test "a local network access code is not an adoption code":
    writeFrameJson(%*{"enabled": false})
    let challenge = startLocalAccessChallenge(LocalAccessScopeLocalNetwork)
    check parseJson(httpRequest(server.port, "GET", "/api/adopt").body)["adopting"].getBool() == false
    check adopt(challenge.code).status == 410
    # Still there for what it was shown for.
    check activeLocalAccessCode() == challenge.code

  test "the right code hands over the frame's admin login":
    writeFrameJson(%*{"enabled": true, "user": "owner", "pass": "hunter2"})
    let challenge = startLocalAccessChallenge(LocalAccessScopeAdopt)
    let info = parseJson(httpRequest(server.port, "GET", "/api/adopt").body)
    check info["adopting"].getBool()
    check info["kind"].getStr() == "linux"
    check info["platform"].getStr() == "linux"
    check challenge.code notin $info
    let wrong = adopt(if challenge.code == "000000": "000001" else: "000000")
    check wrong.status == 403
    check parseJson(wrong.body)["error"].getStr() == "invalid_code"
    let right = adopt(challenge.code)
    check right.status == 200
    check parseJson(right.body) == %*{"username": "owner", "password": "hunter2"}
    # Single use: the panel's code is gone.
    check activeLocalAccessCode() == ""
    check adopt(challenge.code).status == 410

  test "a frame with no admin login gets one, saved before it is handed over":
    writeFrameJson(%*{"enabled": false, "user": "", "pass": ""})
    let challenge = startLocalAccessChallenge(LocalAccessScopeAdopt)
    let right = adopt(challenge.code)
    check right.status == 200
    let login = parseJson(right.body)
    check login["username"].getStr() == "admin"
    check login["password"].getStr().len >= 24
    let saved = parseFile(configPath)
    check saved["name"].getStr() == "Kitchen"
    check saved["frameAdminAuth"] == %*{"enabled": true, "user": "admin", "pass": login["password"].getStr()}
    check adminAuthEnabled()

  test "a body that is not the code costs no attempt":
    writeFrameJson(%*{"enabled": false})
    discard startLocalAccessChallenge(LocalAccessScopeAdopt)
    let response = httpRequest(server.port, "POST", "/api/adopt",
      headers = [("Content-Type", "application/json")], body = "[1]")
    check response.status == 400
    check parseJson(response.body)["error"].getStr() == "invalid_request"
    check localAccessChallengeSecondsLeft() > 0

stopServer(server)
removeDir(dir)
