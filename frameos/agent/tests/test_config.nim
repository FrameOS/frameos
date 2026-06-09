import std/[json, os, times]
import ../src/frameos_agent

block test_agent_loads_main_frameos_frame_json_payload:
  let tempRoot = getTempDir() / ("frameos-agent-config-" & $epochTime().int64)
  let configPath = tempRoot / "frame.json"
  createDir(tempRoot)
  writeFile(configPath, pretty(%*{
    "frameosVersion": "0.1.0",
    "name": "Buildroot frame",
    "mode": "buildroot",
    "frameHost": "frame.local",
    "framePort": 8787,
    "frameAccessKey": "frame-access",
    "frameAccess": "private",
    "httpsProxy": {
      "enable": false,
      "port": 8443,
      "exposeOnlyPort": true,
      "serverCert": "",
      "serverKey": ""
    },
    "serverHost": "backend.frameos.local",
    "serverPort": 443,
    "serverApiKey": "server-api-key",
    "serverSendLogs": true,
    "width": 800,
    "height": 480,
    "device": "web_only",
    "deviceConfig": {},
    "metricsInterval": 60.0,
    "maxHttpResponseBytes": 33554432,
    "debug": true,
    "scalingMode": "contain",
    "imageEngine": "",
    "rotate": 90,
    "flip": "horizontal",
    "logToFile": nil,
    "assetsPath": "/srv/assets",
    "saveAssets": true,
    "schedule": {"events": []},
    "gpioButtons": [],
    "palette": {},
    "controlCode": {"enabled": false},
    "network": {
      "networkCheck": true,
      "networkCheckTimeoutSeconds": 30,
      "networkCheckUrl": "https://networkcheck.frameos.net/",
      "wifiHotspot": "bootOnly",
      "wifiHotspotSsid": "FrameOS-Setup",
      "wifiHotspotPassword": "frame1234",
      "wifiHotspotTimeoutSeconds": 300
    },
    "agent": {
      "agentEnabled": true,
      "agentRunCommands": true,
      "agentSharedSecret": "agent-secret"
    },
    "mountpoints": {"enabled": false, "items": []},
    "errorBehavior": {
      "mode": "show_error_retry",
      "retrySeconds": 60,
      "silentRetrySeconds": 60,
      "silentRetryForever": false,
      "silentWindowMinutes": 10,
      "showErrorRetrySeconds": 60
    },
    "timeZoneUpdates": {
      "enabled": true,
      "hour": 3,
      "url": "https://tz.frameos.net/tzdata.json.gz"
    },
    "timeZone": "Europe/Brussels",
    "scenes": [{"id": "scene-1"}]
  }, indent = 4) & "\n")

  putEnv("FRAMEOS_CONFIG", configPath)
  try:
    let config = loadConfig()

    doAssert config.name == "Buildroot frame"
    doAssert config.serverHost == "backend.frameos.local"
    doAssert config.serverPort == 443
    doAssert config.serverApiKey == "server-api-key"
    doAssert config.frameHost == "frame.local"
    doAssert config.framePort == 8787
    doAssert config.frameAccessKey == "frame-access"
    doAssert config.frameAccess == "private"
    doAssert config.width == 800
    doAssert config.height == 480
    doAssert config.metricsInterval == 60.0
    doAssert config.rotate == 90
    doAssert config.flip == "horizontal"
    doAssert config.scalingMode == "contain"
    doAssert config.assetsPath == "/srv/assets"
    doAssert config.debug
    doAssert config.timeZone == "Europe/Brussels"
    doAssert config.network.networkCheck
    doAssert config.network.wifiHotspot == "bootOnly"
    doAssert config.agent.agentEnabled
    doAssert config.agent.agentRunCommands
    doAssert config.agent.agentSharedSecret == "agent-secret"
  finally:
    delEnv("FRAMEOS_CONFIG")
    if dirExists(tempRoot):
      removeDir(tempRoot)
