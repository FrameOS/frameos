from app import sock

@sock.route('/echo')
def echo(ws):
    while True:
        data = ws.receive()
        ws.send(data)
