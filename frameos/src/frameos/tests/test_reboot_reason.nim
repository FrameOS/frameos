import std/[json, unittest]

import ../reboot_reason

suite "reboot reason":
  test "parses systemd service exit metadata":
    let payload = parseLastServiceExit("""
serviceResult=oom-kill
exitCode=killed
exitStatus=KILL
""")

    check payload["serviceResult"].getStr() == "oom-kill"
    check payload["exitCode"].getStr() == "killed"
    check payload["exitStatus"].getStr() == "KILL"
    check payload["kind"].getStr() == "oom"
    check payload["source"].getStr() == "systemd"
    check payload["new"].getBool() == true

  test "classifies clean service stop as initiated":
    check serviceResultKind("success") == "initiated"

  test "classifies unexpected service result as error":
    check serviceResultKind("exit-code") == "error"
