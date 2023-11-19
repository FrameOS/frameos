from flask import jsonify, request
from flask_login import login_required
from app import db
from . import api
from app.models.settings import Settings
from app.models.repository import Repository

FRAMEOS_REPOSITORY_URL = "https://repo.frameos.net/versions/0/templates.json"

# Create (POST)
@api.route("/repositories", methods=["POST"])
@login_required
def create_repository():
    data = request.json
    new_repository = Repository(
        name=data.get('name'),
        url=data.get('url'),
    )
    new_repository.update_templates()
    db.session.add(new_repository)
    db.session.commit()
    return jsonify(new_repository.to_dict()), 201

# Read (GET) for all templates
@api.route("/repositories", methods=["GET"])
@login_required
def get_repositories():
    try:
        setting = Settings.query.filter_by(key="@system/repository_init_done").first()
        if not setting:
            repository = Repository(name="FrameOS Official Templates", url=FRAMEOS_REPOSITORY_URL)
            repository.update_templates()
            db.session.add(repository)
            setting = Settings(key="@system/repository_init_done", value="true")
            db.session.add(setting)
            db.session.commit()
    except Exception as e:
        print(e)

    repositories = [repository.to_dict() for repository in Repository.query.all()]
    return jsonify(repositories)

# Read (GET) for a specific repository
@api.route("/repositories/<repository_id>", methods=["GET"])
@login_required
def get_repository(repository_id):
    repository = Repository.query.get(repository_id)
    if not repository:
        return jsonify({"error": "Repository not found"}), 404
    return jsonify(repository.to_dict())

# Update (PUT)
@api.route("/repositories/<repository_id>", methods=["PATCH"])
@login_required
def update_repository(repository_id):
    repository = Repository.query.get(repository_id)
    if not repository:
        return jsonify({"error": "Repository not found"}), 404
    data = request.json
    if 'name' in data:
        repository.name = data.get('name', repository.name)
    if 'url' in data:
        repository.url = data.get('url', repository.url)
    repository.update_templates()
    db.session.add(repository)
    db.session.commit()
    return jsonify(repository.to_dict())

# Delete (DELETE)
@api.route("/repositories/<repository_id>", methods=["DELETE"])
@login_required
def delete_repository(repository_id):
    repository = Repository.query.get(repository_id)
    if not repository:
        return jsonify({"error": "Repository not found"}), 404
    db.session.delete(repository)
    db.session.commit()
    return jsonify({"message": "Repository deleted successfully"}), 200

