import std/[json, os, strutils, unittest]

import ../config_update

proc tempDir(name: string): string =
  result = getTempDir() / "frameos_test_config_update" / name
  removeDir(result)
  createDir(result)

suite "config_update":
  test "applyFrameConfigUpdate maps whitelisted snake_case fields to camelCase":
    let current = %*{
      "name": "Old name",
      "rotate": 0,
      "frameAccess": "private",
      "serverHost": "old.example.com",
    }
    let payload = %*{
      "name": "New name",
      "rotate": 90,
      "scaling_mode": "cover",
      "metrics_interval": 120,
      "server_host": "backend.example.com",
      "debug": true,
      "mode": "buildroot",          # not whitelisted: needs a rebuild
      "ssh_user": "root",           # not whitelisted: backend-only
      "scenes": [%*{"id": "x"}],    # not whitelisted: deployed separately
    }
    let update = applyFrameConfigUpdate(current, payload)
    check update.config["name"].getStr() == "New name"
    check update.config["rotate"].getInt() == 90
    check update.config["scalingMode"].getStr() == "cover"
    check update.config["metricsInterval"].getFloat() == 120.0
    check update.config["serverHost"].getStr() == "backend.example.com"
    check update.config["debug"].getBool() == true
    check not update.config.hasKey("ssh_user")
    check not update.config.hasKey("sshUser")
    check not update.config.hasKey("scenes")
    check "name" in update.changedKeys
    check "rotate" in update.changedKeys
    check not update.adminAuthChanged

  test "applyFrameConfigUpdate reports unchanged config as no changes":
    let current = %*{"name": "Same", "rotate": 90}
    let update = applyFrameConfigUpdate(current, %*{"name": "Same", "rotate": 90})
    check update.changedKeys.len == 0

  test "frame admin auth changes are flagged and only store set fields":
    let current = %*{"frameAdminAuth": {"enabled": false}}
    let update = applyFrameConfigUpdate(current, %*{
      "frame_admin_auth": {"enabled": true, "user": "admin", "pass": "secret", }
    })
    check update.adminAuthChanged
    check update.config["frameAdminAuth"]["enabled"].getBool()
    check update.config["frameAdminAuth"]["user"].getStr() == "admin"

    let noChange = applyFrameConfigUpdate(update.config, %*{
      "frame_admin_auth": {"enabled": true, "user": "admin", "pass": "secret"}
    })
    check not noChange.adminAuthChanged
    check noChange.changedKeys.len == 0

  test "control code strings convert to frame.json types":
    let update = applyFrameConfigUpdate(%*{}, %*{
      "control_code": {"enabled": "true", "position": "top-left", "size": "3", "padding": "2"}
    })
    check update.config["controlCode"]["enabled"].getBool()
    check update.config["controlCode"]["size"].getFloat() == 3.0
    check update.config["controlCode"]["padding"].getInt() == 2

  test "writeFrameConfig backs up the old config into the same folder":
    let dir = tempDir("backup")
    let configPath = dir / "frame.json"
    writeFile(configPath, $(%*{"name": "first", "device": "web_only"}) & "\n")

    var update = applyFrameConfigUpdate(parseJson(readFile(configPath)), %*{"name": "second"})
    let backupPath = writeFrameConfig(configPath, update.config)

    check backupPath.len > 0
    check fileExists(backupPath)
    check backupPath.startsWith(configPath & ".bak.")
    check parseJson(readFile(backupPath))["name"].getStr() == "first"

    let written = parseJson(readFile(configPath))
    check written["name"].getStr() == "second"
    check written.hasKey("configUpdatedAt")

  test "writeFrameConfig prunes old backups":
    let dir = tempDir("prune")
    let configPath = dir / "frame.json"
    writeFile(configPath, $(%*{"name": "v0", "device": "web_only"}) & "\n")
    for i in 1 .. maxConfigBackups + 4:
      var update = applyFrameConfigUpdate(parseJson(readFile(configPath)), %*{"name": "v" & $i})
      discard writeFrameConfig(configPath, update.config)
    check configBackupPaths(configPath).len <= maxConfigBackups

  test "filterInterpretedScenes keeps only interpreted-execution scenes":
    let scenes = %*[
      {"id": "a", "settings": {"execution": "interpreted"}},
      {"id": "b", "settings": {"execution": "compiled"}},
      {"id": "c"}, # no settings: defaults to compiled
    ]
    let filtered = filterInterpretedScenes(scenes)
    check filtered.len == 1
    check filtered[0]["id"].getStr() == "a"

  test "applyScenesUpdate writes all_scenes and the interpreted subset":
    let dir = tempDir("scenes")
    let allPath = dir / "all_scenes.json.gz"
    let interpretedPath = dir / "scenes.json"
    putEnv("FRAMEOS_ALL_SCENES_JSON", allPath)
    putEnv("FRAMEOS_SCENES_JSON", interpretedPath)
    defer:
      delEnv("FRAMEOS_ALL_SCENES_JSON")
      delEnv("FRAMEOS_SCENES_JSON")

    let scenes = %*[
      {"id": "a", "settings": {"execution": "interpreted"}},
      {"id": "b", "settings": {"execution": "compiled"}},
    ]
    check applyScenesUpdate(scenes)
    check readScenesArray(allPath) == scenes
    let interpreted = readScenesArray(interpretedPath)
    check interpreted.len == 1
    check interpreted[0]["id"].getStr() == "a"

    # Saving the identical payload is a no-op.
    check not applyScenesUpdate(scenes)

    # A changed payload is written and the old all_scenes file is backed up.
    let changed = %*[{"id": "a", "settings": {"execution": "interpreted"}, "name": "renamed"}]
    check applyScenesUpdate(changed)
    check readScenesArray(allPath) == changed
    check configBackupPaths(allPath).len >= 1

  test "applyScenesUpdate rejects non-array payloads":
    expect ValueError:
      discard applyScenesUpdate(%*{"not": "an array"})

  test "invalid new config is rejected and the old file stays":
    let dir = tempDir("invalid")
    let configPath = dir / "frame.json"
    writeFile(configPath, $(%*{"name": "keep", "device": "web_only"}) & "\n")
    # A config that loadConfig cannot parse: schedule must be an object.
    var broken = parseJson(readFile(configPath))
    expect CatchableError:
      discard writeFrameConfig(configPath & ".missing-dir" / "frame.json", broken)
    check parseJson(readFile(configPath))["name"].getStr() == "keep"
