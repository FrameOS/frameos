var socket = io.connect('http://0.0.0.0:8080')
socket.on('new_line', function (msg) {
  console.log(msg)
  var line = document.createElement('div')
  line.className = 'terminal-line ' + msg.type

  var timestamp = document.createElement('span')
  timestamp.className = 'terminal-timestamp'
  timestamp.textContent = msg.timestamp
  line.appendChild(timestamp)

  var text = document.createElement('span')
  text.className = 'terminal-text'
  text.textContent = msg.line
  line.appendChild(text)

  document.getElementById('log').appendChild(line)
  window.scrollTo(0, document.body.scrollHeight)
})
