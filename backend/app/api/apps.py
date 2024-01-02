import ast
import re
import shutil

import requests
import json
import tempfile
import os
import subprocess

from flask import jsonify, request
from flask_login import login_required

from . import api
from app.models.apps import get_app_configs, get_one_app_sources
from app.models.settings import get_settings_dict

@api.route("/apps", methods=["GET"])
@login_required
def api_apps():
    return jsonify(apps=get_app_configs())

@api.route("/apps/source/<string:keyword>", methods=["GET"])
@login_required
def api_apps_source(keyword: str):
    return jsonify(get_one_app_sources(keyword))


@api.route("/apps/validate_source", methods=["POST"])
@login_required
def validate_python_frame_source():
    data = request.json
    file = data.get('file')
    source = data.get('source')

    if file.endswith('.py'):
        errors = validate_python(source)
    elif file.endswith('.nim'):
        errors = validate_nim(source)
    elif file.endswith('.json'):
        errors = validate_json(source)
    else:
        return jsonify({"errors": [
            {"line": 1, "column": 1, "error": f"Don't know how to validate files of this extension: {file}"}]}), 400

    if errors:
        return jsonify({"errors": errors}), 200
    else:
        return jsonify({"errors": []}), 200


@api.route("/apps/enhance_source", methods=["POST"])
@login_required
def enhance_python_frame_source():
    data = request.json
    source = data.get('source')
    prompt = data.get('prompt')
    api_key = get_settings_dict().get('openai', {}).get('api_key', None)

    if api_key is None:
        return jsonify({"error": "OpenAI API key not set"}), 400

    ai_context = f"""
    You are helping a python developer write ea FrameOS application. You are editing app.nim, the main file in FrameOS.
    This controls an e-ink display and runs on a Raspberry Pi. Help the user with their changes. Be mindful of what
    you do and do not know.

    This is the current source of app.nim:
    ```nim
    {source}
    ```
    """

    payload = {
        "messages": [
            {
                "role": "system",
                "content": ai_context
            },
            {
                "role": "user",
                "content": prompt
            }
        ],
        "model": "gpt-4",
    }

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    response = requests.post("https://api.openai.com/v1/chat/completions", json=payload, headers=headers)
    result = response.json()
    error = result.get('error', None)
    suggestion = result['choices'][0]['message']['content'] if 'choices' in result else None
    if error:
        return jsonify({"error": error}), 500
    else:
        return jsonify({"suggestion": suggestion}), 200


def validate_python(source):
    try:
        ast.parse(source)
        return []
    except SyntaxError as e:
        return [{"line": e.lineno, "column": e.offset, "error": str(e)}]


def validate_nim(source):
    try:
        with tempfile.TemporaryDirectory() as temp_dir:
            # copy src/frameos/types.nim to temp_dir
            target_path = os.path.join(temp_dir, "frameos")
            os.makedirs(target_path, exist_ok=True)
            shutil.copytree("../frameos/src/frameos", target_path, dirs_exist_ok=True)

            temp_file = tempfile.NamedTemporaryFile(mode='w', suffix='.nim', dir=temp_dir, delete=False)
            temp_file_name = temp_file.name
            temp_file_abs_name = os.path.realpath(temp_file_name)
            temp_file.write(source)
            temp_file.close()

            result = subprocess.run(['nim', 'check', temp_file_name], capture_output=True, text=True)

            errors = []
            for line in result.stderr.split('\n'):
                if line.startswith(temp_file_name) or line.startswith(temp_file_abs_name):
                    # "tmps4sk1v2t.nim(22, 12) Error: expression 'scene' has no type (or is ambiguous)"
                    if line.startswith(temp_file_name):
                        line = line[len(temp_file_name):]
                    elif line.startswith(temp_file_abs_name):
                        line = line[len(temp_file_abs_name):]

                    if "Error:" in line:
                        match = re.search(r'\((\d+), (\d+)\) (Error: .+)', line)
                        if match:
                            line_no, column, error = int(match.group(1)), int(match.group(2)), match.group(3)
                            errors.append({"line": line_no, "column": column, "error": error})
            return errors

    except Exception as e:
        return [{"error": str(e)}]
    
def validate_json(source):
    try:
        json.loads(source)
        return []
    except json.JSONDecodeError as e:
        return [{"line": e.lineno, "column": e.colno, "error": str(e)}]
