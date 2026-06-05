import std/[json, os, times]
import ../config
import ../utils/image

proc withConfig(content: string, body: proc()) =
    let tempPath = getTempDir() / ("frameos-test-config-" & $(epochTime().int64) & ".json")
    let hadEnv = existsEnv("FRAMEOS_CONFIG")
    let previous = if hadEnv: getEnv("FRAMEOS_CONFIG") else: ""

    writeFile(tempPath, content)
    putEnv("FRAMEOS_CONFIG", tempPath)

    try:
        body()
    finally:
        if fileExists(tempPath):
            removeFile(tempPath)
        if hadEnv:
            putEnv("FRAMEOS_CONFIG", previous)
        else:
            delEnv("FRAMEOS_CONFIG")

block test_load_config:
    withConfig($(%*{
        "framePort": 8787,
        "frameHost": "localhost",
        "bindHost": "127.0.0.1",
        "httpsProxy": {
            "enable": false,
            "port": 8443,
            "exposeOnlyPort": false
        },
        "serverHost": "localhost",
        "serverPort": 8989,
        "serverApiKey": "test-api-key",
        "width": 800,
        "height": 480,
        "metricsInterval": 60.0,
        "maxHttpResponseBytes": 33554432,
        "rotate": 0,
        "debug": true,
        "scalingMode": "cover",
        "imageEngine": "imagemagick",
        "timeZone": "UTC",
        "settings": {},
        "schedule": {},
        "agent": {
            "agentEnabled": true,
            "agentRunCommands": true,
            "agentSharedSecret": "agent-secret"
        },
        "errorBehavior": {
            "mode": "silent_retry",
            "retrySeconds": 45,
            "silentRetrySeconds": 15,
            "silentRetryForever": false,
            "silentWindowMinutes": 4,
            "showErrorRetrySeconds": 90
        },
        "mountpoints": {
            "enabled": true,
            "items": [
                {
                    "enabled": true,
                    "source": "//nas/photos",
                    "target": "/mnt/photos",
                    "username": "frame",
                    "password": "secret",
                    "domain": "workgroup",
                    "options": "vers=3.0"
                }
            ]
        }
    })) do ():
        let config = loadConfig()
        doAssert config.frameHost == "localhost"
        doAssert config.framePort == 8787
        doAssert config.bindHost == "127.0.0.1"
        doAssert config.serverHost == "localhost"
        doAssert config.serverPort == 8989
        doAssert config.serverApiKey == "test-api-key"
        doAssert config.serverSendLogs == true
        doAssert config.width == 800
        doAssert config.height == 480
        doAssert config.httpsProxy.enable == false
        doAssert config.httpsProxy.port == 8443
        doAssert config.httpsProxy.exposeOnlyPort == false
        doAssert config.metrics_interval == 60 # 60.0 in frame.json
        doAssert config.maxHttpResponseBytes == 33554432
        doAssert config.rotate == 0
        doAssert config.flip == ""
        doAssert config.debug == true
        doAssert config.scalingMode == "cover"
        doAssert config.imageEngine == "imagemagick"
        doAssert getRuntimeImageEngine() == "imagemagick"
        doAssert config.settings == %*{}
        doAssert config.settings{"nothere"}{"neitherme"}{"orme"} == nil
        doAssert config.settings{"nothere"}{"neitherme"}{"orme"}.getStr() == ""
        doAssert config.settings{"nothere"}{"neitherme"}{"orme"}.isNil() == true
        doAssert config.agent.agentEnabled == true
        doAssert config.agent.agentRunCommands == true
        doAssert config.agent.agentSharedSecret == "agent-secret"
        doAssert config.errorBehavior.mode == "silent_retry"
        doAssert config.errorBehavior.retrySeconds == 45
        doAssert config.errorBehavior.silentRetrySeconds == 15
        doAssert config.errorBehavior.silentRetryForever == false
        doAssert config.errorBehavior.silentWindowMinutes == 4
        doAssert config.errorBehavior.showErrorRetrySeconds == 90
        doAssert config.mountpoints.enabled == true
        doAssert config.mountpoints.items.len == 1
        doAssert config.mountpoints.items[0].source == "//nas/photos"
        doAssert config.mountpoints.items[0].target == "/mnt/photos"
        doAssert config.mountpoints.items[0].username == "frame"

block test_error_behavior_defaults:
    let config = loadErrorBehavior(%*{
        "mode": "not-a-mode",
        "retrySeconds": 0,
        "silentRetrySeconds": -1,
        "silentWindowMinutes": 0,
        "showErrorRetrySeconds": -5
    })

    doAssert config.mode == "show_error_retry"
    doAssert config.retrySeconds == 60
    doAssert config.silentRetrySeconds == 60
    doAssert config.silentRetryForever == false
    doAssert config.silentWindowMinutes == 10
    doAssert config.showErrorRetrySeconds == 60

block test_error_behavior_legacy_silent_retry_minutes:
    let config = loadErrorBehavior(%*{
        "mode": "silent_retry",
        "silentRetryMinutes": 7
    })

    doAssert config.mode == "silent_retry"
    doAssert config.silentWindowMinutes == 7
