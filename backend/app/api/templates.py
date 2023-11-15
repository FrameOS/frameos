import base64
import io
import zipfile
import requests
import json
import string

from flask import jsonify, request, send_file, Response
from flask_login import login_required
from app import db, app, redis
from app.models.template import Template
from PIL import Image

# Create (POST)
@app.route("/api/templates", methods=["POST"])
@login_required
def create_template():
    if 'file' in request.files:
        zip_file = request.files['file'].read()
    elif 'url' in request.form:
        zip_file = requests.get(request.form['url']).content
    else:
        data = request.json
        zip_file = None
        if data.get('url'):
            zip_file = requests.get(data.get('url')).content

    if zip_file:
        zip_file = zipfile.ZipFile(io.BytesIO(zip_file))
        folder_name = ''
        for name in zip_file.namelist():
            print(name)
            if name == 'template.json':
                folder_name = ''
                break
            elif name.endswith('/template.json'):
                if folder_name == '' or len(name) < len(folder_name):
                    folder_name = name[:-len('template.json')]

        template_json = zip_file.read(f'{folder_name}template.json')
        scenes_json = zip_file.read(f'{folder_name}scenes.json')

        data = json.loads(template_json)
        data['scenes'] = json.loads(scenes_json)

        image = data.get('image', '')
        if image.startswith('data:image/'):
            image = image[len('data:image/'):].split(';base64,')[1]
            image = base64.b64decode(image)
        elif image.startswith('./'):
            image = image[len('./'):]
            image = zip_file.read(f'{folder_name}{image}')
        elif image.startswith('http:') or image.startswith('https:'):
            image = requests.get(image).content
        else:
            image = None
        data['image'] = image
        if image:
            img = Image.open(io.BytesIO(image))
            data['image_width'] = img.width
            data['image_height'] = img.height

    if data.get('from_frame_id'):
        frame_id = data.get('from_frame_id')
        last_image = redis.get(f'frame:{frame_id}:image')
        if last_image:
            try:
                image = Image.open(io.BytesIO(last_image))
                data['image'] = last_image
                data['image_width'] = image.width
                data['image_height'] = image.height
            except Exception as e:
                print(e)
                pass

    new_template = Template(
        name=data.get('name'),
        description=data.get('description'),
        scenes=data.get('scenes'),
        config=data.get('config'),
        image=data.get('image'),
        image_width=data.get('image_width'),
        image_height=data.get('image_height'),
    )
    db.session.add(new_template)
    db.session.commit()


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
    template_name = ''.join(c if c in safe_chars else ' ' for c in template_name).strip()
    template_name = ' '.join(template_name.split()) or 'Template'

    template_dict = template.to_dict()
    template_dict.pop('id')
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
