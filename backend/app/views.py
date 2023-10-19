import base64
import gzip
import io
import zipfile
import requests
import json
import string

from flask import jsonify, request, send_from_directory, send_file, Response, redirect, url_for, render_template, flash
from flask_login import login_user, logout_user, login_required, current_user
from . import db, app, tasks, models, redis
from .models import User, get_settings_dict, Template
from .forms import LoginForm, RegisterForm
from PIL import Image


@app.before_request
def before_request():
    """
    Check if the incoming request is gzipped and decompress it if it is.
    """
    if request.headers.get('Content-Encoding') == 'gzip':
        compressed_data = io.BytesIO(request.get_data(cache=False))
        decompressed_data = gzip.GzipFile(fileobj=compressed_data, mode='rb').read()
        request._cached_data = decompressed_data
        request.get_json = lambda cache=False: json.loads(decompressed_data.decode('utf-8'))


@app.errorhandler(404)
def not_found(e):
    if User.query.first() is None:
        flash('Please register the first user!')
        return redirect(url_for('register'))
    if current_user.is_authenticated:
        return app.send_static_file('index.html')
    else:
        flash('Please login!')
        return redirect(url_for('login'))

@app.route("/", methods=["GET"])
@login_required
def index():
    return app.send_static_file('index.html')

@app.route("/api/apps", methods=["GET"])
@login_required
def apps():
    return jsonify(apps=models.get_app_configs())

@app.route("/api/apps/source/<string:keyword>", methods=["GET"])
@login_required
def builtin_app(keyword: str):
    return jsonify(models.get_one_app_sources(keyword))

@app.route("/api/settings", methods=["GET"])
@login_required
def settings():
    return jsonify(get_settings_dict())

@app.route("/api/settings", methods=["POST"])
@login_required
def set_settings():
    current_settings = get_settings_dict()

    payload = request.get_json()
    if not payload:
        return jsonify(error="No JSON payload received"), 400

    for key, value in payload.items():
        if value != current_settings.get(key, None):
            if key in current_settings:
                setting = models.Settings.query.filter_by(key=key).first()
                setting.value = value
            else:
                setting = models.Settings(key=key, value=value)
                db.session.add(setting)
    db.session.commit()

    return jsonify(get_settings_dict())

@app.route("/api/frames", methods=["GET"])
@login_required
def frames():
    frames = models.Frame.query.all()
    frames_list = [frame.to_dict() for frame in frames]
    return jsonify(frames=frames_list)

@app.route('/api/frames/<int:id>', methods=['GET'])
@login_required
def get_frame(id: int):
    frame = models.Frame.query.get_or_404(id)
    return jsonify(frame=frame.to_dict())

@app.route('/api/frames/<int:id>/logs', methods=['GET'])
@login_required
def get_logs(id: int):
    frame = models.Frame.query.get_or_404(id)
    logs = [log.to_dict() for log in frame.logs]
    logs = logs[-1000:]
    return jsonify(logs=logs)

@app.route('/api/frames/<int:id>/image', methods=['GET'])
@login_required
def get_image(id: int):
    frame = models.Frame.query.get_or_404(id)

    if request.args.get('t') == '-1':
        last_image = redis.get(f'frame:{id}:image')
        if last_image:
            return Response(last_image, content_type='image/png')

    response = requests.get(f'http://{frame.frame_host}:{frame.frame_port}/image')
    if response.status_code == 200:
        redis.set(f'frame:{id}:image', response.content, ex=86400 * 30)
        return Response(response.content, content_type='image/png')
    else:
        last_image = redis.get(f'frame:{id}:image')
        if last_image:
            return Response(last_image, content_type='image/png')
        return jsonify({"error": "Unable to fetch image"}), response.status_code

@app.route('/api/frames/<int:id>/refresh', methods=['POST'])
@login_required
def refresh_frame(id: int):
    frame = models.Frame.query.get_or_404(id)
    response = requests.get(f'http://{frame.frame_host}:{frame.frame_port}/refresh')
        
    if response.status_code == 200:
        return "OK", 200
    else:
        return jsonify({"error": "Unable to refresh frame"}), response.status_code

@app.route('/api/frames/<int:id>/reset', methods=['POST'])
@login_required
def reset_frame(id: int):
    tasks.reset_frame(id)
    return 'Success', 200

@app.route('/api/frames/<int:id>/restart', methods=['POST'])
@login_required
def restart_frame(id: int):
    tasks.restart_frame(id)
    return 'Success', 200

@app.route('/api/frames/<int:id>/initialize', methods=['POST'])
@login_required
def deploy_frame(id: int):
    tasks.deploy_frame(id)
    return 'Success', 200

@app.route('/api/frames/<int:id>', methods=['POST'])
@login_required
def update_frame(id: int):
    frame = models.Frame.query.get_or_404(id)
    # I have many years of engineering experience
    if 'scenes' in request.form:
        frame.scenes = json.loads(request.form['scenes'])
    if 'name' in request.form:
        frame.name = request.form['name']
    if 'frame_host' in request.form:
        frame.frame_host = request.form['frame_host']
    if 'frame_port' in request.form:
        frame.frame_port = int(request.form['frame_port'] or '8999')
    if 'ssh_user' in request.form:
        frame.ssh_user = request.form['ssh_user']
    if 'ssh_pass' in request.form:
        frame.ssh_pass = request.form['ssh_pass'] if request.form['ssh_pass'] != '' else None
    if 'ssh_port' in request.form:
        frame.ssh_port = int(request.form['ssh_port'] or '22')
    if 'server_host' in request.form:
        frame.server_host = request.form['server_host']
    if 'server_port' in request.form:
        frame.server_port = int(request.form['server_port'] or '8999')
    if 'server_api_key' in request.form:
        frame.server_api_key = request.form['server_api_key']
    if 'width' in request.form:
        frame.width = int(request.form['width']) if request.form['width'] != '' and request.form['width'] != 'null' else None
    if 'height' in request.form:
        frame.height = int(request.form['height']) if request.form['height'] != '' and request.form['height'] != 'null' else None
    if 'rotate' in request.form:
        frame.rotate = int(request.form['rotate']) if request.form['rotate'] != '' and request.form['rotate'] != 'null' else None
    if 'color' in request.form:
        frame.color = request.form['color'] if request.form['color'] != '' and request.form['color'] != 'null' else None
    if 'interval' in request.form:
        frame.interval = float(request.form['interval']) if request.form['interval'] != '' else None
    if 'scaling_mode' in request.form:
        frame.scaling_mode = request.form['scaling_mode']
    if 'background_color' in request.form:
        frame.background_color = request.form['background_color']
    if 'device' in request.form:
        frame.device = request.form['device']

    models.update_frame(frame)

    if request.form.get('next_action') == 'restart':
        tasks.restart_frame(frame.id)
    elif request.form.get('next_action') == 'redeploy':
        tasks.deploy_frame(frame.id)
    elif request.form.get('next_action') == 'refresh':
        refresh_frame(frame.id)

    return 'Success', 200

@app.route("/api/frames/new", methods=["POST"])
@login_required
def new_frame():
    name = request.form['name']
    frame_host = request.form['frame_host']
    server_host = request.form['server_host']
    device = request.form.get('device', 'web_only')
    frame = models.new_frame(name, frame_host, server_host, device)
    return jsonify(frame=frame.to_dict())

@app.route('/api/frames/<int:frame_id>', methods=['DELETE'])
@login_required
def delete_frame_route(frame_id):
    success = models.delete_frame(frame_id)
    if success:
        return jsonify({'message': 'Frame deleted successfully'}), 200
    else:
        return jsonify({'message': 'Frame not found'}), 404

@app.route('/images/<path:filename>')
@login_required
def custom_static(filename: str):
    return send_from_directory(app.static_folder + '/images', filename)

@app.route('/api/log', methods=["POST"])
def api_log():
    auth_header = request.headers.get('Authorization')
    server_api_key = auth_header.split(' ')[1]
    frame = models.Frame.query.filter_by(server_api_key=server_api_key).first_or_404()

    data = request.json
    if log := data.get('log', None):
        models.process_log(frame, log)
    
    if logs := data.get('logs', None):
        for log in logs:
            models.process_log(frame, log)

    return 'OK', 200

# Create (POST)
@app.route("/api/templates", methods=["POST"])
@login_required
def create_template():
    data = request.json
    new_template = Template(
        name=data.get('name'),
        description=data.get('description'),
        scenes=data.get('scenes'),
        config=data.get('config')
    )
    db.session.add(new_template)
    db.session.commit()

    if data.get('from_frame_id'):
        frame_id = data.get('from_frame_id')
        last_image = redis.get(f'frame:{frame_id}:image')
        if last_image:
            try:
                image = Image.open(io.BytesIO(last_image))
                new_template.image = last_image
                new_template.image_width = image.width
                new_template.image_height = image.height
                db.session.commit()
            except Exception as e:
                print(e)
                pass

    return jsonify(new_template.to_dict()), 201

# Read (GET) for all templates
@app.route("/api/templates", methods=["GET"])
@login_required
def get_templates():
    templates = [template.to_dict() for template in Template.query.all()]
    return jsonify(templates)

# Read (GET) for a specific template
@app.route("/api/templates/<template_id>", methods=["GET"])
@login_required
def get_template(template_id):
    template = Template.query.get(template_id)
    if not template:
        return jsonify({"error": "Template not found"}), 404
    return jsonify(template.to_dict())

# Read (GET) for a specific template
@app.route("/api/templates/<template_id>/image", methods=["GET"])
@login_required
def get_template_image(template_id):
    template = Template.query.get(template_id)
    if not template or not template.image:
        return jsonify({"error": "Template not found"}), 404
    return send_file(io.BytesIO(template.image), mimetype='image/jpeg')

# Export (GET) for a specific template
@app.route("/api/templates/<template_id>/export", methods=["GET"])
@login_required
def export_template(template_id):
    template = Template.query.get(template_id)
    if not template:
        return jsonify({"error": "Template not found"}), 404
    template_name = template.name
    safe_chars = "-_.() %s%s" % (string.ascii_letters, string.digits)
    template_name = ''.join(c for c in template_name if c in safe_chars) or 'Template'

    template_dict = template.to_dict()
    template_dict.pop('id')
    if request.args.get('format', None) == 'zip':
        in_memory = io.BytesIO()
        with zipfile.ZipFile(in_memory, 'a', zipfile.ZIP_DEFLATED) as zf:
            scenes = template_dict.pop('scenes')
            template_dict['scenes'] = './scenes.json'
            template_dict['image'] = './image.jpg'
            zf.writestr(f"{template_name}/scenes.json", json.dumps(scenes, indent=2))
            zf.writestr(f"{template_name}/template.json", json.dumps(template_dict, indent=2))
            zf.writestr(f"{template_name}/image.jpg", template.image)
        in_memory.seek(0)
        return Response(in_memory.getvalue(), content_type='application/zip', headers={"Content-Disposition": f"attachment; filename={template_name}.zip"})

    else: # json
        base64_image = base64.b64encode(template.image).decode('utf-8') if template.image else None
        template_dict['image'] = f"data:image/jpeg;base64,{base64_image}"
        return Response(json.dumps(template_dict, indent=2), content_type='application/json', headers={"Content-Disposition": f"attachment; filename={template_name}.json"})

# Update (PUT)
@app.route("/api/templates/<template_id>", methods=["PATCH"])
@login_required
def update_template(template_id):
    template = Template.query.get(template_id)
    if not template:
        return jsonify({"error": "Template not found"}), 404
    data = request.json
    if 'name' in data:
        template.name = data.get('name', template.name)
    if 'description' in data:
        template.description = data.get('description', template.description)
    db.session.commit()
    return jsonify(template.to_dict())

# Delete (DELETE)
@app.route("/api/templates/<template_id>", methods=["DELETE"])
@login_required
def delete_template(template_id):
    template = Template.query.get(template_id)
    if not template:
        return jsonify({"error": "Template not found"}), 404
    db.session.delete(template)
    db.session.commit()
    return jsonify({"message": "Template deleted successfully"}), 200

@app.route('/register', methods=['GET', 'POST'])
def register():
    if User.query.first() is not None:
        flash('Only one user is allowed. Please login!')
        return redirect(url_for('login'))
    form = RegisterForm()
    if form.validate_on_submit():
        user = User(username=form.username.data, email=form.email.data)
        user.set_password(form.password.data)
        db.session.add(user)
        db.session.commit()
        flash('Congratulations, you are now a registered user!')
        return redirect(url_for('login'))
    elif len(form.errors) > 0:
        flash(form.errors)
    return render_template('register.html', title='Register', form=form)

@app.route('/login', methods=['GET', 'POST'])
def login():
    if User.query.first() is None:
        flash('Please register the first user!')
        return redirect(url_for('register'))
    if current_user.is_authenticated:
        return redirect(url_for('index'))
    form = LoginForm()
    if form.validate_on_submit():
        user = User.query.filter_by(username=form.username.data).first()
        if user is None or not user.check_password(form.password.data):
            flash('Invalid username or password')
            return redirect(url_for('login'))
        login_user(user, remember=form.remember_me.data)
        return redirect(url_for('index'))
    return render_template('login.html', title='Sign In', form=form)

@app.route('/logout')
@login_required
def logout():
    logout_user()
    return redirect(url_for('index'))