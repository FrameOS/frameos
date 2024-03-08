import logging
from flask import jsonify, request
from flask_login import login_required
from sqlalchemy.exc import SQLAlchemyError
from app import db
from . import api
from app.models.settings import Settings
from app.models.repository import Repository

FRAMEOS_REPOSITORY_URL = "https://repo.frameos.net/samples/repository.json"

@api.route("/repositories", methods=["POST"])
@login_required
def create_repository():
    data = request.json or {}
    url = data.get('url')

    if not url:
        return jsonify({'error': 'Missing URL'}), 400

    try:
        new_repository = Repository(name="", url=url)
        new_repository.update_templates()
        db.session.add(new_repository)
        db.session.commit()
        return jsonify(new_repository.to_dict()), 201
    except SQLAlchemyError as e:
        logging.error(f'Database error: {e}')
        return jsonify({'error': 'Database error'}), 500

@api.route("/repositories", methods=["GET"])
@login_required
def get_repositories():
    try:
        # We have created an old repo URL. Remove it.
        if Settings.query.filter_by(key="@system/repository_init_done").first():
            old_url = "https://repo.frameos.net/versions/0/templates.json"
            repository = Repository.query.filter_by(url=old_url).first()
            if repository:
                db.session.delete(repository)
            db.session.delete(Settings.query.filter_by(key="@system/repository_init_done").first())
            db.session.commit()

        # We have not created a new repo URL
        if not Settings.query.filter_by(key="@system/repository_samples_done").first():
            repository = Repository( url=FRAMEOS_REPOSITORY_URL)
            repository.update_templates()
            db.session.add(repository)
            db.session.add(Settings(key="@system/repository_samples_done", value="true"))
            db.session.commit()

        repositories = [repo.to_dict() for repo in Repository.query.all()]
        return jsonify(repositories)
    except SQLAlchemyError as e:
        logging.error(f'Database error: {e}')
        return jsonify({'error': 'Database error'}), 500

@api.route("/repositories/<repository_id>", methods=["GET"])
@login_required
def get_repository(repository_id):
    try:
        repository = Repository.query.get(repository_id)
        if not repository:
            return jsonify({"error": "Repository not found"}), 404
        return jsonify(repository.to_dict())
    except SQLAlchemyError as e:
        logging.error(f'Database error: {e}')
        return jsonify({'error': 'Database error'}), 500

@api.route("/repositories/<repository_id>", methods=["PATCH"])
@login_required
def update_repository(repository_id):
    data = request.json or {}
    try:
        repository = Repository.query.get(repository_id)
        if not repository:
            return jsonify({"error": "Repository not found"}), 404

        if data.get('name'):
            repository.name = data.get('name', repository.name)
        if data.get('url'):
            repository.url = data.get('url', repository.url)
        repository.update_templates()
        db.session.commit()
        return jsonify(repository.to_dict())
    except SQLAlchemyError as e:
        logging.error(f'Database error: {e}')
        return jsonify({'error': 'Database error'}), 500

@api.route("/repositories/<repository_id>", methods=["DELETE"])
@login_required
def delete_repository(repository_id):
    try:
        repository = Repository.query.get(repository_id)
        if not repository:
            return jsonify({"error": "Repository not found"}), 404
        db.session.delete(repository)
        db.session.commit()
        return jsonify({"message": "Repository deleted successfully"}), 200
    except SQLAlchemyError as e:
        logging.error(f'Database error: {e}')
        return jsonify({'error': 'Database error'}), 500
