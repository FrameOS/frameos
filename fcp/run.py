from fcp import app, socketio, db

if __name__ == '__main__':
    with app.app_context():
        db.create_all()

    # # Subscribe to the 'new_line' channel
    # p = redis.pubsub()
    # p.subscribe('new_line')

    # def listen_for_messages():
    #     for message in p.listen():
    #         if message['type'] == 'message':
    #             line = message['data'].decode('utf-8')
    #             print(f"received: {line}")
    #             with app.app_context():
    #                 socketio.emit('new_line', {'line': line})

    # print("1§")
    # Thread(target=listen_for_messages).start()
    # # socketio.start_background_task(listen_for_messages)
    # print("2§")

    socketio.run(app, host='0.0.0.0', port=8080, debug=True)
    # socketio.start_background_task(listen_for_messages)
