var socket = io.connect("http://0.0.0.0:8080");
socket.on("new_line", function (msg) {
  var li = document.createElement("li");
  li.textContent = msg.line;
  document.getElementById("log").appendChild(li);
});
