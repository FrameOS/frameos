import base64
import io
import zipfile
import json
import string

import httpx
from fastapi import Depends, Request, UploadFile
from fastapi.responses import JSONResponse, Response, StreamingResponse
from sqlalchemy.orm import Session
from PIL import Image

from app.database import get_db
from app.redis import redis
from app.models.template import Template
from app.models.frame import Frame

from . import api

def respond_with_template(template: Template):
    if not template:
        return JSONResponse(content={"error": "Template not found"}, status_code=404)

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
    return Response(in_memory.getvalue(), media_type='application/zip',
                    headers={"Content-Disposition": f"attachment; filename={template_name}.zip"})


@api.post("/templates")
async def create_template(request: Request, db: Session = Depends(get_db)):
    # Attempt to handle file from form-data
    form = await request.form()
    file_upload = form.get('file')
    data = {}
    zip_file = None

    # If we got a file from the form
    if file_upload and isinstance(file_upload, UploadFile):
        file_bytes = await file_upload.read()
        zip_file = zipfile.ZipFile(io.BytesIO(file_bytes))
    else:
        # If not form file, check JSON body
        try:
            data = await request.json()
        except Exception:
            data = {}

        url = data.get('url')
        if url:
            # Fetch zip from URL
            async with httpx.AsyncClient() as client:
                resp = await client.get(url)
            resp.raise_for_status()
            zip_file = zipfile.ZipFile(io.BytesIO(resp.content))

    # If we have a zip_file
    if zip_file:
        folder_name = ''
        for name in zip_file.namelist():
            if name == 'template.json':
                folder_name = ''
                break
            elif name.endswith('/template.json'):
                # Find the shortest matching folder_name if multiple
                if folder_name == '' or len(name) < len(folder_name):
                    folder_name = name[:-len('template.json')]

        template_json = zip_file.read(f'{folder_name}template.json')
        scenes_json = zip_file.read(f'{folder_name}scenes.json')

        data = json.loads(template_json)
        data['scenes'] = json.loads(scenes_json)

        image = data.get('image', '')
        if isinstance(image, str):
            if image.startswith('data:image/'):
                # base64 embedded image
                image = image[len('data:image/'):]
                _, b64data = image.split(';base64,', 1)
                image = base64.b64decode(b64data)
            elif image.startswith('./'):
                image_path = image[len('./'):]
                image = zip_file.read(f'{folder_name}{image_path}')
            elif image.startswith('http:') or image.startswith('https:'):
                async with httpx.AsyncClient() as client:
                    resp = await client.get(image)
                resp.raise_for_status()
                image = resp.content
            else:
                image = None

        data['image'] = image
        if image:
            img = Image.open(io.BytesIO(image))
            data['imageWidth'] = img.width
            data['imageHeight'] = img.height

    if data.get('from_frame_id'):
        frame_id = data.get('from_frame_id')
        frame = db.query(Frame).get(frame_id)
        if frame:
            cache_key = f'frame:{frame.frame_host}:{frame.frame_port}:image'
            last_image = await redis.get(cache_key)
            if last_image:
                try:
                    image = Image.open(io.BytesIO(last_image))
                    data['image'] = last_image
                    data['imageWidth'] = image.width
                    data['imageHeight'] = image.height
                except Exception as e:
                    print(e)

    new_template = Template(
        name=data.get('name'),
        description=data.get('description'),
        scenes=data.get('scenes'),
        config=data.get('config'),
        image=data.get('image'),
        image_width=data.get('imageWidth', data.get('image_width')),
        image_height=data.get('imageHeight', data.get('image_height')),
    )

    format_type = data.get('format')
    if format_type == 'zip':
        return respond_with_template(new_template)
    elif format_type == 'scenes':
        return JSONResponse(content=new_template.scenes, status_code=201)
    else:
        db.add(new_template)
        db.commit()
        return JSONResponse(content=new_template.to_dict(), status_code=201)


@api.get("/templates")
async def get_templates(db: Session = Depends(get_db)):
    templates = [template.to_dict() for template in db.query(Template).all()]
    return JSONResponse(content=templates, status_code=200)


@api.get("/templates/{template_id}/image")
async def get_template_image(template_id: int, db: Session = Depends(get_db)):
    template = db.query(Template).get(template_id)
    if not template or not template.image:
        return JSONResponse(content={"error": "Template not found"}, status_code=404)
    return StreamingResponse(io.BytesIO(template.image), media_type='image/jpeg')


@api.get("/templates/{template_id}/export")
async def export_template(template_id: int, db: Session = Depends(get_db)):
    template = db.query(Template).get(template_id)
    return respond_with_template(template)


@api.get("/templates/{template_id}")
async def get_template(template_id: int, db: Session = Depends(get_db)):
    template = db.query(Template).get(template_id)
    if not template:
        return JSONResponse(content={"error": "Template not found"}, status_code=404)
    return JSONResponse(content=template.to_dict(), status_code=200)


@api.patch("/templates/{template_id}")
async def update_template(template_id: int, request: Request, db: Session = Depends(get_db)):
    template = db.query(Template).get(template_id)
    if not template:
        return JSONResponse(content={"error": "Template not found"}, status_code=404)
    data = await request.json()
    if 'name' in data:
        template.name = data.get('name', template.name)
    if 'description' in data:
        template.description = data.get('description', template.description)
    db.commit()
    return JSONResponse(content=template.to_dict(), status_code=200)


@api.delete("/templates/{template_id}")
async def delete_template(template_id: int, db: Session = Depends(get_db)):
    template = db.query(Template).get(template_id)
    if not template:
        return JSONResponse(content={"error": "Template not found"}, status_code=404)
    db.delete(template)
    db.commit()
    return JSONResponse(content={"message": "Template deleted successfully"}, status_code=200)
