import ast
import re
import json
import tempfile
import os
import asyncio
import httpx
from fastapi import Depends, HTTPException
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.apps import get_app_configs, get_one_app_sources
from app.models.settings import get_settings_dict
from app.schemas.apps import (
 AppsListResponse,
 AppsSourceResponse,
 ValidateSourceRequest,
 ValidateSourceResponse,
 EnhanceSourceRequest,
 EnhanceSourceResponse
)
from . import api_with_auth

from typing import Optional

@api_with_auth.get("/apps", response_model=AppsListResponse)
async def api_apps_list(db: Session = Depends(get_db)):
    return {"apps": get_app_configs()}


@api_with_auth.get("/apps/source", response_model=AppsSourceResponse)
async def api_apps_source(keyword: Optional[str] = None, db: Session = Depends(get_db)):
    sources = get_one_app_sources(keyword)
    if sources is None:
        raise HTTPException(status_code=404, detail="App sources not found")
    return sources


@api_with_auth.post("/apps/validate_source", response_model=ValidateSourceResponse)
async def validate_python_frame_source(data: ValidateSourceRequest):
    file = data.file
    source = data.source

    if file.endswith('.py'):
        errors = validate_python(source)
    elif file.endswith('.nim'):
        errors = await validate_nim(source)
    elif file.endswith('.json'):
        errors = validate_json(source)
    else:
        raise HTTPException(
            status_code=400,
            detail=f"Don't know how to validate files of this extension: {file}"
        )

    return {"errors": errors}


@api_with_auth.post("/apps/enhance_source", response_model=EnhanceSourceResponse)
async def enhance_python_frame_source(data: EnhanceSourceRequest, db: Session = Depends(get_db)):
    source = data.source
    prompt = data.prompt
    openai_settings = get_settings_dict(db).get("openAI", {})
    api_key = openai_settings.get("apiKey")

    if api_key is None:
        raise HTTPException(status_code=400, detail="OpenAI API key not set")

    ai_context = f"""
    You are helping a python developer write a FrameOS application. You are editing app.nim, the main file in FrameOS.
    This controls an e-ink display and runs on a Raspberry Pi. Help the user with their changes.

    This is the current source of app.nim:
    ```nim
    {source}
    ```
    """

    payload = {
        "messages": [
            {"role": "system", "content": ai_context},
            {"role": "user", "content": prompt}
        ],
        "model": openai_settings.get("appEnhanceModel") or "gpt-5.2",
    }

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }

    async with httpx.AsyncClient() as client:
        response = await client.post("https://api.openai.com/v1/chat/completions", json=payload, headers=headers)
        result = response.json()

    error = result.get('error')
    suggestion = result['choices'][0]['message']['content'] if 'choices' in result else None

    if error:
        raise HTTPException(status_code=500, detail=str(error))

    return {"suggestion": suggestion}


def validate_python(source: str):
    try:
        ast.parse(source)
        return []
    except SyntaxError as e:
        return [{"line": e.lineno, "column": e.offset, "error": str(e)}]


async def validate_nim(source: str):
    temp_file_name = ''
    try:
        os.makedirs("../frameos/src/codegen", exist_ok=True)
        temp_file = tempfile.NamedTemporaryFile(mode='w', suffix='.nim', dir="../frameos/src/codegen", delete=False)
        temp_file_name = temp_file.name
        temp_file_abs_name = os.path.realpath(temp_file_name)
        temp_file.write(source)
        temp_file.close()

        proc = await asyncio.create_subprocess_exec(
            'nim', 'check', temp_file_name,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        stdout, stderr = await proc.communicate()
        stdout = stdout.decode('utf-8', errors='replace')
        stderr = stderr.decode('utf-8', errors='replace')

        errors = []
        for line in stderr.split('\n'):
            if line.startswith(temp_file_name) or line.startswith(temp_file_abs_name):
                if line.startswith(temp_file_name):
                    line = line[len(temp_file_name):]
                elif line.startswith(temp_file_abs_name):
                    line = line[len(temp_file_abs_name):]

                if "Error:" in line:
                    match = re.search(r'\((\d+), (\d+)\) (Error: .+)', line)
                    if match:
                        line_no, column, error_msg = int(match.group(1)), int(match.group(2)), match.group(3)
                        errors.append({"line": line_no, "column": column, "error": error_msg})
        return errors

    except Exception as e:
        return [{"line": 1, "column": 1, "error": str(e)}]
    finally:
        if temp_file_name and os.path.exists(temp_file_name):
            os.remove(temp_file_name)


def validate_json(source: str):
    try:
        json.loads(source)
        return []
    except json.JSONDecodeError as e:
        return [{"line": e.lineno, "column": e.colno, "error": str(e)}]
