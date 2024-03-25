import ../logger
import ../config

let testConfig = loadConfig("./frame.json")

block test_basic_things:
    let logger = newLogger(testConfig)
    doAssert logger.enabled == true
