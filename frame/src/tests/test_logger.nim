from ../logger import Logger, newLogger, log
from ../config import loadConfig

let testConfig = loadConfig("./src/tests/assets/frame.json")

block test_basic_things:
    let logger = newLogger(testConfig)
    # doAssert logger.config == testConfig
