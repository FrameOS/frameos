import base64
import io
import zipfile
import json
import string
from datetime import datetime, timedelta

import httpx
from PIL import Image
from fastapi import Depends, HTTPException, UploadFile, File, Form, Request
from fastapi.responses import Response, StreamingResponse
from jose import jwt, JWTError
from sqlalchemy.orm import Session

from app.database import get_db
from app.redis import redis
from app.models.template import Template
from app.models.frame import Frame
from app.schemas.templates import (
    TemplateResponse, TemplatesListResponse, CreateTemplateRequest, UpdateTemplateRequest
)
from app.api.auth import SECRET_KEY, ALGORITHM
from app.api import private_api, public_api


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


@private_api.post("/templates")
async def create_template(
    db: Session = Depends(get_db),
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
    imageHeight: int = Form(None)
):
    # We combine both form-data and JSON scenarios into one endpoint:
    # If file is provided, we treat it as a zip upload.
    # If not, we rely on URL or direct JSON form fields.

    data = {
        "from_frame_id": from_frame_id,
        "url": url,
        "format": format,
        "name": name,
        "description": description,
        "scenes": json.loads(scenes) if scenes else None,
        "config": json.loads(config) if config else None,
        "image": image,
        "imageWidth": imageWidth,
        "imageHeight": imageHeight
    }

    zip_file = None
    # If we got a file from the form
    if file and file.filename:
        file_bytes = await file.read()
        zip_file = zipfile.ZipFile(io.BytesIO(file_bytes))
    elif url:
        # Fetch zip from URL
        async with httpx.AsyncClient() as client:
            resp = await client.get(url)
        resp.raise_for_status()
        zip_file = zipfile.ZipFile(io.BytesIO(resp.content))

    # If we have a zip_file, parse template.json and scenes.json
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
        # Merge parsed_data into data if not provided
        for k, v in parsed_data.items():
            if data.get(k) is None:
                data[k] = v

        # Handle image
        img_val = data.get('image', '')
        if isinstance(img_val, str):
            if img_val.startswith('data:image/'):
                # base64 embedded image
                img_val = img_val[len('data:image/'):]
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
        frame = db.query(Frame).get(frame_id)
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

    # Validate the incoming data using CreateTemplateRequest
    create_req = CreateTemplateRequest(**data)

    new_template = Template(
        name=create_req.name,
        description=create_req.description,
        scenes=create_req.scenes,
        config=create_req.config,
        image=create_req.image,
        image_width=create_req.imageWidth,
        image_height=create_req.imageHeight,
    )

    format_type = create_req.format
    if format_type == 'zip':
        # Return zip response directly
        return respond_with_template(new_template)
    elif format_type == 'scenes':
        return new_template.scenes or []

    db.add(new_template)
    db.commit()
    db.refresh(new_template)
    return new_template.to_dict()


@private_api.get("/templates", response_model=TemplatesListResponse)
async def get_templates(db: Session = Depends(get_db)):
    templates = db.query(Template).all()
    result = []
    for t in templates:
        d = t.to_dict()
        _update_image(d)
        result.append(d)
    return result


@public_api.get("/templates/{template_id}/image")
async def get_template_image(template_id: str, token: str, request: Request, db: Session = Depends(get_db)):
    # Validate token
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        if payload.get("sub") != f"t:{template_id}":
            raise HTTPException(status_code=401, detail="Unauthorized")
    except JWTError:
        raise HTTPException(status_code=401, detail="Unauthorized")

    template = db.query(Template).get(template_id)
    if not template or not template.image:
        raise HTTPException(status_code=404, detail="Template not found")
    return StreamingResponse(io.BytesIO(template.image), media_type='image/jpeg')


@private_api.get("/templates/{template_id}/export")
async def export_template(template_id: int, db: Session = Depends(get_db)):
    template = db.query(Template).get(template_id)
    return respond_with_template(template)


@private_api.get("/templates/{template_id}", response_model=TemplateResponse)
async def get_template(template_id: int, db: Session = Depends(get_db)):
    template = db.query(Template).get(template_id)
    if not template:
        raise HTTPException(status_code=404, detail="Template not found")
    d = template.to_dict()
    _update_image(d)
    return d


@private_api.patch("/templates/{template_id}", response_model=TemplateResponse)
async def update_template(template_id: int, data: UpdateTemplateRequest, db: Session = Depends(get_db)):
    template = db.query(Template).get(template_id)
    if not template:
        raise HTTPException(status_code=404, detail="Template not found")

    if data.name is not None:
        template.name = data.name
    if data.description is not None:
        template.description = data.description
    db.commit()
    db.refresh(template)

    d = template.to_dict()
    _update_image(d)
    return d


@private_api.delete("/templates/{template_id}")
async def delete_template(template_id: int, db: Session = Depends(get_db)):
    template = db.query(Template).get(template_id)
    if not template:
        raise HTTPException(status_code=404, detail="Template not found")
    db.delete(template)
    db.commit()
    return {"message": "Template deleted successfully"}


def _update_image(d):
    d['id'] = str(d['id'])
    if d['image']:
        expire_minutes = 5
        now = datetime.utcnow()
        expire = now + timedelta(minutes=expire_minutes)
        to_encode = {"sub": f"t:{d['id']}", "exp": expire}
        token = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
        d['image'] = f'{d["image"]}?token={token}'
