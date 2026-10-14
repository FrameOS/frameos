import ast
import re
import json
import tempfile
import os
import asyncio
import contextlib
from fastapi import Depends, HTTPException
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.apps import get_app_configs, get_one_app_sources
from app.utils.js_apps import validate_js_source
from app.utils.repo_apps import REPO_APP_PREFIX, repo_app_configs, repo_app_sources
from app.utils.scene_guide_gen import SCENE_GUIDE, SCENE_GUIDE_SECTIONS
from app.schemas.apps import (
 AppsListResponse,
 AppsSourceResponse,
 ValidateSourceRequest,
 ValidateSourceResponse,
)
from . import api_project, api_user

from typing import Optional

@api_project.get("/apps", response_model=AppsListResponse)
async def api_apps_list(include_repo: bool = False, db: Session = Depends(get_db)):
    # include_repo adds the JS app templates (repo/apps/<folder>/<name>) for the MCP
    # and the AI; the editor lists those from its own bundle.
    apps = get_app_configs()
    if include_repo:
        apps = {**apps, **repo_app_configs()}
    return {"apps": apps}


@api_project.get("/apps/source", response_model=AppsSourceResponse)
async def api_apps_source(keyword: Optional[str] = None, db: Session = Depends(get_db)):
    if keyword and keyword.startswith(REPO_APP_PREFIX):
        sources = repo_app_sources(keyword)
    else:
        sources = get_one_app_sources(keyword)
    if not sources:
        raise HTTPException(status_code=404, detail="App sources not found")
    return sources


@api_user.get("/scene_guide")
async def api_scene_guide(section: Optional[str] = None):
    """How to write a scene (docs/scene-guide.md, the same text the cloud
    serves): the whole guide, or one `## ` section by its id."""
    sections = [{"id": entry["id"], "title": entry["title"]} for entry in SCENE_GUIDE_SECTIONS]
    if not section:
        return {"guide": SCENE_GUIDE, "sections": sections}
    for entry in SCENE_GUIDE_SECTIONS:
        if entry["id"] == section:
            return {"guide": entry["text"], "sections": sections}
    raise HTTPException(
        status_code=404,
        detail=f"No section {section!r}; the sections are " + ", ".join(entry["id"] for entry in sections),
    )


@api_project.post("/apps/validate_source", response_model=ValidateSourceResponse)
async def validate_python_frame_source(data: ValidateSourceRequest):
    file = data.file
    source = data.source

    if file.endswith('.py'):
        errors = validate_python(source)
    elif file.endswith(('.js', '.ts', '.jsx', '.tsx')):
        # A 30 s subprocess, and on a cold cache a Nim build of the checker
        # under a lock: off the event loop.
        errors = await asyncio.to_thread(validate_js_source, file, source)
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


def validate_python(source: str):
    try:
        ast.parse(source)
        return []
    except SyntaxError as e:
        return [{"line": e.lineno, "column": e.offset, "error": str(e)}]


# `nim check` of one app file; the first run also compiles the stdlib cache.
NIM_CHECK_TIMEOUT_SECONDS = 120


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

        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=NIM_CHECK_TIMEOUT_SECONDS)
        except asyncio.TimeoutError:
            with contextlib.suppress(ProcessLookupError):
                proc.kill()
            with contextlib.suppress(Exception):
                await proc.wait()
            return [{"line": 1, "column": 1, "error": f"nim check timed out after {NIM_CHECK_TIMEOUT_SECONDS} s"}]
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
