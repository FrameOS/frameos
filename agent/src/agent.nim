import asyncdispatch, ws, json, strformat

proc main() {.async.} =
  var attmepts = 0
  while true:
    try:
      let data = parseFile("./frame.json")
      let serverHost = data{"serverHost"}.getStr()
      let serverPort = data{"serverPort"}.getInt()
      let url = &"ws://{serverHost}:{serverPort}/ws"

      echo &"Connecting to {url}"
      var ws = await newWebSocket(url)
      echo "Connected"

      while true:
        echo await ws.receiveStrPacket()
      ws.close()
    except IOError as e:
      echo "Error connecting to server"
      echo e.msg
    except Exception as e:
      echo "Error"
      echo e.msg
    attmepts += 1
    echo &"Retrying in {attmepts} seconds"
    await sleepAsync(attmepts * 1000)

waitFor main()
