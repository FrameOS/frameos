import base64
import io
import zipfile
import json
import string

import httpx
from PIL import Image
from fastapi import Depends, HTTPException, UploadFile, File, Form, Request
from fastapi.responses import Response, StreamingResponse, JSONResponse
from sqlalchemy.orm import Session

from app.database import get_db
from app.config import config
from arq import ArqRedis as Redis
from app.models.template import Template
from app.models.frame import Frame
from app.schemas.templates import (
    TemplateImageTokenResponse,
    TemplateResponse,
    TemplatesListResponse,
    CreateTemplateRequest,
    UpdateTemplateRequest,
)
from app.api import api_with_auth, api_no_auth
from app.redis import get_redis
from app.utils.jwt_tokens import create_scoped_token_response, validate_scoped_token
from app.api.auth import get_current_user_from_request


def respond_with_template(template: Template):
    if not template:
        raise HTTPException(status_code=404, detail="Template not found")

    template_name = template.name or 'Template'
    safe_chars = "-_.() %s%s" % (string.ascii_letters, string.digits)
    template_name = ''.join(c if c in safe_chars else ' ' for c in template_name).strip()
    template_name = ' '.join(template_name.split()) or 'Template'

    template_dict = template.to_dict()
    template_dict.pop('id', None)
    in_memory = io.BytesIO()
    with zipfile.ZipFile(in_memory, 'a', zipfile.ZIP_DEFLATED) as zf:
        scenes = template_dict.pop('scenes', [])
        template_dict['scenes'] = './scenes.json'
        template_dict['image'] = './image.jpg'
        zf.writestr(f"{template_name}/scenes.json", json.dumps(scenes, indent=2))
        zf.writestr(f"{template_name}/template.json", json.dumps(template_dict, indent=2))
        if template.image:
            zf.writestr(f"{template_name}/image.jpg", template.image)
    in_memory.seek(0)
    return Response(
        in_memory.getvalue(),
        media_type='application/zip',
        headers={"Content-Disposition": f"attachment; filename={template_name}.zip"}
    )


@api_with_auth.post("/templates", status_code=201)
async def create_template(
    request: Request,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
    file: UploadFile = File(None),
    url: str = Form(None),
    from_frame_id: int = Form(None),
    format: str = Form(None),
    name: str = Form(None),
    description: str = Form(None),
    scenes: str = Form(None),
    config: str = Form(None),
    image: str = Form(None),
    imageWidth: int = Form(None),
    imageHeight: int = Form(None),
):
    """
    Create a template. Supports:
      - multipart/form-data with file upload
      - multipart/form-data with "url"
      - raw JSON body (application/json) containing name, scenes, etc.
      - merges old Flask logic that handled either request.files['file'] or request.json['url'] etc.
    """
    # Attempt to parse any JSON body if the Content-Type is application/json
    try:
        parsed_json = await request.json()
    except:
        parsed_json = {}

    # Merge JSON fields if form fields are None
    url = url or parsed_json.get('url')
    format = format or parsed_json.get('format')
    name = name or parsed_json.get('name')
    description = description or parsed_json.get('description')
    from_frame_id = from_frame_id or parsed_json.get('from_frame_id')

    # Scenes/config might come as JSON arrays or as strings
    if not scenes and parsed_json.get('scenes') is not None:
        scenes = json.dumps(parsed_json.get('scenes'))
    if not config and parsed_json.get('config') is not None:
        config = json.dumps(parsed_json.get('config'))

    # Convert them from JSON string -> Python object
    scenes = json.loads(scenes) if scenes else None
    config = json.loads(config) if config else None

    # If image is not in form, use JSON
    if not image and parsed_json.get('image'):
        image = parsed_json.get('image')

    imageWidth = imageWidth or parsed_json.get('imageWidth') or parsed_json.get('image_width')
    imageHeight = imageHeight or parsed_json.get('imageHeight') or parsed_json.get('image_height')

    zip_file = None
    # If file was uploaded via form
    if file and file.filename:
        file_bytes = await file.read()
        zip_file = zipfile.ZipFile(io.BytesIO(file_bytes))
    elif url:
        # If we have a URL, fetch it
        async with httpx.AsyncClient() as client:
            resp = await client.get(url)
        resp.raise_for_status()
        zip_file = zipfile.ZipFile(io.BytesIO(resp.content))

    data = {
        "from_frame_id": from_frame_id,
        "name": name,
        "description": description,
        "scenes": scenes,
        "config": config,
        "format": format,
        "image": image,
        "imageWidth": imageWidth,
        "imageHeight": imageHeight,
    }

    # If we have a zip file, parse template.json and scenes.json
    if zip_file:
        folder_name = ''
        for name_in_zip in zip_file.namelist():
            if name_in_zip == 'template.json':
                folder_name = ''
                break
            elif name_in_zip.endswith('/template.json'):
                if folder_name == '' or len(name_in_zip) < len(folder_name):
                    folder_name = name_in_zip[:-len('template.json')]

        template_json = zip_file.read(f'{folder_name}template.json')
        scenes_json = zip_file.read(f'{folder_name}scenes.json')

        parsed_data = json.loads(template_json)
        parsed_data['scenes'] = json.loads(scenes_json)

        # Merge into data if not already provided
        for k, v in parsed_data.items():
            if data.get(k) is None:
                data[k] = v

        # If there's an image
        img_val = data.get('image', '')
        if isinstance(img_val, str):
            if img_val.startswith('data:image/'):
                _, b64data = img_val.split(';base64,', 1)
                img_val = base64.b64decode(b64data)
            elif img_val.startswith('./'):
                image_path = img_val[len('./'):]
                img_val = zip_file.read(f'{folder_name}{image_path}')
            elif img_val.startswith('http:') or img_val.startswith('https:'):
                async with httpx.AsyncClient() as client:
                    resp = await client.get(img_val)
                resp.raise_for_status()
                img_val = resp.content
            else:
                img_val = None
            data['image'] = img_val
            if img_val:
                img_obj = Image.open(io.BytesIO(img_val))
                data['imageWidth'] = img_obj.width
                data['imageHeight'] = img_obj.height

    # If from_frame_id is provided, attempt to fetch image from frame cache
    if data.get('from_frame_id'):
        frame_id = data['from_frame_id']
        frame = db.get(Frame, frame_id)
        if frame:
            cache_key = f'frame:{frame.frame_host}:{frame.frame_port}:image'
            last_image = await redis.get(cache_key)
            if last_image:
                try:
                    img_obj = Image.open(io.BytesIO(last_image))
                    data['image'] = last_image
                    data['imageWidth'] = img_obj.width
                    data['imageHeight'] = img_obj.height
                except Exception:
                    pass

    # Now validate data with the updated Pydantic model
    create_req = CreateTemplateRequest(**data)

    new_template = Template(
        name=create_req.name,
        description=create_req.description,
        scenes=create_req.scenes,
        config=create_req.config,
        image=create_req.image if isinstance(create_req.image, bytes) else create_req.image,
        image_width=create_req.imageWidth,
        image_height=create_req.imageHeight,
    )

    # If user requested an immediate response format
    if create_req.format == 'zip':
        return respond_with_template(new_template)
    elif create_req.format == 'scenes':
        return JSONResponse(content=new_template.scenes or [], status_code=201)

    # Otherwise, persist it in DB
    db.add(new_template)
    db.commit()
    db.refresh(new_template)
    return new_template.to_dict()


@api_with_auth.get("/templates", response_model=TemplatesListResponse)
async def get_templates(db: Session = Depends(get_db)):
    templates = db.query(Template).all()
    result = []
    for t in templates:
        d = t.to_dict()
        result.append(d)
    return result


@api_with_auth.get("/templates/{template_id}", response_model=TemplateResponse)
async def get_template(template_id: str, db: Session = Depends(get_db)):
    template = db.get(Template, template_id)
    if not template:
        raise HTTPException(status_code=404, detail="Template not found")
    d = template.to_dict()
    return d

@api_with_auth.get("/templates/{template_id}/image_token", response_model=TemplateImageTokenResponse)
async def get_image_token(template_id: str):
    return create_scoped_token_response(f"template={template_id}")

@api_no_auth.get("/templates/{template_id}/image")
async def get_template_image(template_id: str, request: Request, token: str | None = None, db: Session = Depends(get_db)):
    if config.HASSIO_RUN_MODE != 'ingress':
        # All modes except ingress require a token in the url or authenticated session
        if await get_current_user_from_request(request, db):
            pass
        else:
            validate_scoped_token(token, expected_subject=f"template={template_id}")

    template = db.get(Template, template_id)
    if not template or not template.image:
        raise HTTPException(status_code=404, detail="Template not found")

    return StreamingResponse(io.BytesIO(template.image), media_type='image/jpeg')


@api_with_auth.get("/templates/{template_id}/export")
async def export_template(template_id: str, db: Session = Depends(get_db)):
    template = db.get(Template, template_id)
    return respond_with_template(template)


@api_with_auth.patch("/templates/{template_id}", response_model=TemplateResponse)
async def update_template(template_id: str, data: UpdateTemplateRequest, db: Session = Depends(get_db)):
    template = db.get(Template, template_id)
    if not template:
        raise HTTPException(status_code=404, detail="Template not found")

    if data.name is not None:
        template.name = data.name
    if data.description is not None:
        template.description = data.description
    db.commit()
    db.refresh(template)

    d = template.to_dict()
    return d


@api_with_auth.delete("/templates/{template_id}")
async def delete_template(template_id: str, db: Session = Depends(get_db)):
    template = db.get(Template, template_id)
    if not template:
        raise HTTPException(status_code=404, detail="Template not found")
    db.delete(template)
    db.commit()
    return {"message": "Template deleted successfully"}
