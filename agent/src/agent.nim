import asyncdispatch, ws, json, strformat

proc main() {.async.} =
  var attempts = 0
  while true:
    try:
      let data = parseFile("./frame.json")
      let serverHost = data{"serverHost"}.getStr()
      let serverPort = data{"serverPort"}.getInt()
      let url = &"ws://{serverHost}:{serverPort}/ws"
      let welcomePayload = %*{
        "apiKey": data{"serverApiKey"}.getStr(),
        "frameHost": data{"frameHost"}.getStr(),
        "framePort": data{"framePort"}.getInt(),
      }
      echo &"Connecting to {url}"
      var ws = await newWebSocket(url)
      echo "Connected"
      attempts = 0
      await ws.send($welcomePayload)
      echo "Sent welcome message"
      while true:
        echo "Waiting for message..."
        echo await ws.receiveStrPacket()
      ws.close()
    except IOError as e:
      echo "Error connecting to server"
      echo e.msg
    except Exception as e:
      echo "Error"
      echo e.msg
    if attempts < 60:
      attempts += 1
    echo &"Retrying in {attempts} seconds"
    await sleepAsync(attempts * 1000)

waitFor main()
