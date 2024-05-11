import json, zippy, strutils, jester, os
import ../logger
import ../config


block test_memory_usage:
    let port = 16667.Port
    var requests = 0
    var received = 0
    var thread: Thread[void]
    proc createThreadRunner() {.thread.} =
        router myrouter:
            post "/api/log":
                echo "log!"
                # echo uncompress(request.body)
                let response = parseJson(if request.body == "": "{\"logs\":[]}" else: uncompress(request.body))
                received += response{"logs"}.len
                requests += 1
                echo "received: ", received, ", requests: ", requests
                resp Http200, "OK"
        var jester = initJester(myrouter, newSettings(port = port))
        jester.serve() # blocks forever
    createThread(thread, createThreadRunner)

    let testConfig = loadConfig("./frame.json")
    testConfig.serverPort = port.int
    testConfig.serverHost = "0.0.0.0"
    testConfig.debug = false
    let logger = newLogger(testConfig)
    doAssert logger.enabled == true
    echo testConfig.serverPort

    let memory1 = system.getOccupiedMem()
    echo memory1

    for i in 0..10:
        logger.log(%*{"msg": repeat("0123456789", 100)}) # 1kb message

    sleep(500)

    # We only sent the first message
    doAssert requests == 1
    doAssert received == 1

    # We should have 10 logs in the queue
    let memory2 = system.getOccupiedMem()
    echo memory2
    doAssert memory2 > memory1 + 1000 * 10

    sleep(1000)

    # We should have sent another 11 messages
    doAssert requests == 2
    doAssert received == 11

    let memory3 = system.getOccupiedMem()
    echo memory3

    doAssert memory3 < memory2

    # for i in 0..1000:
    #     logger.log(%*{"msg": repeat("0123456789", 100)}) # 1kb message

    # sleep(1000)
    # let memory3 = system.getOccupiedMem()
    # echo memory3

    # echo received

    # doAssert memory2 > memory1 + 1000 * 10

