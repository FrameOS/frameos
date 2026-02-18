import std/json
import ../config

block test_load_config:
    let config = loadConfig()
    doAssert config.frameHost == "localhost"
    doAssert config.framePort == 8787
    doAssert config.serverHost == "localhost"
    doAssert config.serverPort == 8989
    doAssert config.serverApiKey == "test-api-key"
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
