import std/json
from ../config import FrameConfig, loadConfig

block test_load_config:
    let config = loadConfig("./frame.json")
    doAssert config.frameHost == "localhost"
    doAssert config.framePort == 8787
    doAssert config.serverHost == "127.0.0.1"
    doAssert config.serverPort == 8989
    doAssert config.serverApiKey == "test-api-key"
    doAssert config.width == 800
    doAssert config.height == 480
    doAssert config.device == "web_only"
    doAssert config.color == "black" # null in frame.json
    doAssert config.metrics_interval == 60 # 60.0 in frame.json
    doAssert config.rotate == 0
    doAssert config.debug == false
    doAssert config.scalingMode == "cover"
    doAssert config.settings == %*{"sentry": {"frame_dsn": nil}}
    doAssert config.settings{"sentry"} == %*{"frame_dsn": nil}
    doAssert config.settings{"sentry"}{"not_found"} == nil
    doAssert config.settings{"sentry"}{"frame_dsn"} != nil
    doAssert config.settings{"sentry"}{"frame_dsn"}.kind == JNull
    doAssert config.settings{"sentry"}{"frame_dsn"}.getStr() == ""
    doAssert config.settings{"nothere"}{"neitherme"}{"orme"} == nil
    doAssert config.settings{"nothere"}{"neitherme"}{"orme"}.getStr() == ""
    doAssert config.settings{"nothere"}{"neitherme"}{"orme"}.isNil() == true
