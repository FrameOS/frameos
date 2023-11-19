from app import app, socketio, db, migrate

if __name__ == '__main__':
    with app.app_context():
        db.create_all()

    socketio.run(app, host='0.0.0.0', port=8999, allow_unsafe_werkzeug=True, debug=True)



# from gevent import monkey
# monkey.patch_all()
#
# from app import socketio, db, create_app
# import os
# from config import configs
#
# if __name__ == '__main__':
#     config_name = os.getenv('FLASK_CONFIG') or 'default'
#     config_class = configs.get(config_name)
#     app = create_app(config_class)
#     print("Starting server")
#     # app.run(host='0.0.0.0', port=8999)
#     socketio.run(app, host='0.0.0.0', port=8999, allow_unsafe_werkzeug=True, debug=True)
#
# #    socketio.run(app, host='0.0.0.0', port=8999, allow_unsafe_werkzeug=True, debug=False)
# #     socketio.run(app, host='0.0.0.0', port=8999)
#     # socketio.run(app)
#
#     print("Server started")
