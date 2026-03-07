import std/[json, os, times]
import ../config

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
        "rotate": 0,
        "debug": true,
        "scalingMode": "cover",
        "timeZone": "UTC",
        "settings": {},
        "schedule": {}
    })) do ():
        let config = loadConfig()
        doAssert config.frameHost == "localhost"
        doAssert config.framePort == 8787
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
        doAssert config.rotate == 0
        doAssert config.flip == ""
        doAssert config.debug == true
        doAssert config.scalingMode == "cover"
        doAssert config.settings == %*{}
        doAssert config.settings{"nothere"}{"neitherme"}{"orme"} == nil
        doAssert config.settings{"nothere"}{"neitherme"}{"orme"}.getStr() == ""
        doAssert config.settings{"nothere"}{"neitherme"}{"orme"}.isNil() == true
