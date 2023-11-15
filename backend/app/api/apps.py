import ast
import requests
import json

from flask import jsonify, request
from flask_login import login_required

from app import app
from app.models.apps import get_app_configs, get_one_app_sources
from app.models.settings import get_settings_dict

@app.route("/api/apps", methods=["GET"])
@login_required
def api_apps():
    return jsonify(apps=get_app_configs())

@app.route("/api/apps/source/<string:keyword>", methods=["GET"])
@login_required
def api_apps_source(keyword: str):
    return jsonify(get_one_app_sources(keyword))


@app.route("/api/validate_source", methods=["POST"])
@login_required
def validate_python_frame_source():
    data = request.json
    file = data.get('file')
    source = data.get('source')

    if file.endswith('.py'):
        errors = validate_python(source)
    elif file.endswith('.json'):
        errors = validate_json(source)
    else:
        return jsonify({"errors": [
            {"line": 1, "column": 1, "error": f"Don't know how to validate files of this extension: {file}"}]}), 400

    if errors:
        return jsonify({"errors": errors}), 200
    else:
        return jsonify({"errors": []}), 200


@app.route("/api/enhance_source", methods=["POST"])
@login_required
def enhance_python_frame_source():
    data = request.json
    print('______________')
    print(data)
    source = data.get('source')
    prompt = data.get('prompt')
    api_key = get_settings_dict().get('openai', {}).get('api_key', None)

    if api_key is None:
        return jsonify({"error": "OpenAI API key not set"}), 400

    ai_context = f"""
    You are helping a python developer write ea FrameOS application. You are editing frame.py, the main file in FrameOS.
    This controls an e-ink display and runs on a Raspberry Pi. Help the user with their changes. 

    This is what we inherit from:
    ```python
    class FrameConfig:
        status: str
        version: str
        width: int
        height: int
        device: str
        color: str
        interval: float
        scaling_mode: str
        background_color: str
        rotate: int
        scenes: List[FrameConfigScene]
        settings: Dict
    class ExecutionContext:
        event: str
        payload: Dict
        image: Optional[Image]
        state: Dict
        apps_ran: List[str]
        apps_errored: List[str]
    class App:
        def __post_init__(self):
        def rerender(self, trigger = None):
        def is_rendering(self):
        def break_execution(self, message: Optional[str] = None):
        def log(self, message: str):
        def error(self, message: str):
        def get_config(self, key: str, default = None):
        def get_setting(self, key: Union[str, List[str]], default = None):
        def parse_str(self, text: str, state: Dict):
        def dispatch(self, event: str, payload: Optional[Dict] = None, image: Optional[Image] = None) -> ExecutionContext:
        def shell(self, command: str):
        def apt(self, package: str):
        def run(self, payload: ExecutionContext):
            # code goes here, does not need to call super
    ```

    From image_utils you can import:
    scale_image(image: Image.Image, requested_width: int, requested_height: int, scaling_mode: 'cover' | 'contain' | 'center' | 'stretch', background_color: str) -> image.Image
    draw_text_with_border(draw, position, text, font, font_color, border_color, border_width=1, align='left'):

    Pip packages can be installed with code like self.shell("pip3 install selenium==4.14.0") in __post_init__().

    Currently available:  bidict==0.22.1 certifi==2023.7.22 charset-normalizer==3.2.0 click==8.1.6 dacite==1.8.1 evdev==1.6.1 flask==2.2.5 flask-socketio==5.3.4 idna==3.4 importlib-metadata==6.7.0 inky==1.5.0 itsdangerous==2.1.2 jinja2==3.1.2 markupsafe==2.1.3 numpy==1.26.1 pillow==9.5.0 psutil==5.9.6 python-engineio==4.5.1 python-socketio==5.8.0 requests==2.31.0 rpi-gpio==0.7.1 smbus2==0.4.2 spidev==3.6 urllib3==2.0.4 werkzeug==2.2.3 zipp==3.15.0 

    This is the current source of frame.py:
    ```python
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


def validate_json(source):
    try:
        json.loads(source)
        return []
    except json.JSONDecodeError as e:
        return [{"line": e.lineno, "column": e.colno, "error": str(e)}]
